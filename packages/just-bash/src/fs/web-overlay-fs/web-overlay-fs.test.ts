import { beforeEach, describe, expect, it } from "vitest";
import { createMockWebFsRoot } from "../web-fs/web-fs-mock.js";
import { WebFs } from "../web-fs/web-fs.js";
import { WebOverlayFs } from "./web-overlay-fs.js";

/**
 * Seed the mock handle by writing through WebFs first, then mount that same
 * root under WebOverlayFs. This gives us a realistic shared backing store
 * without needing a real browser.
 */
async function seededOverlay({
  seed,
  mountPoint,
  readOnly,
}: {
  seed?: Record<string, string>;
  mountPoint?: string;
  readOnly?: boolean;
} = {}): Promise<WebOverlayFs> {
  const root = createMockWebFsRoot();
  if (seed) {
    const seeder = new WebFs({ root });
    for (const [path, content] of Object.entries(seed)) {
      await seeder.writeFile(path, content);
    }
  }
  return new WebOverlayFs({ root, mountPoint, readOnly });
}

describe("WebOverlayFs", () => {
  describe("default mount point /home/user/project", () => {
    let fs: WebOverlayFs;

    beforeEach(async () => {
      fs = await seededOverlay({ seed: { "/file.txt": "from handle" } });
    });

    it("creates the mount-point directory chain", async () => {
      expect((await fs.stat("/home")).isDirectory).toBe(true);
      expect((await fs.stat("/home/user")).isDirectory).toBe(true);
      expect((await fs.stat("/home/user/project")).isDirectory).toBe(true);
    });

    it("reads handle-backed files at the mounted path", async () => {
      expect(await fs.readFile("/home/user/project/file.txt")).toBe("from handle");
    });

    it("paths outside the mount point have no handle content", async () => {
      // /file.txt was written to the handle root, but with mount=/home/user/project
      // we expose it at /home/user/project/file.txt. /file.txt should not exist.
      await expect(fs.readFile("/file.txt")).rejects.toThrow("ENOENT");
    });

    it("returns the mount point", () => {
      expect(fs.getMountPoint()).toBe("/home/user/project");
    });
  });

  describe("mountPoint: /", () => {
    let fs: WebOverlayFs;

    beforeEach(async () => {
      fs = await seededOverlay({
        mountPoint: "/",
        seed: {
          "/a.txt": "alpha",
          "/sub/b.txt": "beta",
        },
      });
    });

    it("reads handle-backed files at the virtual root", async () => {
      expect(await fs.readFile("/a.txt")).toBe("alpha");
      expect(await fs.readFile("/sub/b.txt")).toBe("beta");
    });

    it("writes go to memory, backing handle unchanged", async () => {
      await fs.writeFile("/a.txt", "modified");
      expect(await fs.readFile("/a.txt")).toBe("modified");

      // Re-mount fresh and confirm the backing handle still has original content
      const fresh = new WebOverlayFs({
        root: (fs as unknown as { root: FileSystemDirectoryHandle }).root,
        mountPoint: "/",
      });
      expect(await fresh.readFile("/a.txt")).toBe("alpha");
    });

    it("writes new files that aren't on the backing handle", async () => {
      await fs.writeFile("/new.txt", "fresh");
      expect(await fs.readFile("/new.txt")).toBe("fresh");
    });

    it("rm hides a handle-backed file via tombstone", async () => {
      await fs.rm("/a.txt");
      await expect(fs.readFile("/a.txt")).rejects.toThrow("ENOENT");
      expect(await fs.exists("/a.txt")).toBe(false);
    });

    it("rm + write creates a fresh file at a previously-tombstoned path", async () => {
      await fs.rm("/a.txt");
      await fs.writeFile("/a.txt", "rewritten");
      expect(await fs.readFile("/a.txt")).toBe("rewritten");
    });

    it("readdir merges memory and handle entries, applying tombstones", async () => {
      await fs.writeFile("/c.txt", "gamma");
      await fs.rm("/sub/b.txt");
      const entries = await fs.readdir("/");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("c.txt");
      expect(entries).toContain("sub");

      const subEntries = await fs.readdir("/sub");
      expect(subEntries).not.toContain("b.txt");
    });

    it("recursive rm tombstones a whole handle subtree", async () => {
      await fs.rm("/sub", { recursive: true });
      await expect(fs.readFile("/sub/b.txt")).rejects.toThrow("ENOENT");
      await expect(fs.readdir("/sub")).rejects.toThrow("ENOENT");
    });

    it("cp from handle source to new dest writes to memory", async () => {
      await fs.cp("/a.txt", "/copy.txt");
      expect(await fs.readFile("/copy.txt")).toBe("alpha");
      // backing handle unchanged
      const fresh = new WebOverlayFs({
        root: (fs as unknown as { root: FileSystemDirectoryHandle }).root,
        mountPoint: "/",
      });
      await expect(fresh.readFile("/copy.txt")).rejects.toThrow("ENOENT");
    });

    it("recursive cp copies a handle dir into memory", async () => {
      await fs.cp("/sub", "/sub-copy", { recursive: true });
      expect(await fs.readFile("/sub-copy/b.txt")).toBe("beta");
    });

    it("mv across paths is cp+rm", async () => {
      await fs.mv("/a.txt", "/renamed.txt");
      expect(await fs.readFile("/renamed.txt")).toBe("alpha");
      await expect(fs.readFile("/a.txt")).rejects.toThrow("ENOENT");
    });

    it("EISDIR copying a directory non-recursively", async () => {
      await expect(fs.cp("/sub", "/sub2")).rejects.toThrow("EISDIR");
    });

    it("ENOTEMPTY on rm of populated dir without recursive", async () => {
      await expect(fs.rm("/sub")).rejects.toThrow("ENOTEMPTY");
    });

    it("appendFile concatenates onto handle-backed content", async () => {
      await fs.appendFile("/a.txt", "+suffix");
      expect(await fs.readFile("/a.txt")).toBe("alpha+suffix");
    });

    it("stat distinguishes handle files and memory dirs", async () => {
      await fs.mkdir("/mem-dir");
      expect((await fs.stat("/mem-dir")).isDirectory).toBe(true);
      expect((await fs.stat("/a.txt")).isFile).toBe(true);
    });

    it("mkdir EEXIST on existing handle directory", async () => {
      await expect(fs.mkdir("/sub")).rejects.toThrow("EEXIST");
    });

    it("mkdir recursive on existing dir is silent", async () => {
      await expect(
        fs.mkdir("/sub", { recursive: true }),
      ).resolves.toBeUndefined();
    });

    it("readFile EISDIR on a dir", async () => {
      await expect(fs.readFile("/sub")).rejects.toThrow("EISDIR");
    });
  });

  describe("readOnly mode", () => {
    it("rejects all writes with EROFS", async () => {
      const fs = await seededOverlay({
        mountPoint: "/",
        readOnly: true,
        seed: { "/x": "y" },
      });
      await expect(fs.writeFile("/a", "x")).rejects.toThrow("EROFS");
      await expect(fs.appendFile("/a", "x")).rejects.toThrow("EROFS");
      await expect(fs.mkdir("/d")).rejects.toThrow("EROFS");
      await expect(fs.rm("/x")).rejects.toThrow("EROFS");
      // Reads still work
      expect(await fs.readFile("/x")).toBe("y");
    });
  });

  describe("operations unsupported by the handle API", () => {
    let fs: WebOverlayFs;
    beforeEach(async () => {
      fs = await seededOverlay({ mountPoint: "/" });
    });

    it("symlink throws EPERM", async () => {
      await expect(fs.symlink("/a", "/b")).rejects.toThrow("EPERM");
    });
    it("link throws EPERM", async () => {
      await expect(fs.link("/a", "/b")).rejects.toThrow("EPERM");
    });
    it("readlink throws EINVAL", async () => {
      await expect(fs.readlink("/a")).rejects.toThrow("EINVAL");
    });
    it("chmod is a no-op", async () => {
      await fs.writeFile("/x", "y");
      await expect(fs.chmod("/x", 0o644)).resolves.toBeUndefined();
    });
    it("utimes is a no-op", async () => {
      await fs.writeFile("/x", "y");
      await expect(
        fs.utimes("/x", new Date(), new Date()),
      ).resolves.toBeUndefined();
    });
  });

  describe("realpath / resolvePath / getAllPaths", () => {
    it("realpath returns normalized virtual path for existing entries", async () => {
      const fs = await seededOverlay({
        mountPoint: "/",
        seed: { "/a/b.txt": "x" },
      });
      expect(await fs.realpath("/a/./b.txt")).toBe("/a/b.txt");
    });

    it("realpath ENOENT for missing path", async () => {
      const fs = await seededOverlay({ mountPoint: "/" });
      await expect(fs.realpath("/missing")).rejects.toThrow("ENOENT");
    });

    it("resolvePath resolves relative paths", async () => {
      const fs = await seededOverlay({ mountPoint: "/" });
      expect(fs.resolvePath("/a/b", "../c")).toBe("/a/c");
    });

    it("getAllPaths returns memory entries minus tombstones", async () => {
      const fs = await seededOverlay({
        mountPoint: "/",
        seed: { "/seed.txt": "x" },
      });
      await fs.writeFile("/mem.txt", "y");
      await fs.rm("/seed.txt");
      const all = fs.getAllPaths();
      expect(all).toContain("/mem.txt");
      expect(all).not.toContain("/seed.txt");
    });
  });
});

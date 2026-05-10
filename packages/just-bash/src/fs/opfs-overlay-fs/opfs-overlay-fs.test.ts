import { beforeEach, describe, expect, it } from "vitest";
import { createMockOpfsRoot } from "../opfs-fs/opfs-mock.js";
import { OpfsFs } from "../opfs-fs/opfs-fs.js";
import { OpfsOverlayFs } from "./opfs-overlay-fs.js";

/**
 * Seed the OPFS mock by writing through OpfsFs first, then mount that same
 * OPFS root under OpfsOverlayFs. This gives us a realistic shared backing
 * store without needing a real browser.
 */
async function seededOverlay({
  seed,
  mountPoint,
  readOnly,
}: {
  seed?: Record<string, string>;
  mountPoint?: string;
  readOnly?: boolean;
} = {}): Promise<OpfsOverlayFs> {
  const root = createMockOpfsRoot();
  if (seed) {
    const seeder = new OpfsFs({ root });
    for (const [path, content] of Object.entries(seed)) {
      await seeder.writeFile(path, content);
    }
  }
  return new OpfsOverlayFs({ root, mountPoint, readOnly });
}

describe("OpfsOverlayFs", () => {
  describe("default mount point /home/user/project", () => {
    let fs: OpfsOverlayFs;

    beforeEach(async () => {
      fs = await seededOverlay({ seed: { "/file.txt": "from opfs" } });
    });

    it("creates the mount-point directory chain", async () => {
      expect((await fs.stat("/home")).isDirectory).toBe(true);
      expect((await fs.stat("/home/user")).isDirectory).toBe(true);
      expect((await fs.stat("/home/user/project")).isDirectory).toBe(true);
    });

    it("reads OPFS files at the mounted path", async () => {
      expect(await fs.readFile("/home/user/project/file.txt")).toBe("from opfs");
    });

    it("paths outside the mount point have no OPFS content", async () => {
      // /file.txt was written to OPFS root, but with mount=/home/user/project
      // we expose it at /home/user/project/file.txt. /file.txt should not exist.
      await expect(fs.readFile("/file.txt")).rejects.toThrow("ENOENT");
    });

    it("returns the mount point", () => {
      expect(fs.getMountPoint()).toBe("/home/user/project");
    });
  });

  describe("mountPoint: /", () => {
    let fs: OpfsOverlayFs;

    beforeEach(async () => {
      fs = await seededOverlay({
        mountPoint: "/",
        seed: {
          "/a.txt": "alpha",
          "/sub/b.txt": "beta",
        },
      });
    });

    it("reads OPFS files at the virtual root", async () => {
      expect(await fs.readFile("/a.txt")).toBe("alpha");
      expect(await fs.readFile("/sub/b.txt")).toBe("beta");
    });

    it("writes go to memory, OPFS unchanged", async () => {
      await fs.writeFile("/a.txt", "modified");
      expect(await fs.readFile("/a.txt")).toBe("modified");

      // Re-mount fresh and confirm OPFS still has original content
      const fresh = new OpfsOverlayFs({
        root: (fs as unknown as { root: FileSystemDirectoryHandle }).root,
        mountPoint: "/",
      });
      expect(await fresh.readFile("/a.txt")).toBe("alpha");
    });

    it("writes new files that aren't on OPFS", async () => {
      await fs.writeFile("/new.txt", "fresh");
      expect(await fs.readFile("/new.txt")).toBe("fresh");
    });

    it("rm hides an OPFS file via tombstone", async () => {
      await fs.rm("/a.txt");
      await expect(fs.readFile("/a.txt")).rejects.toThrow("ENOENT");
      expect(await fs.exists("/a.txt")).toBe(false);
    });

    it("rm + write creates a fresh file at a previously-tombstoned path", async () => {
      await fs.rm("/a.txt");
      await fs.writeFile("/a.txt", "rewritten");
      expect(await fs.readFile("/a.txt")).toBe("rewritten");
    });

    it("readdir merges memory and OPFS, applying tombstones", async () => {
      await fs.writeFile("/c.txt", "gamma");
      await fs.rm("/sub/b.txt");
      const entries = await fs.readdir("/");
      expect(entries).toContain("a.txt");
      expect(entries).toContain("c.txt");
      expect(entries).toContain("sub");

      const subEntries = await fs.readdir("/sub");
      expect(subEntries).not.toContain("b.txt");
    });

    it("recursive rm tombstones a whole OPFS subtree", async () => {
      await fs.rm("/sub", { recursive: true });
      await expect(fs.readFile("/sub/b.txt")).rejects.toThrow("ENOENT");
      await expect(fs.readdir("/sub")).rejects.toThrow("ENOENT");
    });

    it("cp from OPFS source to new dest writes to memory", async () => {
      await fs.cp("/a.txt", "/copy.txt");
      expect(await fs.readFile("/copy.txt")).toBe("alpha");
      // OPFS unchanged
      const fresh = new OpfsOverlayFs({
        root: (fs as unknown as { root: FileSystemDirectoryHandle }).root,
        mountPoint: "/",
      });
      await expect(fresh.readFile("/copy.txt")).rejects.toThrow("ENOENT");
    });

    it("recursive cp copies an OPFS dir into memory", async () => {
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

    it("appendFile concatenates onto OPFS-backed content", async () => {
      await fs.appendFile("/a.txt", "+suffix");
      expect(await fs.readFile("/a.txt")).toBe("alpha+suffix");
    });

    it("stat distinguishes OPFS files and memory dirs", async () => {
      await fs.mkdir("/mem-dir");
      expect((await fs.stat("/mem-dir")).isDirectory).toBe(true);
      expect((await fs.stat("/a.txt")).isFile).toBe(true);
    });

    it("mkdir EEXIST on existing OPFS directory", async () => {
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

  describe("OPFS-unsupported ops", () => {
    let fs: OpfsOverlayFs;
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
        seed: { "/opfs.txt": "x" },
      });
      await fs.writeFile("/mem.txt", "y");
      await fs.rm("/opfs.txt");
      const all = fs.getAllPaths();
      expect(all).toContain("/mem.txt");
      expect(all).not.toContain("/opfs.txt");
    });
  });
});

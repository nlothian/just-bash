import { beforeEach, describe, expect, it } from "vitest";
import { WebFs } from "./web-fs.js";
import { createMockWebFsRoot } from "./web-fs-mock.js";

describe("WebFs", () => {
  let fs: WebFs;

  beforeEach(() => {
    fs = new WebFs({ root: createMockWebFsRoot() });
  });

  describe("writeFile / readFile", () => {
    it("writes and reads a file at root", async () => {
      await fs.writeFile("/hello.txt", "world");
      expect(await fs.readFile("/hello.txt")).toBe("world");
    });

    it("creates intermediate directories on write", async () => {
      await fs.writeFile("/a/b/c.txt", "deep");
      expect(await fs.readFile("/a/b/c.txt")).toBe("deep");
      expect((await fs.stat("/a")).isDirectory).toBe(true);
      expect((await fs.stat("/a/b")).isDirectory).toBe(true);
    });

    it("overwrites an existing file (truncates)", async () => {
      await fs.writeFile("/f.txt", "longer original");
      await fs.writeFile("/f.txt", "short");
      expect(await fs.readFile("/f.txt")).toBe("short");
    });

    it("round-trips binary content", async () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128]);
      await fs.writeFile("/b.bin", bytes);
      const out = await fs.readFileBuffer("/b.bin");
      expect(Array.from(out)).toEqual(Array.from(bytes));
    });

    it("readFile throws ENOENT for missing files", async () => {
      await expect(fs.readFile("/missing")).rejects.toThrow("ENOENT");
    });

    it("readFile throws EISDIR on a directory", async () => {
      await fs.mkdir("/dir");
      await expect(fs.readFile("/dir")).rejects.toThrow("EISDIR");
    });

    it("enforces maxFileReadSize", async () => {
      const small = new WebFs({
        root: createMockWebFsRoot(),
        maxFileReadSize: 4,
      });
      await small.writeFile("/big.txt", "abcdef");
      await expect(small.readFile("/big.txt")).rejects.toThrow("EFBIG");
    });
  });

  describe("appendFile", () => {
    it("creates a file when missing", async () => {
      await fs.appendFile("/log.txt", "first ");
      expect(await fs.readFile("/log.txt")).toBe("first ");
    });

    it("appends to an existing file", async () => {
      await fs.writeFile("/log.txt", "one ");
      await fs.appendFile("/log.txt", "two");
      expect(await fs.readFile("/log.txt")).toBe("one two");
    });
  });

  describe("exists / stat / lstat", () => {
    it("exists returns true for files and directories", async () => {
      await fs.writeFile("/f.txt", "x");
      await fs.mkdir("/d");
      expect(await fs.exists("/f.txt")).toBe(true);
      expect(await fs.exists("/d")).toBe(true);
      expect(await fs.exists("/")).toBe(true);
      expect(await fs.exists("/missing")).toBe(false);
    });

    it("stat distinguishes files and directories", async () => {
      await fs.writeFile("/f.txt", "abc");
      await fs.mkdir("/d");
      const fstat = await fs.stat("/f.txt");
      expect(fstat.isFile).toBe(true);
      expect(fstat.isDirectory).toBe(false);
      expect(fstat.size).toBe(3);
      const dstat = await fs.stat("/d");
      expect(dstat.isDirectory).toBe(true);
      expect(dstat.isFile).toBe(false);
    });

    it("lstat behaves identically to stat (no symlinks in the API)", async () => {
      await fs.writeFile("/f.txt", "abc");
      const a = await fs.stat("/f.txt");
      const b = await fs.lstat("/f.txt");
      expect(a).toEqual(b);
      expect(a.isSymbolicLink).toBe(false);
    });

    it("stat throws ENOENT for missing paths", async () => {
      await expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("mkdir", () => {
    it("creates a directory", async () => {
      await fs.mkdir("/d");
      expect((await fs.stat("/d")).isDirectory).toBe(true);
    });

    it("throws EEXIST when target exists and not recursive", async () => {
      await fs.mkdir("/d");
      await expect(fs.mkdir("/d")).rejects.toThrow("EEXIST");
    });

    it("recursive: true silently succeeds when directory exists", async () => {
      await fs.mkdir("/d");
      await expect(fs.mkdir("/d", { recursive: true })).resolves.toBeUndefined();
    });

    it("recursive: true creates intermediate directories", async () => {
      await fs.mkdir("/x/y/z", { recursive: true });
      expect((await fs.stat("/x/y/z")).isDirectory).toBe(true);
    });

    it("non-recursive throws ENOENT when parent missing", async () => {
      await expect(fs.mkdir("/missing/child")).rejects.toThrow("ENOENT");
    });

    it("EEXIST when target name is an existing file", async () => {
      await fs.writeFile("/clash", "x");
      await expect(fs.mkdir("/clash")).rejects.toThrow("EEXIST");
    });
  });

  describe("readdir", () => {
    it("lists entries sorted by name", async () => {
      await fs.writeFile("/b.txt", "");
      await fs.writeFile("/a.txt", "");
      await fs.mkdir("/c");
      expect(await fs.readdir("/")).toEqual(["a.txt", "b.txt", "c"]);
    });

    it("returns dirent types", async () => {
      await fs.writeFile("/a.txt", "");
      await fs.mkdir("/sub");
      const ents = await fs.readdirWithFileTypes("/");
      expect(ents).toEqual([
        { name: "a.txt", isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: "sub", isFile: false, isDirectory: true, isSymbolicLink: false },
      ]);
    });

    it("ENOENT for missing path", async () => {
      await expect(fs.readdir("/missing")).rejects.toThrow("ENOENT");
    });
  });

  describe("rm", () => {
    it("removes a file", async () => {
      await fs.writeFile("/f.txt", "x");
      await fs.rm("/f.txt");
      expect(await fs.exists("/f.txt")).toBe(false);
    });

    it("ENOENT on missing path without force", async () => {
      await expect(fs.rm("/missing")).rejects.toThrow("ENOENT");
    });

    it("force: true silently succeeds on missing path", async () => {
      await expect(fs.rm("/missing", { force: true })).resolves.toBeUndefined();
    });

    it("ENOTEMPTY on non-empty dir without recursive", async () => {
      await fs.mkdir("/d");
      await fs.writeFile("/d/x", "");
      await expect(fs.rm("/d")).rejects.toThrow("ENOTEMPTY");
    });

    it("recursive removes a populated directory", async () => {
      await fs.mkdir("/d/e", { recursive: true });
      await fs.writeFile("/d/e/x", "");
      await fs.rm("/d", { recursive: true });
      expect(await fs.exists("/d")).toBe(false);
    });
  });

  describe("cp", () => {
    it("copies a file", async () => {
      await fs.writeFile("/a.txt", "src");
      await fs.cp("/a.txt", "/b.txt");
      expect(await fs.readFile("/b.txt")).toBe("src");
      expect(await fs.exists("/a.txt")).toBe(true);
    });

    it("EISDIR when copying a dir without recursive", async () => {
      await fs.mkdir("/d");
      await expect(fs.cp("/d", "/e")).rejects.toThrow("EISDIR");
    });

    it("recursive copies a tree", async () => {
      await fs.mkdir("/src/inner", { recursive: true });
      await fs.writeFile("/src/x", "1");
      await fs.writeFile("/src/inner/y", "2");
      await fs.cp("/src", "/dst", { recursive: true });
      expect(await fs.readFile("/dst/x")).toBe("1");
      expect(await fs.readFile("/dst/inner/y")).toBe("2");
    });
  });

  describe("mv", () => {
    it("moves a file", async () => {
      await fs.writeFile("/a.txt", "x");
      await fs.mv("/a.txt", "/b.txt");
      expect(await fs.exists("/a.txt")).toBe(false);
      expect(await fs.readFile("/b.txt")).toBe("x");
    });

    it("moves a directory", async () => {
      await fs.mkdir("/src/inner", { recursive: true });
      await fs.writeFile("/src/inner/y", "2");
      await fs.mv("/src", "/dst");
      expect(await fs.exists("/src")).toBe(false);
      expect(await fs.readFile("/dst/inner/y")).toBe("2");
    });
  });

  describe("operations unsupported by the handle API", () => {
    it("symlink throws EPERM", async () => {
      await expect(fs.symlink("/a", "/b")).rejects.toThrow("EPERM");
    });

    it("link throws EPERM", async () => {
      await expect(fs.link("/a", "/b")).rejects.toThrow("EPERM");
    });

    it("readlink throws EINVAL", async () => {
      await fs.writeFile("/f.txt", "x");
      await expect(fs.readlink("/f.txt")).rejects.toThrow("EINVAL");
    });

    it("chmod is a no-op in writable mode", async () => {
      await fs.writeFile("/f.txt", "x");
      await expect(fs.chmod("/f.txt", 0o755)).resolves.toBeUndefined();
    });

    it("utimes is a no-op in writable mode", async () => {
      await fs.writeFile("/f.txt", "x");
      await expect(
        fs.utimes("/f.txt", new Date(), new Date()),
      ).resolves.toBeUndefined();
    });
  });

  describe("readOnly mode", () => {
    let root: FileSystemDirectoryHandle;
    let ro: WebFs;

    beforeEach(async () => {
      // Seed via a writable instance, then mount the same root read-only.
      root = createMockWebFsRoot();
      const seeder = new WebFs({ root });
      await seeder.writeFile("/seed.txt", "hello");
      await seeder.mkdir("/dir");
      ro = new WebFs({ root, readOnly: true });
    });

    it("allows reads", async () => {
      expect(await ro.readFile("/seed.txt")).toBe("hello");
      expect(await ro.readdir("/")).toEqual(["dir", "seed.txt"]);
      expect(await ro.exists("/seed.txt")).toBe(true);
      expect((await ro.stat("/seed.txt")).isFile).toBe(true);
    });

    it("rejects writeFile with EROFS", async () => {
      await expect(ro.writeFile("/new.txt", "x")).rejects.toThrow("EROFS");
    });

    it("rejects appendFile with EROFS", async () => {
      await expect(ro.appendFile("/seed.txt", "x")).rejects.toThrow("EROFS");
    });

    it("rejects mkdir with EROFS", async () => {
      await expect(ro.mkdir("/new-dir")).rejects.toThrow("EROFS");
    });

    it("rejects rm with EROFS", async () => {
      await expect(ro.rm("/seed.txt")).rejects.toThrow("EROFS");
    });

    it("rejects cp with EROFS", async () => {
      await expect(ro.cp("/seed.txt", "/copy.txt")).rejects.toThrow("EROFS");
    });

    it("rejects mv with EROFS", async () => {
      await expect(ro.mv("/seed.txt", "/moved.txt")).rejects.toThrow("EROFS");
    });

    it("rejects chmod with EROFS", async () => {
      await expect(ro.chmod("/seed.txt", 0o755)).rejects.toThrow("EROFS");
    });

    it("rejects utimes with EROFS", async () => {
      await expect(
        ro.utimes("/seed.txt", new Date(), new Date()),
      ).rejects.toThrow("EROFS");
    });
  });

  describe("realpath", () => {
    it("returns normalized virtual path for existing file", async () => {
      await fs.writeFile("/a/b.txt", "x");
      expect(await fs.realpath("/a/./b.txt")).toBe("/a/b.txt");
    });

    it("throws ENOENT for missing path", async () => {
      await expect(fs.realpath("/missing")).rejects.toThrow("ENOENT");
    });
  });

  describe("path normalization", () => {
    it("treats /a/./b/../b as /a/b", async () => {
      await fs.writeFile("/a/b", "x");
      expect(await fs.readFile("/a/./b/../b")).toBe("x");
    });

    it("rejects null bytes", async () => {
      await expect(fs.readFile("/a\0b")).rejects.toThrow("ENOENT");
    });
  });

  describe("getAllPaths", () => {
    it("returns [] (sync limitation, glob falls back to readdir)", () => {
      expect(fs.getAllPaths()).toEqual([]);
    });
  });

  describe("resolvePath", () => {
    it("resolves relative paths against a base", () => {
      expect(fs.resolvePath("/a/b", "c")).toBe("/a/b/c");
      expect(fs.resolvePath("/a/b", "/c")).toBe("/c");
      expect(fs.resolvePath("/a/b", "../c")).toBe("/a/c");
    });
  });
});

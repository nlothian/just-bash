/**
 * WebFs - Direct wrapper around a Web Platform File System Access handle.
 *
 * Works with any `FileSystemDirectoryHandle` — the Origin Private File System
 * (`navigator.storage.getDirectory()`), a user-picked directory from
 * `showDirectoryPicker()`, drag-dropped folders, PWA `file_handlers`, etc.
 * Paths are relative to the configured root handle.
 *
 * The File System Access API has no symlinks, no POSIX permissions model,
 * and no stable cross-directory rename. This implementation reflects those
 * constraints:
 *
 *   - `symlink`/`link`/`readlink`        → throw EPERM (operation not permitted)
 *   - `chmod`/`utimes`                   → silently no-op (no metadata storage)
 *   - `mv`                               → implemented via cp + rm
 *   - `realpath`                         → returns the normalized virtual path
 *   - `getAllPaths`                      → returns [] (sync method, the API is async)
 *
 * Designed for browser bundles. No node:fs / node:path imports; the only
 * platform dependency is the WICG File System Access API
 * (`FileSystemDirectoryHandle`, `FileSystemFileHandle`) exposed via `lib.dom`.
 *
 * Permission management is the caller's responsibility — this class never
 * calls `requestPermission()` or `queryPermission()`. Pass `readOnly: true`
 * when the caller's grant is "read" so writes fail with EROFS rather than
 * surfacing the underlying `NotAllowedError`.
 */

import {
  type FileContent,
  fromBuffer,
  getEncoding,
  toBuffer,
} from "../encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "../interface.js";
import {
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  normalizePath,
  resolvePath as resolveVPath,
  validatePath,
} from "../path-utils.js";

export interface WebFsOptions {
  /**
   * The root directory handle. Typically obtained via
   * `await navigator.storage.getDirectory()` (OPFS), or a sub-handle for
   * sandboxing, or a user-picked handle from `showDirectoryPicker()`.
   */
  root: FileSystemDirectoryHandle;

  /**
   * Maximum file size in bytes that can be read.
   * Files larger than this will throw an EFBIG error.
   * Defaults to 10MB (10485760).
   */
  maxFileReadSize?: number;

  /**
   * If true, every state-changing operation (writeFile, appendFile, mkdir,
   * rm, cp, mv, chmod, utimes) throws EROFS. Set this when the underlying
   * permission grant is "read" so callers see a consistent POSIX-style
   * error rather than a `NotAllowedError` from the handle API. Permission
   * management itself is the caller's responsibility — this class never
   * calls `requestPermission()` or `queryPermission()`.
   *
   * Defaults to false.
   */
  readOnly?: boolean;
}

/**
 * Split a normalized virtual path into its components.
 * "/" → []
 * "/a/b/c" → ["a", "b", "c"]
 */
function pathComponents(virtualPath: string): string[] {
  const normalized = normalizePath(virtualPath);
  if (normalized === "/") return [];
  return normalized.slice(1).split("/");
}

/**
 * Convert a Uint8Array to a plain ArrayBuffer for use with writable streams.
 * The lib.dom `FileSystemWriteChunkType` requires `ArrayBuffer`-backed
 * views; a Uint8Array typed as `ArrayBufferLike` (which includes
 * `SharedArrayBuffer`) is rejected by strict TS even though it's valid at
 * runtime. This helper produces a copy when necessary.
 */
function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  if (
    buf.buffer instanceof ArrayBuffer &&
    buf.byteOffset === 0 &&
    buf.byteLength === buf.buffer.byteLength
  ) {
    return buf.buffer;
  }
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * Map a DOMException (or other thrown value) to a POSIX-style errno string
 * matching the convention used by ReadWriteFs / InMemoryFs.
 */
function errCode(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.name;
  }
  return undefined;
}

function isNotFound(e: unknown): boolean {
  return errCode(e) === "NotFoundError";
}

function isTypeMismatch(e: unknown): boolean {
  return errCode(e) === "TypeMismatchError";
}

export class WebFs implements IFileSystem {
  private readonly root: FileSystemDirectoryHandle;
  private readonly maxFileReadSize: number;
  private readonly readOnly: boolean;

  constructor(options: WebFsOptions) {
    this.root = options.root;
    this.maxFileReadSize = options.maxFileReadSize ?? 10485760;
    this.readOnly = options.readOnly ?? false;
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new Error(`EROFS: read-only file system, ${operation}`);
    }
  }

  /**
   * Walk to a directory handle. With `create: true`, missing intermediate
   * directories are created. Throws ENOENT if the path resolves through a
   * file, or if `create` is false and any segment is missing.
   */
  private async walkToDir(
    components: string[],
    create: boolean,
    operation: string,
    virtualPath: string,
  ): Promise<FileSystemDirectoryHandle> {
    let dir: FileSystemDirectoryHandle = this.root;
    for (const name of components) {
      try {
        dir = await dir.getDirectoryHandle(name, { create });
      } catch (e) {
        if (isNotFound(e)) {
          throw new Error(
            `ENOENT: no such file or directory, ${operation} '${virtualPath}'`,
          );
        }
        if (isTypeMismatch(e)) {
          throw new Error(
            `ENOTDIR: not a directory, ${operation} '${virtualPath}'`,
          );
        }
        throw e;
      }
    }
    return dir;
  }

  /**
   * Resolve a virtual path to its parent directory handle and leaf name.
   * Throws if the path is "/" (no parent).
   */
  private async resolveParent(
    virtualPath: string,
    {
      createParents,
      operation,
    }: { createParents: boolean; operation: string },
  ): Promise<{ parent: FileSystemDirectoryHandle; leaf: string }> {
    const components = pathComponents(virtualPath);
    if (components.length === 0) {
      throw new Error(
        `EINVAL: invalid argument, ${operation} '${virtualPath}'`,
      );
    }
    const leaf = components[components.length - 1]!;
    const parent = await this.walkToDir(
      components.slice(0, -1),
      createParents,
      operation,
      virtualPath,
    );
    return { parent, leaf };
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    validatePath(path, "open");
    const components = pathComponents(path);
    if (components.length === 0) {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }

    const { parent, leaf } = await this.resolveParent(path, {
      createParents: false,
      operation: "open",
    });

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await parent.getFileHandle(leaf, { create: false });
    } catch (e) {
      if (isNotFound(e)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      if (isTypeMismatch(e)) {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      throw e;
    }

    const file = await fileHandle.getFile();
    if (this.maxFileReadSize > 0 && file.size > this.maxFileReadSize) {
      throw new Error(
        `EFBIG: file too large, read '${path}' (${file.size} bytes, max ${this.maxFileReadSize})`,
      );
    }
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "write");
    this.assertWritable(`write '${path}'`);
    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    const { parent, leaf } = await this.resolveParent(path, {
      createParents: true,
      operation: "write",
    });

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await parent.getFileHandle(leaf, { create: true });
    } catch (e) {
      if (isTypeMismatch(e)) {
        throw new Error(
          `EISDIR: illegal operation on a directory, write '${path}'`,
        );
      }
      throw e;
    }

    const writable = await fileHandle.createWritable();
    try {
      await writable.write(toArrayBuffer(buffer));
    } finally {
      await writable.close();
    }
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    this.assertWritable(`append '${path}'`);
    const encoding = getEncoding(options);
    const tail = toBuffer(content, encoding);

    let existing: Uint8Array = new Uint8Array(0);
    try {
      existing = await this.readFileBuffer(path);
    } catch (e) {
      const code = (e as Error).message?.split(":", 1)[0];
      if (code !== "ENOENT") throw e;
    }

    const merged = new Uint8Array(existing.length + tail.length);
    merged.set(existing, 0);
    merged.set(tail, existing.length);
    await this.writeFile(path, merged);
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    const components = pathComponents(path);
    if (components.length === 0) return true; // root always exists

    try {
      const { parent, leaf } = await this.resolveParent(path, {
        createParents: false,
        operation: "access",
      });
      // Try file first, fall back to directory
      try {
        await parent.getFileHandle(leaf, { create: false });
        return true;
      } catch (e) {
        if (isTypeMismatch(e)) {
          // It's a directory, that counts as existing
          await parent.getDirectoryHandle(leaf, { create: false });
          return true;
        }
        if (isNotFound(e)) return false;
        throw e;
      }
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    return this.statImpl(path, "stat");
  }

  async lstat(path: string): Promise<FsStat> {
    // No symlinks in this API, so lstat behaves identically to stat.
    return this.statImpl(path, "lstat");
  }

  private async statImpl(path: string, operation: string): Promise<FsStat> {
    validatePath(path, operation);
    const components = pathComponents(path);
    if (components.length === 0) {
      // Root directory
      return {
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
        mode: DEFAULT_DIR_MODE,
        size: 0,
        mtime: new Date(0),
      };
    }

    const { parent, leaf } = await this.resolveParent(path, {
      createParents: false,
      operation,
    });

    // Try file first
    try {
      const fileHandle = await parent.getFileHandle(leaf, { create: false });
      const file = await fileHandle.getFile();
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: DEFAULT_FILE_MODE,
        size: file.size,
        mtime: new Date(file.lastModified),
      };
    } catch (e) {
      if (isTypeMismatch(e)) {
        // It's a directory
        await parent.getDirectoryHandle(leaf, { create: false });
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: DEFAULT_DIR_MODE,
          size: 0,
          mtime: new Date(0),
        };
      }
      if (isNotFound(e)) {
        throw new Error(
          `ENOENT: no such file or directory, ${operation} '${path}'`,
        );
      }
      throw e;
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    validatePath(path, "mkdir");
    this.assertWritable(`mkdir '${path}'`);
    const components = pathComponents(path);
    if (components.length === 0) {
      // mkdir on / is a no-op when recursive, EEXIST otherwise
      if (options?.recursive) return;
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    const recursive = options?.recursive ?? false;

    // Walk parent dirs (creating them only if recursive)
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await this.walkToDir(
        components.slice(0, -1),
        recursive,
        "mkdir",
        path,
      );
    } catch (e) {
      // Re-throw with ENOENT framing if intermediate is missing
      throw e;
    }

    const leaf = components[components.length - 1]!;

    // Check existence to mirror real-bash semantics:
    //   - non-recursive: must throw EEXIST if it already exists
    //   - recursive: silently succeed if a directory already exists
    if (!recursive) {
      let alreadyExists = false;
      try {
        await parent.getDirectoryHandle(leaf, { create: false });
        alreadyExists = true;
      } catch (e) {
        if (!isNotFound(e) && !isTypeMismatch(e)) throw e;
        if (isTypeMismatch(e)) {
          // It's a file, not a directory
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        }
      }
      if (alreadyExists) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
    }

    try {
      await parent.getDirectoryHandle(leaf, { create: true });
    } catch (e) {
      if (isTypeMismatch(e)) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      throw e;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    const components = pathComponents(path);

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.walkToDir(components, false, "scandir", path);
    } catch (e) {
      // Could also be a file at the path
      if ((e as Error).message?.startsWith("ENOTDIR")) {
        throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
      }
      throw e;
    }

    const entries: DirentEntry[] = [];
    // FileSystemDirectoryHandle exposes async iterator entries()
    const iter = (
      dir as FileSystemDirectoryHandle & {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name, handle] of iter) {
      const isDirectory = handle.kind === "directory";
      entries.push({
        name,
        isFile: !isDirectory,
        isDirectory,
        isSymbolicLink: false,
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    this.assertWritable(`rm '${path}'`);
    const components = pathComponents(path);
    if (components.length === 0) {
      throw new Error(`EBUSY: resource busy or locked, rm '${path}'`);
    }

    const recursive = options?.recursive ?? false;
    const force = options?.force ?? false;

    const { parent, leaf } = await this.resolveParent(path, {
      createParents: false,
      operation: "rm",
    }).catch((e) => {
      if (force && (e as Error).message?.startsWith("ENOENT")) {
        return null as unknown as {
          parent: FileSystemDirectoryHandle;
          leaf: string;
        };
      }
      throw e;
    });

    if (parent === null) return;

    try {
      await parent.removeEntry(leaf, { recursive });
    } catch (e) {
      if (isNotFound(e)) {
        if (force) return;
        throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
      }
      // The API throws InvalidModificationError when removing a non-empty
      // directory without recursive: true.
      if (errCode(e) === "InvalidModificationError") {
        throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
      }
      throw e;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    this.assertWritable(`cp '${dest}'`);

    const recursive = options?.recursive ?? false;
    const srcStat = await this.stat(src);

    if (srcStat.isDirectory) {
      if (!recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(dest, { recursive: true });
      const entries = await this.readdirWithFileTypes(src);
      for (const entry of entries) {
        const childSrc = src === "/" ? `/${entry.name}` : `${src}/${entry.name}`;
        const childDest =
          dest === "/" ? `/${entry.name}` : `${dest}/${entry.name}`;
        if (entry.isDirectory) {
          await this.cp(childSrc, childDest, { recursive: true });
        } else {
          const buf = await this.readFileBuffer(childSrc);
          await this.writeFile(childDest, buf);
        }
      }
      return;
    }

    // File copy
    const buf = await this.readFileBuffer(src);
    await this.writeFile(dest, buf);
  }

  async mv(src: string, dest: string): Promise<void> {
    validatePath(src, "mv");
    validatePath(dest, "mv");
    this.assertWritable(`mv '${dest}'`);
    // The stable spec has no native cross-directory rename. Implement as
    // cp + rm. (The newer FileSystemHandle.move() exists in some browsers
    // but is not yet standardized.)
    const srcStat = await this.stat(src).catch((e) => {
      if ((e as Error).message?.startsWith("ENOENT")) {
        throw new Error(`ENOENT: no such file or directory, mv '${src}'`);
      }
      throw e;
    });
    await this.cp(src, dest, { recursive: srcStat.isDirectory });
    await this.rm(src, { recursive: srcStat.isDirectory });
  }

  resolvePath(base: string, path: string): string {
    return resolveVPath(base, path);
  }

  getAllPaths(): string[] {
    // The handle API enumerates asynchronously; the IFileSystem interface
    // returns sync. Glob fall-back code paths perform recursive readdir()
    // walks and do not depend on this method.
    return [];
  }

  async chmod(path: string, _mode: number): Promise<void> {
    this.assertWritable(`chmod '${path}'`);
    // No POSIX permissions model. Silently no-op so scripts that call
    // chmod (e.g. `chmod +x`) don't fail in writable mode.
    return;
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    this.assertWritable(`utimes '${path}'`);
    // The handle API doesn't expose a way to update mtime/atime. No-op in
    // writable mode.
    return;
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
  }

  async link(existingPath: string, _newPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
  }

  async readlink(path: string): Promise<string> {
    // No symlinks in the handle API. POSIX readlink() on a non-symlink
    // returns EINVAL.
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  async realpath(path: string): Promise<string> {
    // No symlinks; realpath is just normalization. We still verify the path
    // exists, matching POSIX realpath() semantics.
    validatePath(path, "realpath");
    const exists = await this.exists(path);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return normalizePath(path);
  }
}

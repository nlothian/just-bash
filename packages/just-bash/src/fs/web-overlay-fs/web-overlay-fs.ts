/**
 * WebOverlayFs - Copy-on-write filesystem backed by a Web Platform File
 * System Access handle.
 *
 * Reads fall through to the underlying handle (OPFS, a user-picked directory,
 * etc.); writes go to an in-memory layer. Changes don't persist to the
 * backing handle and can't escape it. Tombstones track entries removed from
 * the overlay so they appear deleted even though the handle still holds them.
 *
 * The handle API has no symlinks, no POSIX permissions model, and no stable
 * cross-directory rename — see WebFs for the full set of consequences. In
 * particular:
 *
 *   - `symlink`/`link`/`readlink`        → throw EPERM / EINVAL
 *   - `chmod`/`utimes`                   → silently no-op
 *   - `mv`                               → cp + rm
 *   - `realpath`                         → returns the normalized virtual path
 *   - `getAllPaths`                      → returns memory + tombstone-aware
 *                                          snapshot only (sync; the handle API
 *                                          enumerates async)
 *
 * Permission management is the caller's responsibility — this class never
 * calls `requestPermission()` or `queryPermission()`. Pass `readOnly: true`
 * when the caller's grant is "read".
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
  dirname,
  normalizePath,
  resolvePath as resolveVPath,
  validatePath,
} from "../path-utils.js";

interface MemoryFileEntry {
  type: "file";
  content: Uint8Array;
  mode: number;
  mtime: Date;
}

interface MemoryDirEntry {
  type: "directory";
  mode: number;
  mtime: Date;
}

type MemoryEntry = MemoryFileEntry | MemoryDirEntry;

export interface WebOverlayFsOptions {
  /**
   * The root directory handle. Reads fall through to here when not present
   * in the in-memory write layer. Typically obtained via
   * `await navigator.storage.getDirectory()` (OPFS), a sub-handle, or a
   * user-picked directory from `showDirectoryPicker()`.
   */
  root: FileSystemDirectoryHandle;

  /**
   * The virtual mount point where the backing handle appears.
   * Defaults to "/home/user/project". Accepts "/" to mount at the virtual root.
   */
  mountPoint?: string;

  /**
   * If true, every write operation throws EROFS.
   */
  readOnly?: boolean;

  /**
   * Maximum file size in bytes that can be read from the backing handle.
   * Files larger than this throw EFBIG. Defaults to 10MB.
   */
  maxFileReadSize?: number;
}

const DEFAULT_MOUNT_POINT = "/home/user/project";

function isTypeMismatch(e: unknown): boolean {
  return e instanceof Error && e.name === "TypeMismatchError";
}

export class WebOverlayFs implements IFileSystem {
  private readonly root: FileSystemDirectoryHandle;
  private readonly mountPoint: string;
  private readonly readOnly: boolean;
  private readonly maxFileReadSize: number;
  private readonly memory: Map<string, MemoryEntry> = new Map();
  private readonly deleted: Set<string> = new Set();

  constructor(options: WebOverlayFsOptions) {
    this.root = options.root;

    const mp = options.mountPoint ?? DEFAULT_MOUNT_POINT;
    this.mountPoint = mp === "/" ? "/" : mp.replace(/\/+$/, "");
    if (!this.mountPoint.startsWith("/")) {
      throw new Error(`Mount point must be an absolute path: ${mp}`);
    }

    this.readOnly = options.readOnly ?? false;
    this.maxFileReadSize = options.maxFileReadSize ?? 10485760;

    this.createMountPointDirs();
  }

  getMountPoint(): string {
    return this.mountPoint;
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new Error(`EROFS: read-only file system, ${operation}`);
    }
  }

  private createMountPointDirs(): void {
    if (!this.memory.has("/")) {
      this.memory.set("/", {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date(),
      });
    }
    if (this.mountPoint === "/") return;
    const parts = this.mountPoint.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (!this.memory.has(current)) {
        this.memory.set(current, {
          type: "directory",
          mode: DEFAULT_DIR_MODE,
          mtime: new Date(),
        });
      }
    }
  }

  /**
   * Map a virtual path to its position relative to the mount point.
   * Returns null if the path is not under the mount point (so handle lookups
   * are skipped — only the memory layer is consulted).
   *
   * "/" — when mountPoint = "/" — returns an empty component array (root).
   */
  private toHandleComponents(virtualPath: string): string[] | null {
    const normalized = normalizePath(virtualPath);
    let relative: string;
    if (this.mountPoint === "/") {
      relative = normalized;
    } else if (normalized === this.mountPoint) {
      relative = "/";
    } else if (normalized.startsWith(`${this.mountPoint}/`)) {
      relative = normalized.slice(this.mountPoint.length);
    } else {
      return null;
    }
    if (relative === "/" || relative === "") return [];
    return relative.slice(1).split("/");
  }

  private async walkHandleDir(
    components: string[],
  ): Promise<FileSystemDirectoryHandle | null> {
    let dir: FileSystemDirectoryHandle = this.root;
    for (const name of components) {
      try {
        dir = await dir.getDirectoryHandle(name, { create: false });
      } catch {
        return null;
      }
    }
    return dir;
  }

  /**
   * Look up a path in the backing handle. Returns the handle (file or dir)
   * or null if absent or unreachable. Does NOT consult the memory layer or
   * tombstones.
   */
  private async lookupHandle(
    virtualPath: string,
  ): Promise<FileSystemHandle | null> {
    const components = this.toHandleComponents(virtualPath);
    if (components === null) return null;
    if (components.length === 0) return this.root;

    const parent = await this.walkHandleDir(components.slice(0, -1));
    if (parent === null) return null;
    const leaf = components[components.length - 1]!;

    try {
      return await parent.getFileHandle(leaf, { create: false });
    } catch (e) {
      if (isTypeMismatch(e)) {
        try {
          return await parent.getDirectoryHandle(leaf, { create: false });
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /**
   * Walk parent directories in memory, creating intermediate directory
   * entries where needed (and removing them from the tombstone set).
   */
  private ensureParentDirsInMemory(path: string): void {
    const parent = dirname(path);
    if (parent === "/") return;
    if (!this.memory.has(parent) || this.deleted.has(parent)) {
      this.ensureParentDirsInMemory(parent);
      this.memory.set(parent, {
        type: "directory",
        mode: DEFAULT_DIR_MODE,
        mtime: new Date(),
      });
      this.deleted.delete(parent);
    }
  }

  /**
   * Determine whether a path is hidden by a tombstone — either the path
   * itself or any ancestor was deleted from the overlay.
   */
  private isShadowedByDeleted(normalized: string): boolean {
    if (this.deleted.has(normalized)) return true;
    let current = normalized;
    while (current !== "/") {
      const parent = dirname(current);
      if (this.deleted.has(parent)) return true;
      if (parent === current) break;
      current = parent;
    }
    return false;
  }

  private async existsInOverlay(virtualPath: string): Promise<boolean> {
    const normalized = normalizePath(virtualPath);
    if (this.isShadowedByDeleted(normalized)) return false;
    if (this.memory.has(normalized)) return true;
    const handle = await this.lookupHandle(normalized);
    return handle !== null;
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
    const normalized = normalizePath(path);

    if (this.isShadowedByDeleted(normalized)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }

    const memEntry = this.memory.get(normalized);
    if (memEntry) {
      if (memEntry.type !== "file") {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      return memEntry.content;
    }

    const handle = await this.lookupHandle(normalized);
    if (handle === null) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (handle.kind === "directory") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }
    const fileHandle = handle as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    if (this.maxFileReadSize > 0 && file.size > this.maxFileReadSize) {
      throw new Error(
        `EFBIG: file too large, read '${path}' (${file.size} bytes, max ${this.maxFileReadSize})`,
      );
    }
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "write");
    this.assertWritable(`write '${path}'`);
    const normalized = normalizePath(path);
    this.ensureParentDirsInMemory(normalized);

    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    this.memory.set(normalized, {
      type: "file",
      content: buffer,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    this.assertWritable(`append '${path}'`);
    const normalized = normalizePath(path);
    const encoding = getEncoding(options);
    const tail = toBuffer(content, encoding);

    let existing: Uint8Array;
    try {
      existing = await this.readFileBuffer(normalized);
    } catch (e) {
      const code = (e as Error).message?.split(":", 1)[0];
      if (code !== "ENOENT") throw e;
      existing = new Uint8Array(0);
    }

    const merged = new Uint8Array(existing.length + tail.length);
    merged.set(existing, 0);
    merged.set(tail, existing.length);

    this.ensureParentDirsInMemory(normalized);
    this.memory.set(normalized, {
      type: "file",
      content: merged,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    return this.existsInOverlay(path);
  }

  async stat(path: string): Promise<FsStat> {
    return this.statImpl(path, "stat");
  }

  async lstat(path: string): Promise<FsStat> {
    return this.statImpl(path, "lstat");
  }

  private async statImpl(path: string, operation: string): Promise<FsStat> {
    validatePath(path, operation);
    const normalized = normalizePath(path);

    if (this.isShadowedByDeleted(normalized)) {
      throw new Error(
        `ENOENT: no such file or directory, ${operation} '${path}'`,
      );
    }

    // Mode bits reflect the readOnly grant. Memory entries store their own
    // mode, so we mask with `& 0o555` to strip write bits while preserving
    // anything the caller set (e.g. via mkdir defaults). For handle-backed
    // entries we synthesize a mode from the defaults.
    const fileMode = this.readOnly ? 0o444 : DEFAULT_FILE_MODE;
    const dirMode = this.readOnly ? 0o555 : DEFAULT_DIR_MODE;
    const maskMemMode = (mode: number) => (this.readOnly ? mode & 0o555 : mode);

    const memEntry = this.memory.get(normalized);
    if (memEntry) {
      const isFile = memEntry.type === "file";
      return {
        isFile,
        isDirectory: !isFile,
        isSymbolicLink: false,
        mode: maskMemMode(memEntry.mode),
        size: isFile ? (memEntry as MemoryFileEntry).content.length : 0,
        mtime: memEntry.mtime,
      };
    }

    const handle = await this.lookupHandle(normalized);
    if (handle === null) {
      throw new Error(
        `ENOENT: no such file or directory, ${operation} '${path}'`,
      );
    }
    if (handle.kind === "file") {
      const file = await (handle as FileSystemFileHandle).getFile();
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: fileMode,
        size: file.size,
        mtime: new Date(file.lastModified),
      };
    }
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: dirMode,
      size: 0,
      mtime: new Date(0),
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    validatePath(path, "mkdir");
    this.assertWritable(`mkdir '${path}'`);
    const normalized = normalizePath(path);

    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      return;
    }

    const parent = dirname(normalized);
    if (parent !== "/") {
      const parentExists = await this.existsInOverlay(parent);
      if (!parentExists) {
        if (options?.recursive) {
          await this.mkdir(parent, { recursive: true });
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      }
    }

    this.memory.set(normalized, {
      type: "directory",
      mode: DEFAULT_DIR_MODE,
      mtime: new Date(),
    });
    this.deleted.delete(normalized);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    const normalized = normalizePath(path);

    if (this.isShadowedByDeleted(normalized)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    // Reject if a memory entry at this path is a file (not a dir)
    const memEntry = this.memory.get(normalized);
    if (memEntry && memEntry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const entriesMap = new Map<string, DirentEntry>();
    const deletedChildren = new Set<string>();
    const prefix = normalized === "/" ? "/" : `${normalized}/`;

    for (const deletedPath of this.deleted) {
      if (deletedPath.startsWith(prefix)) {
        const rest = deletedPath.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length)) {
          deletedChildren.add(name);
        }
      }
    }

    // Memory layer entries that are direct children of `normalized`
    for (const [memPath, entry] of this.memory) {
      if (memPath === normalized) continue;
      if (!memPath.startsWith(prefix)) continue;
      const rest = memPath.slice(prefix.length);
      if (rest.includes("/")) continue;
      if (deletedChildren.has(rest)) continue;
      entriesMap.set(rest, {
        name: rest,
        isFile: entry.type === "file",
        isDirectory: entry.type === "directory",
        isSymbolicLink: false,
      });
    }

    // Backing-handle entries — only when the path is under the mount point
    let foundOnHandle = false;
    const components = this.toHandleComponents(normalized);
    if (components !== null) {
      const dir = await this.walkHandleDir(components);
      if (dir !== null) {
        foundOnHandle = true;
        const iter = (
          dir as FileSystemDirectoryHandle & {
            entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
          }
        ).entries();
        for await (const [name, child] of iter) {
          if (deletedChildren.has(name) || entriesMap.has(name)) continue;
          const isDirectory = child.kind === "directory";
          entriesMap.set(name, {
            name,
            isFile: !isDirectory,
            isDirectory,
            isSymbolicLink: false,
          });
        }
      }
    }

    if (!foundOnHandle && !memEntry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    this.assertWritable(`rm '${path}'`);
    const normalized = normalizePath(path);

    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    const stat = await this.stat(normalized);
    if (stat.isDirectory) {
      const children = await this.readdir(normalized);
      if (children.length > 0 && !options?.recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
      }
      for (const child of children) {
        const childPath =
          normalized === "/" ? `/${child}` : `${normalized}/${child}`;
        await this.rm(childPath, options);
      }
    }

    this.memory.delete(normalized);

    // Tombstone only when a backing-handle path needs hiding. Memory-only
    // files don't need a tombstone (prevents unbounded growth of the deleted
    // set).
    if (await this.existsOnHandle(normalized)) {
      this.deleted.add(normalized);
    }
  }

  private async existsOnHandle(virtualPath: string): Promise<boolean> {
    const handle = await this.lookupHandle(virtualPath);
    return handle !== null;
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    this.assertWritable(`cp '${dest}'`);
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);

    const srcExists = await this.existsInOverlay(srcNorm);
    if (!srcExists) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    const srcStat = await this.stat(srcNorm);
    if (srcStat.isFile) {
      const content = await this.readFileBuffer(srcNorm);
      await this.writeFile(destNorm, content);
      return;
    }
    if (!options?.recursive) {
      throw new Error(`EISDIR: is a directory, cp '${src}'`);
    }
    await this.mkdir(destNorm, { recursive: true });
    const children = await this.readdir(srcNorm);
    for (const child of children) {
      const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
      const destChild =
        destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
      await this.cp(srcChild, destChild, options);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.assertWritable(`mv '${dest}'`);
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  resolvePath(base: string, rel: string): string {
    return resolveVPath(base, rel);
  }

  getAllPaths(): string[] {
    // Sync return type forces us to ignore backing-handle contents (async to
    // enumerate). Glob fallback uses readdir() walks, which do see them.
    const paths = new Set<string>(this.memory.keys());
    for (const deleted of this.deleted) paths.delete(deleted);
    return Array.from(paths);
  }

  async chmod(path: string, _mode: number): Promise<void> {
    this.assertWritable(`chmod '${path}'`);
    // No POSIX permissions model; silent no-op in writable mode.
    return;
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    this.assertWritable(`utimes '${path}'`);
    // No way to update mtime/atime through the handle API; silent no-op
    // in writable mode.
    return;
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, symlink '${linkPath}'`);
  }

  async link(existingPath: string, _newPath: string): Promise<void> {
    throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const exists = await this.existsInOverlay(path);
    if (!exists) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    return normalizePath(path);
  }
}

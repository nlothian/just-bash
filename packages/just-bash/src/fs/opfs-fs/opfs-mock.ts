/**
 * In-memory mock of the WICG File System Access API for tests.
 *
 * Implements just enough of `FileSystemDirectoryHandle` /
 * `FileSystemFileHandle` to exercise OpfsFs without a real browser.
 * Errors thrown match the real OPFS semantics: DOMException-like objects
 * with `name` set to "NotFoundError" / "TypeMismatchError" /
 * "InvalidModificationError".
 */

class FsError extends Error {
  constructor(
    name:
      | "NotFoundError"
      | "TypeMismatchError"
      | "InvalidModificationError"
      | "TypeError",
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

type Node = FileNode | DirNode;

interface FileNode {
  kind: "file";
  data: Uint8Array;
  lastModified: number;
}

interface DirNode {
  kind: "directory";
  children: Map<string, Node>;
}

class MockWritable {
  private buffers: Uint8Array[] = [];
  constructor(private readonly file: FileNode) {}

  async write(chunk: BufferSource | Uint8Array | string): Promise<void> {
    let bytes: Uint8Array;
    if (typeof chunk === "string") {
      bytes = new TextEncoder().encode(chunk);
    } else if (chunk instanceof Uint8Array) {
      bytes = chunk;
    } else if (chunk instanceof ArrayBuffer) {
      bytes = new Uint8Array(chunk);
    } else {
      bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    this.buffers.push(bytes);
  }

  async close(): Promise<void> {
    const totalLen = this.buffers.reduce((sum, b) => sum + b.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const b of this.buffers) {
      merged.set(b, offset);
      offset += b.length;
    }
    this.file.data = merged;
    this.file.lastModified = Date.now();
  }
}

class MockFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly name: string,
    private readonly node: FileNode,
  ) {}

  async getFile(): Promise<{
    size: number;
    lastModified: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
    text: () => Promise<string>;
  }> {
    const data = this.node.data;
    return {
      size: data.length,
      lastModified: this.node.lastModified,
      arrayBuffer: async () => {
        const copy = new Uint8Array(data);
        return copy.buffer;
      },
      text: async () => new TextDecoder().decode(data),
    };
  }

  async createWritable(): Promise<MockWritable> {
    // Real OPFS createWritable() truncates by default — match that.
    this.node.data = new Uint8Array(0);
    return new MockWritable(this.node);
  }
}

class MockDirHandle {
  readonly kind = "directory" as const;
  constructor(
    readonly name: string,
    private readonly node: DirNode,
  ) {}

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MockDirHandle> {
    const existing = this.node.children.get(name);
    if (existing) {
      if (existing.kind !== "directory") {
        throw new FsError(
          "TypeMismatchError",
          `'${name}' is a file, not a directory`,
        );
      }
      return new MockDirHandle(name, existing);
    }
    if (!options?.create) {
      throw new FsError("NotFoundError", `'${name}' not found`);
    }
    const newNode: DirNode = { kind: "directory", children: new Map() };
    this.node.children.set(name, newNode);
    return new MockDirHandle(name, newNode);
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MockFileHandle> {
    const existing = this.node.children.get(name);
    if (existing) {
      if (existing.kind !== "file") {
        throw new FsError(
          "TypeMismatchError",
          `'${name}' is a directory, not a file`,
        );
      }
      return new MockFileHandle(name, existing);
    }
    if (!options?.create) {
      throw new FsError("NotFoundError", `'${name}' not found`);
    }
    const newNode: FileNode = {
      kind: "file",
      data: new Uint8Array(0),
      lastModified: Date.now(),
    };
    this.node.children.set(name, newNode);
    return new MockFileHandle(name, newNode);
  }

  async removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const existing = this.node.children.get(name);
    if (!existing) {
      throw new FsError("NotFoundError", `'${name}' not found`);
    }
    if (
      existing.kind === "directory" &&
      existing.children.size > 0 &&
      !options?.recursive
    ) {
      throw new FsError(
        "InvalidModificationError",
        `directory '${name}' not empty`,
      );
    }
    this.node.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, MockFileHandle | MockDirHandle]> {
    for (const [name, child] of this.node.children) {
      if (child.kind === "file") {
        yield [name, new MockFileHandle(name, child)];
      } else {
        yield [name, new MockDirHandle(name, child)];
      }
    }
  }
}

/**
 * Create an empty in-memory OPFS root handle. Cast to `FileSystemDirectoryHandle`
 * for use as `OpfsFsOptions.root` — the mock implements the surface OpfsFs uses.
 */
export function createMockOpfsRoot(): FileSystemDirectoryHandle {
  const root: DirNode = { kind: "directory", children: new Map() };
  return new MockDirHandle("", root) as unknown as FileSystemDirectoryHandle;
}

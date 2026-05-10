# WebFs browser demo

A minimal HTML harness that exercises [`WebFs`](../../packages/just-bash/src/fs/web-fs/web-fs.ts)
against both backing stores supported by the File System Access API:

- **OPFS** — `navigator.storage.getDirectory()`. No prompt, persists across reloads.
- **A user-picked directory** — `showDirectoryPicker()`. Real folder on disk.

Same `WebFs` class drives both panels — only the source of the
`FileSystemDirectoryHandle` differs.

## Run it

```bash
# 1. Build the browser bundle (from repo root)
cd packages/just-bash && pnpm build && cd ../..

# 2. Serve the repo from its root so the import path resolves
npx serve .

# 3. Open the example
open http://localhost:3000/examples/web-fs/
```

The page imports `/packages/just-bash/dist/bundle/browser.js`. If you serve
from a different root, adjust the path in `index.html`.

## Browser support

| Feature | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| OPFS panel | ✓ | ✓ | ✓ |
| User-picked directory | ✓ | ✗ | ✗ |

Use Chrome or Edge for the full demo. Safari / Firefox can still exercise the
OPFS panel.

## What each button does

### OPFS panel

| Button | What it does |
|---|---|
| **Write & append** | `writeFile("/notes.txt")`, then `appendFile`, then `mkdir("/sub")` + `writeFile("/sub/inner.txt")`. |
| **List & read** | Recursive walk via `readdirWithFileTypes` + `readFile`, with stat info. Survives a page reload. |
| **Stat (read-only mode)** | Mounts the *same* root with `readOnly: true`, then reads stat — mode bits should be `0o444` for files and `0o555` for directories. Also tries a `writeFile` to prove it throws `EROFS`. |
| **Clear** | Removes every top-level entry (recursive). |

### User-picked directory panel

You must click **Pick a directory…** first (the picker requires a user gesture).
Then the rest of the buttons enable:

| Button | What it does |
|---|---|
| **Read top-level files** | Lists every entry, reads the first 240 chars of each file, skips binaries. |
| **Count (recursive)** | Walks the whole tree and reports file count, dir count, and total bytes — entirely through the `WebFs` async API. |
| **Write example.txt** | Writes `just-bash-example.txt` into the picked directory. Open the folder in your file manager to confirm — it's a real file on disk. |
| **grep -rIn** | Runs `grep -r -n -I -- <pattern> /` through the actual bash interpreter (`Bash.exec`). Pattern is shell-quoted so `$`, `` ` ``, and `\` in the input are safe. Output capped at 200 lines. |

## Why this is interesting

- **Same class for both stores** — `WebFs` doesn't know or care whether the
  handle came from OPFS or a user picker. The rename from `OpfsFs` to `WebFs`
  exists to make this honest.
- **No permission requests in `WebFs`** — the demo never calls
  `requestPermission()` / `queryPermission()`. The `showDirectoryPicker` UI
  handles that out-of-band.
- **`readOnly: true` honored at two levels** — write methods throw `EROFS`,
  and `stat()` reports masked mode bits so bash predicates like `[[ -w f ]]`
  see the right state.
- **Real bash, real files** — clicking *grep* runs the actual just-bash
  interpreter. `grep` walks the FS through the same `IFileSystem` calls as
  any other backend (`InMemoryFs`, `OverlayFs`, etc.).

## Resetting OPFS

Storage panel of DevTools → **Application → Storage → Clear site data**, or
from the console:

```js
const root = await navigator.storage.getDirectory();
for await (const [name] of root.entries()) {
  await root.removeEntry(name, { recursive: true });
}
```

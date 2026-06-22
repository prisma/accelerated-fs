# just-bash adapter

`AcceleratedJustBashFs` adapts `S3CachedFs` to the filesystem shape used by `just-bash`.

`AcceleratedJustBashShell` wires that filesystem into `new Bash({ fs, cwd })` and exposes a small `exec()` helper with timeout and abort handling.

## Install

```bash
bun add just-bash
```

`just-bash` is an optional peer dependency. The wrapper can also receive a `Bash` constructor directly, which is useful for tests and strict bundlers.

## Basic filesystem usage

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";
import { AcceleratedJustBashFs } from "s3-bun-cached-fs/just-bash";

const manager = new S3CachedFsManagerImpl({ cacheRoot: "/tmp/accelerated-cache" });
const core = await manager.mount({
  name: "workspace",
  mode: "readwrite",
  bucket: "my-bucket",
  prefix: "agent/workspace",
  region: "eu-central-1",
  cacheBytes: 500 * 1024 * 1024,
});

const fs = new AcceleratedJustBashFs(core);

await fs.mkdir("/workspace", { recursive: true });
await fs.writeFile("/workspace/input.txt", "hello");
console.log(await fs.readFile("/workspace/input.txt"));
```

## Basic shell usage

```ts
import { createAcceleratedJustBashShell } from "s3-bun-cached-fs/just-bash";

const shell = await createAcceleratedJustBashShell({
  filesystem: core,
  cwd: "/workspace",
});

await shell.exec("mkdir -p reports");
await shell.exec("echo hello | tee reports/out.txt");
const result = await shell.exec("cat reports/out.txt", { timeoutMs: 5_000 });

console.log(result.stdout);
await shell.close();
```

You can pass just-bash options through `bashOptions`:

```ts
const shell = await createAcceleratedJustBashShell({
  filesystem: core,
  cwd: "/workspace",
  bashOptions: {
    network: {
      allowedUrlPrefixes: ["https://api.example.com"],
    },
  },
});
```

## API

```ts
const fs = new AcceleratedJustBashFs(core, {
  persistSymlinks: true,
  symlinkMetadataPath: "/.acceleratedfs.just-bash.symlinks.json",
  hideMetadataFile: true,
  primePathCache: false,
});
```

Implemented filesystem methods:

```ts
await fs.readFile(path, encodingOrOptions);
await fs.readFileBytes(path);
await fs.readFileBuffer(path);
await fs.writeFile(path, content, encodingOrOptions);
await fs.appendFile(path, content, encodingOrOptions);
await fs.exists(path);
await fs.stat(path);
await fs.lstat(path);
await fs.mkdir(path, { recursive });
await fs.readdir(path);
await fs.readdirWithFileTypes(path);
await fs.rm(path, { recursive, force });
await fs.cp(src, dest, { recursive });
await fs.mv(src, dest);
await fs.chmod(path, mode);
await fs.symlink(target, linkPath);
await fs.link(existingPath, newPath);
await fs.readlink(path);
await fs.realpath(path);
await fs.utimes(path, atime, mtime);

fs.resolvePath(base, path);
fs.getAllPaths();
await fs.refreshPathCache();
fs.underlying();
```

`getAllPaths()` is synchronous because just-bash uses it for globbing and path discovery. The wrapper maintains a path cache as commands touch files. For a fully populated path cache, call `refreshPathCache()` or construct the wrapper with `primePathCache: true`. Full cache priming walks the whole remote namespace and should be used carefully on very large workspaces.

## Symlinks and hard links

The core filesystem does not yet expose native symlink or hard-link inodes. The just-bash wrapper provides practical shell behavior:

- symbolic links are stored in a small JSON sidecar file, hidden from normal `readdir()` by default
- symbolic links are persisted through the core WAL because the sidecar file is written through `S3CachedFs`
- hard links are simulated by copying bytes, not by sharing an inode

The default sidecar path is:

```text
/.acceleratedfs.just-bash.symlinks.json
```

Set `persistSymlinks: false` for process-local symlink state.

## Shell execution semantics

`AcceleratedJustBashShell` is intentionally not a host shell. It uses just-bash's TypeScript shell implementation and the `AcceleratedJustBashFs` wrapper.

That means commands like `cat`, `grep`, `find`, `sed`, `awk`, `jq`, `mkdir`, `rm`, and `mv` operate on the S3-backed virtual filesystem. Host binaries, host absolute paths, and arbitrary OS process execution are not exposed.

This is the right tradeoff for agent sandboxes: shell behavior without granting direct access to the runtime's filesystem.

## Closing

`AcceleratedJustBashShell.close()` closes only the shell wrapper by default. It does not close the underlying `S3CachedFs` unless `closeFilesystemOnClose: true` is set.

```ts
const shell = await createAcceleratedJustBashShell({
  filesystem: core,
  cwd: "/workspace",
  closeFilesystemOnClose: false,
});

await shell.close();
await core.close();
```

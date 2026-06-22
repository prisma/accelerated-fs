# just-bash Adapter

`s3-bun-cached-fs/just-bash` exports `AcceleratedJustBashFs` and `AcceleratedJustBashShell`.

The value proposition: agent workflows can run shell-like commands against an S3-backed virtual filesystem without exposing the host filesystem or spawning arbitrary host processes. Commands read and write through the same core WAL, cache, and metadata layer as direct application code.

## Why Use It

Use this adapter when you need:

- just-bash commands over a durable remote workspace
- shell-style file manipulation without host process execution
- command-created files committed through `S3CachedFs`
- virtual filesystem glob/path discovery through `getAllPaths()`
- persisted symlink behavior for shell workflows
- the same cache, WAL, snapshots, and writer fencing as the core filesystem

Do not use it when you need a real POSIX shell, host binaries, or direct host paths.

## Install

```bash
bun add s3-bun-cached-fs just-bash
```

`just-bash` is an optional peer. The shell helper dynamically imports it unless you pass a `Bash` constructor or module directly.

## Filesystem Wrapper

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";
import { AcceleratedJustBashFs } from "s3-bun-cached-fs/just-bash";

const manager = new S3CachedFsManagerImpl({ cacheRoot: "/tmp/accelerated-cache" });
const core = await manager.mount({
  name: "workspace",
  mode: "readwrite",
  bucket: "my-bucket",
  prefix: "agent/workspace",
  region: "us-east-1",
  cacheBytes: 500 * 1024 * 1024,
});

const fs = new AcceleratedJustBashFs(core);

await fs.mkdir("/workspace", { recursive: true });
await fs.writeFile("/workspace/input.txt", "hello");
console.log(await fs.readFile("/workspace/input.txt"));
```

The wrapper implements the filesystem shape consumed by `new Bash({ fs })`, including text/binary reads, writes, append, stats, directory listing, copy, move, remove, chmod, symlink, hard-link simulation, realpath, and path-cache methods.

## Shell Helper

```ts
import { createAcceleratedJustBashShell } from "s3-bun-cached-fs/just-bash";

const shell = await createAcceleratedJustBashShell({
  filesystem: core,
  cwd: "/workspace",
});

await shell.exec("mkdir -p reports");
await shell.exec("echo hello > reports/out.txt");
const result = await shell.exec("cat reports/out.txt", { timeoutMs: 5_000 });

console.log(result.stdout);
```

`exec()` forwards cwd, env, stdin, args, timeout, and abort signal options to just-bash. Timeouts return exit code `124`; explicit aborts return exit code `130` when the command observes the abort.

## Path Cache

just-bash uses synchronous path discovery for globbing. `AcceleratedJustBashFs` maintains a path cache as commands touch files.

```ts
await fs.refreshPathCache();
console.log(fs.getAllPaths());
```

Set `primePathCache: true` only when initial glob expansion must see the entire existing workspace. It walks the full namespace and can be expensive for large workspaces.

## Symlinks And Links

The core filesystem does not yet expose native symlink or hard-link inodes. The adapter provides practical shell behavior:

- symlinks are stored in a hidden JSON sidecar file by default
- the sidecar is written through `S3CachedFs`, so symlinks are durable
- hard links are simulated by copying bytes

The default sidecar path is:

```text
/.acceleratedfs.just-bash.symlinks.json
```

Set `persistSymlinks: false` for process-local symlinks.

## Local Demo

Run the self-contained demo from the repository root:

```bash
bun run demo:just-bash
```

The demo uses `LocalObjectStore` and a tiny Bash-compatible shim so it runs without installing just-bash. In a real app, omit the `Bash` override and let the helper import `just-bash`.

## Closing

`AcceleratedJustBashShell.close()` closes the shell wrapper. It closes the underlying filesystem only when `closeFilesystemOnClose: true` is set.

```ts
await shell.close();
await core.close();
```

Full reference: [`../../docs/just-bash.md`](../../docs/just-bash.md).

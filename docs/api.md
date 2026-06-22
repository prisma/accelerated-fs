# API

## Manager

```ts
const manager = new S3CachedFsManagerImpl({
  cacheRoot: "/tmp/s3vfs",
});
```

### `mount(config)`

Creates a mount.

```ts
const fs = await manager.mount({
  name: "dataset",
  mode: "readwrite",
  bucket: "my-bucket",
  prefix: "datasets/prod",
  region: "eu-central-1",
  cacheBytes: 500 * 1024 * 1024,
});
```

Required fields:

- `name`
- `mode`: `"readonly"` or `"readwrite"`
- `cacheBytes`

When using the default S3 backend, `bucket` is also required. Credentials are read from the mount config or from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`.

### `unmount(name)` and `closeAll()`

Both call `close()` on the mounted filesystem. For readwrite mounts, close publishes a final snapshot and releases the writer lease.

## Reads

```ts
await fs.stat("/path/file.txt");
await fs.exists("/path/file.txt");
await fs.readdir("/path");
await fs.readFile("/path/file.txt");
await fs.readText("/path/file.txt");
await fs.readRange("/path/file.bin", 1024, 4096);
const stream = fs.stream("/path/huge.bin");
```

`stat()`, `exists()`, and `readdir()` are SQLite-only after mount. They do not list S3.

## Materialized reads

```ts
const lease = await fs.materialize("/index.json");
try {
  const parsed = await lease.file.json();
} finally {
  await lease.release();
}
```

`materialize()` assembles a full real local file and returns `Bun.file(localPath)`. It is intended for small and medium files or libraries that require a real path. Large files should use `stream()` or `readRange()`.

## Writes

```ts
await fs.writeFile("/out.txt", "hello");
```

`writeFile()` is an atomic whole-file replace.

```ts
const h = await fs.openWrite("/out.bin");
await Bun.write(h.file, bytes);
await h.close();
```

`openWrite()` gives the caller a real local file target. The remote commit happens on `close()`.

## Transactions

```ts
await fs.transaction(async tx => {
  await tx.mkdir("/shards");
  await tx.writeFile("/shards/0.json", JSON.stringify({ i: 0 }));
  await tx.writeFile("/shards/1.json", JSON.stringify({ i: 1 }));
});
```

A transaction produces one remote metadata WAL record and one head update. Small files in the transaction are packed.

## Metadata operations

```ts
await fs.mkdir("/dir", { recursive: true });
await fs.rename("/dir/a.txt", "/dir/b.txt");
await fs.rm("/dir", { recursive: true });
await fs.unlink("/dir/file.txt");
```

Parent directories are auto-created for writes and rename destinations.

## Refresh and close

```ts
await fs.refresh();
await fs.snapshot({ force: true });
await fs.close();
```

Readonly mounts use `refresh()` to observe newer heads. Readwrite mounts call `snapshot({ force: true })` during `close()`.

## Mastra `AcceleratedFS` provider

```ts
import { Workspace } from "@mastra/core/workspace";
import { AcceleratedFS } from "s3-bun-cached-fs";

const workspace = new Workspace({
  filesystem: new AcceleratedFS({
    id: "workspace-data",
    bucket: "my-bucket",
    prefix: "mastra/workspaces/workspace-data",
    region: "eu-central-1",
    cacheRoot: "/tmp/mastra-cache",
    cacheBytes: 500 * 1024 * 1024,
  }),
});
```

`AcceleratedFS` implements Mastra's workspace filesystem provider surface:

```ts
await fs.readFile(path, options);
await fs.writeFile(path, content, options);
await fs.deleteFile(path, options);
await fs.appendFile(path, content, options);
await fs.copyFile(src, dest, options);
await fs.moveFile(src, dest, options);
await fs.readdir(path, options);
await fs.mkdir(path, options);
await fs.rmdir(path, options);
await fs.exists(path);
await fs.stat(path);
await fs.grep(pattern, options); // optional accelerated helper

await fs.init();
await fs.destroy();
fs.getInfo();
fs.getInstructions({ requestContext });
```

It also exposes accelerated extras for application code:

```ts
await fs.readRange("/large.bin", 0, 64 * 1024);
const stream = fs.stream("/large.bin");
const lease = await fs.materialize("/small.db");
const grepMatches = await fs.grep("TODO", { path: "/src", include: "*.ts" });
const underlying = await fs.underlying();
```

See [`docs/mastra-accelerated-fs.md`](mastra-accelerated-fs.md) for full Mastra usage, lifecycle behavior, read-only mode, accelerated extras, and limitations.

## just-bash adapter

Use the subpath export when wiring just-bash directly:

```ts
import {
  AcceleratedJustBashFs,
  AcceleratedJustBashShell,
  createAcceleratedJustBashFs,
  createAcceleratedJustBashShell,
} from "s3-bun-cached-fs/just-bash";
```

### `AcceleratedJustBashFs`

```ts
const justFs = new AcceleratedJustBashFs(coreFs, {
  persistSymlinks: true,
  hideMetadataFile: true,
  primePathCache: false,
});
```

The wrapper implements the filesystem shape consumed by `new Bash({ fs })`:

```ts
await justFs.readFile(path, options);
await justFs.readFileBytes(path);
await justFs.readFileBuffer(path);
await justFs.writeFile(path, content, options);
await justFs.appendFile(path, content, options);
await justFs.exists(path);
await justFs.stat(path);
await justFs.lstat(path);
await justFs.mkdir(path, { recursive });
await justFs.readdir(path);
await justFs.readdirWithFileTypes(path);
await justFs.rm(path, { recursive, force });
await justFs.cp(src, dest, { recursive });
await justFs.mv(src, dest);
await justFs.chmod(path, mode);
await justFs.symlink(target, linkPath);
await justFs.link(existingPath, newPath);
await justFs.readlink(path);
await justFs.realpath(path);
await justFs.utimes(path, atime, mtime);

justFs.resolvePath(base, path);
justFs.getAllPaths();
await justFs.refreshPathCache();
justFs.underlying();
```

`refreshPathCache()` performs a full namespace walk so just-bash globbing can see paths that no command has touched yet. Leave `primePathCache` off for very large workspaces unless exact initial glob expansion matters.

### `AcceleratedJustBashShell`

```ts
const shell = await createAcceleratedJustBashShell({
  filesystem: coreFs,
  cwd: "/workspace",
  bashOptions: {},
});

const result = await shell.exec("grep -R TODO .", {
  cwd: "/workspace",
  env: { CI: "1" },
  timeoutMs: 10_000,
});
```

The shell uses just-bash, not the host operating system shell. Commands operate on `AcceleratedJustBashFs` and therefore commit changes through the core WAL.

## Flue sandbox adapter

Use the Flue subpath export:

```ts
import { acceleratedFsSandbox } from "s3-bun-cached-fs/flue";
```

```ts
const sandbox = acceleratedFsSandbox({
  cwd: "/workspace",
  mount: {
    name: "flue-workspace",
    mode: "readwrite",
    bucket: "my-bucket",
    prefix: "flue/workspaces/customer-123",
    region: "eu-central-1",
    cacheBytes: 500 * 1024 * 1024,
  },
  managerConfig: { cacheRoot: "/tmp/accelerated-fs-flue" },
});
```

The returned object implements Flue's `SandboxFactory` shape:

```ts
await sandbox.createSessionEnv({ id: "ctx-id" });
await sandbox.close();
```

The adapter maps Flue filesystem calls to `AcceleratedJustBashFs` and maps `exec()` to `AcceleratedJustBashShell`:

```ts
await api.readFile(path);
await api.readFileBuffer(path);
await api.writeFile(path, content);
await api.stat(path);
await api.readdir(path);
await api.exists(path);
await api.mkdir(path, { recursive });
await api.rm(path, { recursive, force });
await api.exec(command, { cwd, env, timeoutMs, signal });
```

When the adapter creates its own manager from `mount`, `sandbox.close()` closes that manager by default. When an existing `filesystem` is supplied, the application owns it by default unless `closeOnClose: true` is set.

See [`docs/just-bash.md`](just-bash.md), [`docs/flue-accelerated-fs.md`](flue-accelerated-fs.md), and [`docs/adapters.md`](adapters.md).

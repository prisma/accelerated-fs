# Mastra provider: AcceleratedFS

`AcceleratedFS` is a Mastra `WorkspaceFilesystem` provider backed by `S3CachedFs`.

It gives Mastra agents the normal workspace file operations while keeping the underlying storage model optimized for large S3-compatible datasets, small-file batches, and constrained local disks.

## When to use it

Use `AcceleratedFS` when a Mastra workspace needs:

- a remote S3-compatible workspace larger than local ephemeral disk
- low-latency `stat()` and `readdir()` from SQLite metadata
- write-through durability to object storage
- many-readers / single-writer semantics
- efficient small-file creation through pack objects
- explicit lifecycle cleanup through `destroy()` / `close()`

Do not use it as a drop-in kernel mount. It is a Mastra filesystem provider and a TypeScript library. It does not expose arbitrary files as host OS paths unless the application explicitly calls `materialize()`.

## Basic usage

```ts
import { Agent } from "@mastra/core/agent";
import { Workspace } from "@mastra/core/workspace";
import { AcceleratedFS } from "s3-bun-cached-fs";

const filesystem = new AcceleratedFS({
  id: "project-data",
  bucket: "my-bucket",
  prefix: "workspaces/project-data",
  region: "eu-central-1",
  cacheRoot: "/tmp/accelerated-fs",
  cacheBytes: 500 * 1024 * 1024,
});

const workspace = new Workspace({ filesystem });

export const agent = new Agent({
  id: "file-agent",
  model: "openai/gpt-5.5",
  workspace,
});
```

`AcceleratedFS` lazily initializes on the first operation, but it also supports Mastra's optional lifecycle methods:

```ts
await filesystem.init();
// use the workspace
await filesystem.destroy();
```

`destroy()` closes the underlying `S3CachedFs` mount. For a readwrite mount that means pending writes, the remote WAL, and the metadata snapshot are flushed before the writer lease is released.

## Constructor options

`AcceleratedFSOptions` extends the remote `MountConfig` used by `S3CachedFs`, except that `name`, `mode`, and `cacheBytes` are adapted for Mastra.

Important options:

| Option | Meaning |
| --- | --- |
| `id` | Mastra filesystem id. Defaults to `crypto.randomUUID()`. |
| `mountName` | Internal `S3CachedFs` mount name. Defaults to `id`. |
| `bucket` | S3 bucket. Optional when using a custom `storeFactory`. |
| `prefix` | Remote workspace prefix inside the bucket. |
| `region`, `endpoint`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `forcePathStyle` | S3 connection settings. |
| `cacheRoot` | Local cache root. Required unless `manager` or `filesystem` is supplied. |
| `cacheBytes` | Local cache budget for this mount. Required unless `filesystem` is supplied. |
| `readOnly` | Mount in readonly mode and reject write operations. |
| `mode` | Explicit `"readonly"` or `"readwrite"`; overrides `readOnly`. |
| `manager` | Reuse an existing `S3CachedFsManager`. |
| `filesystem` | Wrap an already-mounted `S3CachedFs`. |
| `storeFactory` | Override object-store creation for tests or custom S3-compatible backends. |
| `instructions` | Custom Mastra workspace instructions string or function. |

The low-level performance options from `MountConfig` are also supported: `chunkBytes`, `smallFileBytes`, `packBytes`, `snapshotWalBytes`, `snapshotTxCount`, `materializeMaxBytes`, `cacheReserveBytes`, `lockTtlMs`, `lockRenewMs`, and `readAheadChunks`.

## Mastra contract mapping

`AcceleratedFS` implements the structural `WorkspaceFilesystem` shape without importing `@mastra/core` at runtime.

| Mastra method | AcceleratedFS behavior |
| --- | --- |
| `readFile(path, options?)` | Returns UTF-8 text by default. Returns `Buffer` when `encoding: "binary"`. Also supports optional `startLine` / `endLine` convenience options. |
| `writeFile(path, content, options?)` | Whole-file write-through replace. Honors `recursive`, `overwrite`, and `expectedMtime`. |
| `appendFile(path, content)` | Read-modify-write append. Creates parent directories automatically, matching Mastra's documented behavior. |
| `deleteFile(path, options?)` | Removes a file. `force` suppresses missing-file errors. Directories must use `rmdir()`. |
| `copyFile(src, dest, options?)` | Copies file content and metadata. Also supports recursive directory copy as an extension. |
| `moveFile(src, dest, options?)` | Atomic metadata rename/move inside the same AcceleratedFS mount. |
| `mkdir(path, options?)` | Creates directories; `recursive` creates parents. |
| `rmdir(path, options?)` | Removes directories; non-recursive calls fail on non-empty directories. |
| `readdir(path, options?)` | Lists directory entries from SQLite metadata. Supports `recursive`, `maxDepth`, `extension`, `glob`, and `pattern`. |
| `exists(path)` | SQLite metadata existence check. |
| `stat(path)` | Returns Mastra `FileStat` shape with `name`, `path`, `type`, `size`, `createdAt`, `modifiedAt`, and best-effort `mimeType`. |
| `init()` | Opens or mounts the underlying cached filesystem. |
| `destroy()` | Closes the underlying filesystem/manager and flushes remote state. |
| `getInfo()` | Returns Mastra metadata including id, name, provider, base path, read-only flag, status, and cache budget. |
| `getInstructions(opts?)` | Returns provider-specific workspace instructions or a configured override. |

`AcceleratedFS` also exposes a `grep(pattern, options?)` helper because Mastra workspace tools include regex content search. The helper walks metadata, reads matching files through the cache, and returns line/column matches with optional context. It supports `path`, `include` / `glob`, `exclude`, `extension`, `caseSensitive`, `contextLines`, `maxCount`, `maxResults`, `encoding`, and `includeHidden`.

## Additional accelerated APIs

These methods are not required by Mastra, but are useful for high-performance application code:

```ts
await filesystem.refresh();
const bytes = await filesystem.readRange("/large.bin", 16 * 1024 * 1024, 1024 * 1024);
const stream = filesystem.stream("/large.bin");
const lease = await filesystem.materialize("/config.json");
const handle = await filesystem.openWrite("/results/out.bin");
await filesystem.transaction(async tx => {
  await tx.writeFile("/many-small-files/a.json", "{}");
});
const inner = await filesystem.underlying();
```

Use `transaction()` for many small files. Mastra's generic `writeFile()` method is durable per call, which is correct but can be expensive if repeated thousands of times.

## Guarantees inherited from S3CachedFs

`AcceleratedFS` inherits the storage guarantees of `S3CachedFs`:

- many readers and one fenced writer
- write-through commits to S3-compatible object storage
- immutable data objects
- remote application WAL for metadata
- local SQLite metadata for fast namespace operations
- atomic visibility through the remote head pointer
- bounded local cache with LRU eviction
- strict `close()` / `destroy()` flush semantics

Readers either observe the previous committed metadata snapshot or the next committed metadata snapshot. They do not observe half-written files.

## Read-only mode

```ts
const filesystem = new AcceleratedFS({
  bucket: "my-bucket",
  prefix: "published/docs",
  cacheRoot: "/tmp/accelerated-fs-reader",
  cacheBytes: 256 * 1024 * 1024,
  readOnly: true,
});
```

Readonly providers expose reads, stats, listing, search, range reads, streams, and materialization. Mutating methods throw `AcceleratedFSReadonlyFilesystemError`.

## Sandbox behavior

`resolveAbsolutePath()` returns `undefined` because arbitrary remote files do not have stable host paths. A file exists on local disk only after explicit materialization:

```ts
const lease = await filesystem.materialize("/inputs/config.json");
try {
  console.log(lease.path); // real local cache path
  await Bun.write("/tmp/copy.json", lease.file);
} finally {
  await lease.release();
}
```

Do not let sandbox commands mutate files inside `cacheRoot` directly. Those writes bypass the remote WAL and will not be committed.

## Error classes

The provider exports Mastra-oriented error classes:

- `AcceleratedFSError`
- `FileNotFoundError` / `AcceleratedFSFileNotFoundError`
- `DirectoryNotFoundError` / `AcceleratedFSDirectoryNotFoundError`
- `FileExistsError` / `AcceleratedFSFileExistsError`
- `AcceleratedFSIsDirectoryError`
- `AcceleratedFSNotDirectoryError`
- `DirectoryNotEmptyError` / `AcceleratedFSDirectoryNotEmptyError`
- `AcceleratedFSReadonlyFilesystemError` / `AcceleratedFSReadonlyError`
- `StaleFileError`

Each provider error has a stable `code` such as `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EROFS`, or `ESTALE`.

## Testing with LocalObjectStore

```ts
import { AcceleratedFS, LocalObjectStore } from "s3-bun-cached-fs";

const store = new LocalObjectStore("/tmp/accelerated-fs-objects");
const filesystem = new AcceleratedFS({
  id: "test",
  cacheRoot: "/tmp/accelerated-fs-cache",
  cacheBytes: 64 * 1024 * 1024,
  storeFactory: () => store,
});

await filesystem.writeFile("/hello.txt", "hello", { recursive: true });
console.log(await filesystem.readFile("/hello.txt"));
await filesystem.destroy();
```

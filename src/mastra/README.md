# Mastra Adapter

`s3-bun-cached-fs/mastra` exports `AcceleratedFS`, a Mastra workspace filesystem provider backed by the core S3/object-store virtual filesystem.

The value proposition: Mastra agents get normal workspace file operations while the backing workspace can live durably in S3-compatible object storage, exceed local ephemeral disk, and still serve metadata-heavy operations from local SQLite.

## Why Use It

Use `AcceleratedFS` when a Mastra workspace needs:

- remote durable storage for agent inputs, outputs, and working state
- fast `stat()`, `exists()`, and `readdir()` from local metadata
- bounded local cache instead of requiring the full workspace on disk
- write-through commits that publish atomically through the core WAL/head protocol
- efficient transactions for application code that creates many small files
- readonly readers over a published workspace

Do not use it when the agent needs a real host directory or arbitrary host process access. This is a Mastra filesystem provider, not a FUSE mount.

## Install

```bash
bun add s3-bun-cached-fs
```

Your application supplies Mastra. The adapter is structural and does not import `@mastra/core` at runtime.

## Basic Wiring

```ts
import { Workspace } from "@mastra/core/workspace";
import { AcceleratedFS } from "s3-bun-cached-fs/mastra";

const filesystem = new AcceleratedFS({
  id: "project-data",
  bucket: "my-bucket",
  prefix: "workspaces/project-data",
  region: "us-east-1",
  cacheRoot: "/tmp/accelerated-fs-mastra",
  cacheBytes: 500 * 1024 * 1024,
});

const workspace = new Workspace({ filesystem });
```

`AcceleratedFS` lazily initializes on the first operation. You can also call lifecycle methods explicitly:

```ts
await filesystem.init();
await filesystem.writeFile("/notes/summary.md", "# Summary\n", { recursive: true });
await filesystem.destroy();
```

`destroy()` closes the underlying mount. On readwrite mounts, that flushes open handles, publishes a final snapshot, and releases the writer lease.

## Mastra Surface

The provider implements the common workspace filesystem shape:

```ts
await filesystem.readFile(path, options);
await filesystem.writeFile(path, content, options);
await filesystem.appendFile(path, content);
await filesystem.deleteFile(path, options);
await filesystem.copyFile(src, dest, options);
await filesystem.moveFile(src, dest, options);
await filesystem.readdir(path, options);
await filesystem.mkdir(path, options);
await filesystem.rmdir(path, options);
await filesystem.exists(path);
await filesystem.stat(path);
await filesystem.grep(pattern, options);

filesystem.getInfo();
filesystem.getInstructions({ requestContext });
```

Reads return UTF-8 text by default and `Buffer` when `encoding: "binary"` is requested. `readdir()` supports recursive listing, extension filtering, and glob-style filters. `grep()` walks the AcceleratedFS namespace and returns line/column matches with optional context.

## Accelerated Extras

Application code can reach below the generic Mastra surface when performance matters:

```ts
await filesystem.refresh();
const bytes = await filesystem.readRange("/large.bin", 0, 64 * 1024);
const stream = filesystem.stream("/large.bin");
const lease = await filesystem.materialize("/config.json");
const core = await filesystem.underlying();

await filesystem.transaction(async tx => {
  await tx.writeFile("/shards/0.json", "{}");
});
```

Use `transaction()` for bulk small-file writes. Mastra's generic `writeFile()` is intentionally durable per call.

## Local Demo

Run the self-contained demo from the repository root:

```bash
bun run demo:mastra
```

It uses `LocalObjectStore`, creates a structural workspace-like object, writes files, searches content, and verifies range reads without requiring Mastra or AWS credentials.

## Readonly Mode

```ts
const filesystem = new AcceleratedFS({
  bucket: "my-bucket",
  prefix: "published/workspace",
  cacheRoot: "/tmp/accelerated-reader",
  cacheBytes: 256 * 1024 * 1024,
  readOnly: true,
});
```

Readonly providers support reads, stats, listings, search, range reads, streams, and materialization. Mutating methods throw `AcceleratedFSReadonlyFilesystemError`.

## Caveats

- `resolveAbsolutePath()` returns `undefined`; arbitrary remote files are not stable host paths.
- A file exists on disk only after explicit `materialize()`, and the returned lease should be released.
- The core protocol supports one active writer and many readers, not multi-writer merge.
- The local cache is disposable. Durable state is in the object store.

Full reference: [`../../docs/mastra-accelerated-fs.md`](../../docs/mastra-accelerated-fs.md).

# s3-bun-cached-fs

`s3-bun-cached-fs` is a Bun-native virtual filesystem for agent workspaces and data-heavy serverless jobs. It stores durable state in S3-compatible object storage, keeps a bounded local cache for hot bytes, and uses local SQLite metadata so `stat()`, `exists()`, and `readdir()` stay fast even when the workspace is much larger than local disk.

The core value is simple: agents and applications get a filesystem-shaped API over remote object storage without a FUSE mount, without giving shell tools access to the host filesystem, and without paying one remote metadata round trip for every namespace operation.

## What It Solves

Use this when you need:

- S3-compatible durable storage for workspaces, generated artifacts, datasets, or job outputs
- local performance from a disposable cache on Lambda-style or other ephemeral disks
- fast metadata operations from SQLite instead of repeated object-store listing
- write-through durability with atomic visibility at commit boundaries
- efficient bulk creation of small files through pack objects
- range reads, streaming, and explicit materialization to real local `BunFile` objects
- one fenced writer with many readonly readers
- adapters for Mastra, just-bash, and Flue that all commit through the same WAL

This is not a kernel mount and not a POSIX replacement. It is a library-level virtual filesystem designed for Bun runtimes.

## Four Public Projects

This repository is intentionally one npm package with four public surfaces. Keeping them together matters because every adapter must write through the same core metadata WAL and cache protocol.

| Project | Import | Source | Purpose |
| --- | --- | --- | --- |
| Core filesystem | `s3-bun-cached-fs/core` | `src/`, `src/stores/` | S3/object-store backed virtual filesystem, metadata WAL, SQLite namespace, cache, range reads, materialization |
| Mastra adapter | `s3-bun-cached-fs/mastra` | `src/mastra/` | Mastra `WorkspaceFilesystem` provider shape with accelerated extras |
| just-bash adapter | `s3-bun-cached-fs/just-bash` | `src/just-bash/` | just-bash filesystem wrapper and shell helper backed by the core filesystem |
| Flue adapter | `s3-bun-cached-fs/flue` | `src/flue/` | Flue sandbox factory using the core filesystem for files and just-bash for `exec()` |

The root import also re-exports all surfaces for convenience:

```ts
import {
  S3CachedFsManagerImpl,
  AcceleratedFS,
  AcceleratedJustBashFs,
  createAcceleratedJustBashShell,
  acceleratedFsSandbox,
} from "s3-bun-cached-fs";
```

For libraries, prefer subpath imports so optional adapter dependencies stay isolated.

## Install

```bash
bun add s3-bun-cached-fs
```

For local development from this repository:

```bash
bun install
bun test
bun run typecheck
```

The core package uses Bun APIs including `Bun.file`, `Bun.write`, and `bun:sqlite`.

## Core Quick Start

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";

const manager = new S3CachedFsManagerImpl({ cacheRoot: "/tmp/accelerated-fs" });

const fs = await manager.mount({
  name: "dataset",
  mode: "readwrite",
  bucket: "my-bucket",
  prefix: "datasets/prod",
  region: "us-east-1",
  cacheBytes: 500 * 1024 * 1024,
});

await fs.writeFile("/config.json", JSON.stringify({ ok: true }));
console.log(await fs.readText("/config.json"));

const handle = await fs.openWrite("/results/out.txt");
await Bun.write(handle.file, "written through a real local BunFile");
await handle.close();

await fs.close();
```

The default backend is `S3ObjectStore`, which signs S3 requests with SigV4 and uses conditional writes for commits. Tests and demos use `LocalObjectStore`, which maps object keys to local files and enforces the same precondition behavior.

## Transactions

Use `transaction()` when creating many small files. The transaction produces one remote metadata WAL commit and usually one or a small number of pack objects.

```ts
await fs.transaction(async tx => {
  await tx.mkdir("/shards", { recursive: true });
  for (let i = 0; i < 10_000; i++) {
    await tx.writeFile(`/shards/${i}.json`, JSON.stringify({ i }));
  }
});
```

Calling `writeFile()` 10,000 times is still correct and durable, but it intentionally performs 10,000 commits.

## Mastra Adapter

```ts
import { Workspace } from "@mastra/core/workspace";
import { AcceleratedFS } from "s3-bun-cached-fs/mastra";

const filesystem = new AcceleratedFS({
  id: "workspace-data",
  bucket: "my-bucket",
  prefix: "mastra/workspaces/workspace-data",
  region: "us-east-1",
  cacheRoot: "/tmp/mastra-cache",
  cacheBytes: 500 * 1024 * 1024,
});

const workspace = new Workspace({ filesystem });
```

`AcceleratedFS` is structural and does not import Mastra at runtime. Your Mastra app owns the Mastra dependency; this package supplies the filesystem provider shape.

Read the adapter README: [`src/mastra/README.md`](src/mastra/README.md).

## just-bash Adapter

```ts
import { createAcceleratedJustBashShell } from "s3-bun-cached-fs/just-bash";

const shell = await createAcceleratedJustBashShell({
  filesystem: fs,
  cwd: "/workspace",
});

await shell.exec("mkdir -p reports");
await shell.exec("echo hello > reports/out.txt");
console.log((await shell.exec("cat reports/out.txt")).stdout);
```

Commands run through just-bash, not through the host operating system. They see the virtual filesystem and commit changes through the core WAL.

Read the adapter README: [`src/just-bash/README.md`](src/just-bash/README.md).

## Flue Adapter

```ts
import { createAgent } from "@flue/runtime";
import { acceleratedFsSandbox } from "s3-bun-cached-fs/flue";

export default createAgent(() => ({
  model: "anthropic/claude-sonnet-4-6",
  sandbox: acceleratedFsSandbox({
    cwd: "/workspace",
    mount: {
      name: "flue-workspace",
      mode: "readwrite",
      bucket: "my-bucket",
      prefix: "flue/workspaces/customer-123",
      region: "us-east-1",
      cacheBytes: 500 * 1024 * 1024,
    },
    managerConfig: { cacheRoot: "/tmp/accelerated-fs-flue" },
  }),
  cwd: "/workspace",
}));
```

Flue file operations go through `AcceleratedJustBashFs`; `exec()` goes through `AcceleratedJustBashShell`.

Read the adapter README: [`src/flue/README.md`](src/flue/README.md).

## Demo Apps

The repository includes four runnable demos. They use `LocalObjectStore`, so they do not require AWS credentials or external services. The adapter demos inject tiny framework-compatible shims where optional peer packages would normally be supplied by the application.

```bash
bun run demo:core
bun run demo:mastra
bun run demo:just-bash
bun run demo:flue
bun run demo:all
```

Demo sources:

- [`demos/core.ts`](demos/core.ts)
- [`demos/mastra.ts`](demos/mastra.ts)
- [`demos/just-bash.ts`](demos/just-bash.ts)
- [`demos/flue.ts`](demos/flue.ts)

The test suite imports and runs all four demos in [`test/demo-apps.test.ts`](test/demo-apps.test.ts).

## Guarantees

The core filesystem provides:

- many readonly mounts and one fenced readwrite mount
- immutable content objects for large-file chunks
- pack objects for efficient small-file transactions
- remote metadata WAL persisted before head publication
- atomic visibility through `heads/main.json`
- local SQLite metadata rebuild from snapshots and WAL
- bounded local LRU cache with materialized-file pinning
- disposable cache semantics: losing cache does not lose durable data

See [`docs/guarantees.md`](docs/guarantees.md), [`docs/recovery.md`](docs/recovery.md), and [`docs/s3-layout.md`](docs/s3-layout.md).

For provider-specific setup and benchmark results against Tigris and Cloudflare R2, see [`docs/object-store-providers.md`](docs/object-store-providers.md).

## Tests

```bash
bun test
bun run typecheck
```

Covered areas include core reads/writes, range reads, small-file packing, readonly remount, reader refresh, materialization, metadata operations, writer fencing, Mastra operations, just-bash filesystem and shell wiring, Flue sandbox wiring, and all four demos.

For production, also run integration tests against your S3-compatible provider, especially conditional writes, ETag behavior, range reads, and ListObjectsV2 pagination.

## Documentation Map

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/api.md`](docs/api.md)
- [`docs/adapters.md`](docs/adapters.md)
- [`docs/mastra-accelerated-fs.md`](docs/mastra-accelerated-fs.md)
- [`docs/just-bash.md`](docs/just-bash.md)
- [`docs/flue-accelerated-fs.md`](docs/flue-accelerated-fs.md)
- [`docs/cache.md`](docs/cache.md)
- [`docs/performance.md`](docs/performance.md)
- [`docs/range-reads.md`](docs/range-reads.md)
- [`docs/recovery.md`](docs/recovery.md)
- [`docs/limitations.md`](docs/limitations.md)
- [`docs/testing.md`](docs/testing.md)

# Adapter and plugin layout

The package is structured as one storage core plus three integration layers:

```text
s3-bun-cached-fs/core
  S3CachedFs, S3CachedFsManagerImpl, object-store backends, metadata WAL,
  cache, range reads, materialization, transactions.

s3-bun-cached-fs/mastra
  AcceleratedFS workspace filesystem provider for Mastra.

s3-bun-cached-fs/just-bash
  AcceleratedJustBashFs and AcceleratedJustBashShell for just-bash.

s3-bun-cached-fs/flue
  acceleratedFsSandbox() for Flue, using AcceleratedJustBashShell for exec().
```

These are four public surfaces in one npm package, not four independent packages. That layout keeps the storage protocol, metadata WAL, cache behavior, and adapter guarantees in one implementation while still giving applications clean subpath imports.

The root import also exports all of these symbols for convenience:

```ts
import {
  S3CachedFsManagerImpl,
  AcceleratedFS,
  AcceleratedJustBashFs,
  acceleratedFsSandbox,
} from "s3-bun-cached-fs";
```

For libraries and applications that want a cleaner dependency boundary, prefer the subpath exports:

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";
import { AcceleratedFS } from "s3-bun-cached-fs/mastra";
import { AcceleratedJustBashFs } from "s3-bun-cached-fs/just-bash";
import { acceleratedFsSandbox } from "s3-bun-cached-fs/flue";
```

## Optional peers

`just-bash` and `@flue/runtime` are optional peer dependencies. They are dynamically imported only when the corresponding adapter needs them.

Install the integrations you use:

```bash
bun add just-bash
bun add @flue/runtime
```

Mastra is also treated structurally: `AcceleratedFS` does not import Mastra at runtime. You pass it into Mastra's workspace API from your application.

## Ownership model

The core filesystem is the source of truth. Adapters should not bypass it.

```text
S3 object storage
  ^
  |
S3CachedFs core
  ^
  +-- Mastra AcceleratedFS
  +-- AcceleratedJustBashFs
        ^
        +-- AcceleratedJustBashShell
              ^
              +-- Flue acceleratedFsSandbox exec()
```

This matters because writes need to go through the core metadata WAL. Writing directly into the local cache directory is not durable and will not update the remote head pointer.

## Runtime assumptions

The core implementation is Bun-native because it uses `Bun.file`, `Bun.write`, and `bun:sqlite`. The adapters are TypeScript wrappers around that Bun-native core. They are intended for Bun runtimes or environments that provide compatible Bun APIs.

The just-bash and Flue integrations run shell commands through just-bash, not through the host operating system. Commands see the S3-backed virtual filesystem through `AcceleratedJustBashFs`.

## Capability matrix

| Capability | Core | Mastra | just-bash | Flue |
| --- | --- | --- | --- | --- |
| S3-backed namespace | Yes | Yes | Yes | Yes |
| Write-through WAL durability | Yes | Yes | Yes | Yes |
| Range reads | Yes | Extra method | Through file reads / core access | Through file reads / core access |
| Real local BunFile materialization | Yes | Extra method | Not exposed to commands | Not exposed to commands |
| Workspace file tools | No | Yes | No | Yes |
| Shell execution | No | No | Yes, simulated bash | Yes, via just-bash |
| Host process execution | No | No | No | No |
| Kernel/POSIX mount | No | No | No | No |

## Choosing an import

Use `s3-bun-cached-fs/core` when your application owns the file operations directly.

Use `s3-bun-cached-fs/mastra` when you need a Mastra workspace filesystem provider.

Use `s3-bun-cached-fs/just-bash` when you want a just-bash filesystem or a just-bash shell backed by S3.

Use `s3-bun-cached-fs/flue` when you want Flue's sandbox API backed by the same S3 filesystem and just-bash shell execution.

## Adapter READMEs and demos

Each adapter directory has a README focused on the value proposition and wiring:

- [`../src/mastra/README.md`](../src/mastra/README.md)
- [`../src/just-bash/README.md`](../src/just-bash/README.md)
- [`../src/flue/README.md`](../src/flue/README.md)

The repository also includes runnable demos for the core and each adapter:

```bash
bun run demo:core
bun run demo:mastra
bun run demo:just-bash
bun run demo:flue
```

The demos use `LocalObjectStore`, so they do not require AWS credentials. Adapter demos inject tiny framework-compatible shims to keep the repository self-contained; production applications normally omit those overrides and use the actual optional peer packages.

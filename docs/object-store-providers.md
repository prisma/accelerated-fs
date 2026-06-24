# Object Store Providers

`s3-bun-cached-fs` stores durable filesystem state in an object store through the `ObjectStore` interface. The default implementation is `S3ObjectStore`, which uses AWS Signature Version 4 over the S3 API.

That means the core filesystem supports AWS S3 and S3-compatible providers that implement the required operations correctly: `HEAD`, `GET`, ranged `GET`, `PUT`, `DELETE`, `ListObjectsV2`, conditional writes with `If-Match` and `If-None-Match`, and stable ETag behavior for conditional updates.

## Supported Providers

| Provider | Status | Region | Endpoint | Notes |
| --- | --- | --- | --- | --- |
| AWS S3 | Supported | Use the bucket region, such as `us-east-1` or `eu-central-1` | Usually omit `endpoint` | Native target for the default `S3ObjectStore`. |
| Cloudflare R2 | Supported | Use `auto` | `https://<account-id>.r2.cloudflarestorage.com` | Works through R2's S3-compatible API. |
| Tigris | Supported | Use `auto` | `https://t3.storage.dev` | Works through Tigris' globally distributed S3-compatible API. |
| MinIO and other S3-compatible stores | Expected to work when S3 semantics match | Provider-specific | Provider-specific | Verify conditional writes, range reads, pagination, and ETags before production use. |
| `LocalObjectStore` | Supported for tests and demos | Not applicable | Local directory | Useful for deterministic tests without network credentials. |

## Common Configuration

```ts
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";

const manager = new S3CachedFsManagerImpl({
  cacheRoot: "/tmp/accelerated-fs",
});

const fs = await manager.mount({
  name: "workspace",
  mode: "readwrite",
  bucket: process.env.AFS_BUCKET!,
  prefix: "workspaces/customer-123",
  region: process.env.AFS_REGION ?? "us-east-1",
  endpoint: process.env.AFS_ENDPOINT,
  accessKeyId: process.env.AFS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AFS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AFS_SESSION_TOKEN,
  cacheBytes: 500 * 1024 * 1024,
});
```

Credentials can be supplied on the mount config. If `accessKeyId` or `secretAccessKey` are omitted, `S3ObjectStore` falls back to `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`.

When `endpoint` is set, `S3ObjectStore` defaults to path-style addressing. You can override that with `forcePathStyle` if your provider requires virtual-hosted style URLs.

## AWS S3

AWS S3 is the default target. Usually omit `endpoint` and set `region` to the bucket's actual AWS region.

```ts
const fs = await manager.mount({
  name: "s3-workspace",
  mode: "readwrite",
  bucket: "my-s3-bucket",
  prefix: "accelerated-fs/prod/workspace-1",
  region: "eu-central-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  cacheBytes: 500 * 1024 * 1024,
});
```

Equivalent environment setup:

```bash
export AFS_BUCKET=my-s3-bucket
export AFS_REGION=eu-central-1
export AFS_ACCESS_KEY_ID=...
export AFS_SECRET_ACCESS_KEY=...
```

## Cloudflare R2

R2 uses an account-scoped S3 endpoint and the `auto` region.

```ts
const fs = await manager.mount({
  name: "r2-workspace",
  mode: "readwrite",
  bucket: "my-r2-bucket",
  prefix: "accelerated-fs/prod/workspace-1",
  region: "auto",
  endpoint: "https://<account-id>.r2.cloudflarestorage.com",
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  cacheBytes: 500 * 1024 * 1024,
});
```

Equivalent environment setup:

```bash
export AFS_BUCKET=my-r2-bucket
export AFS_REGION=auto
export AFS_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export AFS_ACCESS_KEY_ID=...
export AFS_SECRET_ACCESS_KEY=...
```

## Tigris

Tigris uses the global S3-compatible endpoint and the `auto` region.

```ts
const fs = await manager.mount({
  name: "tigris-workspace",
  mode: "readwrite",
  bucket: "my-tigris-bucket",
  prefix: "accelerated-fs/prod/workspace-1",
  region: "auto",
  endpoint: "https://t3.storage.dev",
  accessKeyId: process.env.TIGRIS_ACCESS_KEY_ID,
  secretAccessKey: process.env.TIGRIS_SECRET_ACCESS_KEY,
  cacheBytes: 500 * 1024 * 1024,
});
```

Equivalent environment setup:

```bash
export AFS_BUCKET=my-tigris-bucket
export AFS_REGION=auto
export AFS_ENDPOINT=https://t3.storage.dev
export AFS_ACCESS_KEY_ID=...
export AFS_SECRET_ACCESS_KEY=...
```

## LocalObjectStore

Use `LocalObjectStore` when tests or demos need the same object-store semantics without external infrastructure.

```ts
import { LocalObjectStore } from "s3-bun-cached-fs/stores/local-object-store";
import { S3CachedFsManagerImpl } from "s3-bun-cached-fs/core";

const manager = new S3CachedFsManagerImpl({
  cacheRoot: "/tmp/accelerated-fs-cache",
  storeFactory: () => new LocalObjectStore("/tmp/accelerated-fs-objects"),
});

const fs = await manager.mount({
  name: "local",
  mode: "readwrite",
  cacheBytes: 128 * 1024 * 1024,
});
```

`LocalObjectStore` is not a production durability layer. It is a test backend that enforces the same conditional-write behavior the core filesystem relies on.

## Provider Validation Checklist

Before using a new S3-compatible provider in production, verify:

- `If-None-Match: *` prevents overwriting existing objects.
- `If-Match` rejects stale writes to `heads/main.json`.
- `HEAD` returns an ETag that can be used in `If-Match`.
- ranged `GET` returns the requested byte range.
- `ListObjectsV2` pagination works for the `wal/` prefix.
- object keys with slashes are preserved exactly under the configured prefix.

The core tests cover these semantics against `LocalObjectStore`; provider integration tests should run against the actual storage backend.

## Benchmark

The benchmark app runs on Prisma Compute in Frankfurt (`eu-central-1`) and mounts the same filesystem implementation against two S3-compatible providers:

- Tigris: global bucket, endpoint `https://t3.storage.dev`, region `auto`
- Tigris instant retrieval archive bucket, endpoint `https://t3.storage.dev`, region `auto`
- Cloudflare R2: WEUR bucket, account endpoint, region `auto`

Both deployments used the same Prisma Compute app code, the same benchmark seed, a `100 MiB` local cache cap, `4 MiB` pack objects, and `10 KiB` files. The benchmark first inserts the requested dataset, then runs `1000` random reads and `1000` random writes as one intermingled serial operation stream. The initial insert is batched at `400` files per transaction so the setup phase measures bulk creation instead of one remote metadata commit per file. The mixed phase is intentionally serial and performs one filesystem operation at a time.

Benchmark code:

- Deployed Prisma Compute app: [`apps/load-test/server.ts`](../apps/load-test/server.ts)
- Example entrypoint: [`examples/prisma-compute-load-test.ts`](../examples/prisma-compute-load-test.ts)

| Provider | Data size | Files | Insert time | 1000 random reads + 1000 random writes |
| --- | ---: | ---: | ---: | ---: |
| Tigris | 50 MiB | 5,120 | 3.341s | 103.953s |
| Tigris | 500 MiB | 51,200 | 34.031s | 186.718s |
| Tigris | 5 GiB | 524,288 | 320.265s | 254.835s |
| Tigris instant retrieval archive | 50 MiB | 5,120 | 3.707s | 163.481s |
| Tigris instant retrieval archive | 500 MiB | 51,200 | 33.544s | 251.996s |
| Tigris instant retrieval archive | 5 GiB | 524,288 | 367.727s | 316.926s |
| Cloudflare R2 | 50 MiB | 5,120 | 8.262s | 541.766s |
| Cloudflare R2 | 500 MiB | 51,200 | 108.684s | 735.996s |
| Cloudflare R2 | 5 GiB | 524,288 | 1003.271s | 899.608s |

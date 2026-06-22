# Architecture

`s3-bun-cached-fs` is a library-level virtual filesystem. It presents filesystem-like operations while storing durable state in S3-compatible object storage.

It deliberately avoids a FUSE/kernel mount. In a pure TypeScript Bun environment, the reliable integration point is local files: reads can be returned as bytes, streams, or materialized local `BunFile` objects; writes can be staged to a real local file and then committed to S3.

## Components

```text
application
  |
  v
S3CachedFs API
  |
  +-- local SQLite namespace metadata
  +-- local bounded cache
  +-- object-store abstraction
        |
        +-- S3ObjectStore using TypeScript SigV4 + fetch
        +-- LocalObjectStore for tests/dev
```

## Remote layout

```text
<prefix>/
  format.json
  heads/main.json
  locks/writer.json
  snapshots/<snapshot-id>/meta.sqlite
  snapshots/<snapshot-id>/manifest.json
  wal/<seq>-<txid>.json
  blobs/sha256/<prefix>/<sha256>
  packs/YYYY/MM/DD/<txid>-000000.pack
```

Only `heads/main.json` publishes a new filesystem state. Data objects and WAL records are immutable. A reader either sees the old head or the new head.

## Local layout

```text
<cacheRoot>/<mount-name>/
  meta.sqlite
  meta.sqlite-wal
  meta.sqlite-shm
  objects/<hash-prefix>/<hash>
  materialized/<inode>@<version>
  tmp/<writer-id>/<uuid>
```

SQLite stores the directory tree, file extents, object references, cache entries, and applied remote transactions.

## Metadata model

The namespace is inode-like:

- `inode` stores kind, mode, size, mtimes, and version.
- `dirent` maps parent inode + name to child inode.
- `extent` maps file versions to immutable object ranges.
- `object_ref` tracks referenced blob and pack objects.
- `remote_tx` tracks applied S3 WAL records.

A file replace creates a new file version and new extents. Old extents are dereferenced locally. Remote garbage collection is intentionally not automatic in this implementation; see `limitations.md`.

## Data model

Large files are split into content-addressed chunks:

```text
blobs/sha256/ab/abcdef...
```

Small files are concatenated into pack objects:

```text
packs/2026/06/21/<txid>-000000.pack
```

Each file extent records object key, byte offset, byte length, and SHA-256.

## Commit pipeline

A write transaction commits in this order:

1. Stage local bytes.
2. Upload immutable blob or pack objects.
3. Upload a remote WAL record with `If-None-Match: *`.
4. Publish `heads/main.json` with `If-Match: <previous-head-etag>`.
5. Apply the same WAL record to local SQLite.

If the process crashes before the head update, readers do not see the new state. If it crashes after the head update, a later mount replays the WAL.

## Snapshot pipeline

A snapshot is a serialized SQLite database uploaded to `snapshots/`. Publishing a snapshot updates `heads/main.json` without changing the logical transaction sequence. Snapshots make remount faster because the reader only needs to replay WAL after the snapshot sequence.

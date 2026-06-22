# S3 layout

Assume the mount prefix is `datasets/prod`.

```text
s3://bucket/datasets/prod/format.json
s3://bucket/datasets/prod/heads/main.json
s3://bucket/datasets/prod/locks/writer.json
s3://bucket/datasets/prod/snapshots/snap-000000000000000123/meta.sqlite
s3://bucket/datasets/prod/snapshots/snap-000000000000000123/manifest.json
s3://bucket/datasets/prod/wal/000000000000000124-<txid>.json
s3://bucket/datasets/prod/blobs/sha256/ab/<hash>
s3://bucket/datasets/prod/packs/2026/06/21/<txid>-000000.pack
```

## `format.json`

Created once during filesystem initialization. It records the format version and filesystem id.

## `heads/main.json`

The current publish pointer. It contains:

- filesystem id
- current sequence
- current transaction id
- latest WAL key
- latest snapshot key
- latest snapshot sequence
- checksum

Every visible change is published by conditionally replacing this object.

## `wal/`

Application WAL records. The WAL is independent of SQLite's local WAL mode. It is the durable cross-process metadata log.

## `snapshots/`

Serialized SQLite databases plus a manifest. Snapshots reduce remount time.

## `blobs/`

Content-addressed large-file chunks.

## `packs/`

Concatenated small-file content. Extents point into byte ranges inside a pack.

## `locks/`

Best-effort writer lease. The head object's conditional update is still the authoritative fencing mechanism.

# Range reads and streaming

Large-file access is built around extents.

A file is represented as an ordered list of logical byte ranges:

```text
logical file range -> object key + object offset + object length
```

For large files, extents usually point to content-addressed chunk objects. For small files, extents point to byte ranges inside pack objects.

## `readRange(path, offset, length)`

The algorithm is:

1. Look up the file inode and version in SQLite.
2. Query extents intersecting `[offset, offset + length)`.
3. For each extent, fetch or reuse the cached object.
4. Copy the requested byte range into the result buffer.

A range can cross multiple chunks or packs. The caller receives exactly the bytes requested, clamped to EOF.

## Object cache behavior

The current implementation caches full backing objects, not arbitrary partial object fragments. That means:

- a first read from a 16 MiB pack may download the 16 MiB pack;
- subsequent reads from files in that pack are local;
- a first read from an 8 MiB chunk downloads that chunk;
- sequential reads benefit from cache reuse naturally.

This is the right default for many small files and serverless workloads because it avoids an explosion of tiny range cache entries. If your workload does very sparse random reads over huge objects, add a partial-object cache layer.

## `stream(path)`

`stream()` returns a `ReadableStream<Uint8Array>`. It repeatedly calls `readRange()` using the configured chunk size. It is the preferred API for files that are too large to materialize locally.

## `materialize(path)`

`materialize()` assembles the full file in the local cache and returns a `BunFile`. It enforces `materializeMaxBytes` unless `{ allowLarge: true }` is supplied.

Use materialization only when a downstream library requires a real local file path or a `BunFile`.

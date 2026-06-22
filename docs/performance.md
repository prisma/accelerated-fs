# Performance notes

## Small files

Use `transaction()` for small-file bulk writes. One transaction means:

- one SQLite transaction,
- one or a few pack objects,
- one metadata WAL object,
- one head update.

Calling `writeFile()` 10,000 times is durable and correct, but it intentionally performs 10,000 commits.

## Large files

Large files are chunked. The default chunk size is 8 MiB. Reads use extent lookup and cache the backing chunks.

For large writes, prefer `openWrite()` and `Bun.write(handle.file, source)` so the file is staged locally and then streamed into chunks during commit.

## Metadata

Directory listing and stat operations use local SQLite. They do not call S3 after mount/refresh.

## Snapshots

Frequent snapshots improve cold mount time but add extra S3 writes. Serverless workloads often benefit from snapshotting on close. Long-running workers can use larger `snapshotTxCount` values.

## Cache sizing

Reserve some cache space with `cacheReserveBytes` so metadata, temporary files, and small operational files are not squeezed out by large object reads.

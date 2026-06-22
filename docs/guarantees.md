# Guarantees

## Supported consistency model

The filesystem supports:

- many concurrent readonly mounts
- one readwrite mount
- atomic visibility at commit boundaries
- write-through durability to S3 before a write call resolves
- metadata recovery from S3 snapshots and WAL
- cache loss without data loss

The implementation is not POSIX. It is a transactional virtual filesystem over S3.

## Atomic visibility

A commit becomes visible only when `heads/main.json` is successfully updated. Data objects and WAL objects are written first, but they are not visible to normal readers until the head points to the transaction.

Readers that do not call `refresh()` keep their local snapshot. Readers that call `refresh()` move from one complete head to another complete head.

## Durability

For `writeFile()`, `transaction()`, `mkdir()`, `rm()`, and `rename()`, the promise resolves only after:

1. referenced data objects are uploaded,
2. the metadata WAL record is uploaded,
3. the head object is conditionally updated,
4. the local SQLite metadata is updated.

`openWrite()` is durable only after `handle.close()` resolves. Calling `fs.close()` auto-commits any still-open write handles before closing.

## Single writer fencing

A readwrite mount acquires `locks/writer.json` with a conditional create. The lease is periodically renewed with conditional replacement. The final protection is the conditional update of `heads/main.json`; even if the lease expires or a stale process continues, a stale writer cannot overwrite a newer head without the previous head ETag.

## Reader behavior

Readonly mounts do not lock. They load the latest published head, download the snapshot, and replay WAL. A readonly mount can later call `refresh()` to observe newer commits.

## Cache guarantees

The local cache is disposable. Losing the cache does not lose durable data because file content, snapshots, WAL, and the head pointer are in S3.

Pinned materialized files are not evicted until released. Dirty temporary write handles are not part of the clean cache and are committed or removed on close.

## Crash cases

| Crash point | Result |
|---|---|
| before data upload | no visible change |
| after data upload, before WAL | orphan data object; not visible |
| after WAL, before head | orphan WAL/data; not visible |
| after head, before local SQLite apply | remount or refresh replays WAL |
| after local SQLite apply | commit complete |


## Adapter guarantees

Mastra, just-bash, and Flue writes inherit the same durability model when they call into `S3CachedFs`. A successful adapter write means the core commit has reached the remote WAL and head pointer.

For Flue, shell execution is handled by just-bash. Command-created files are durable when the command returns successfully because the just-bash filesystem wrapper writes through `S3CachedFs`. A command timeout or abort may leave only the successfully completed operations visible; the core still never publishes half of an individual metadata transaction.

## What is not guaranteed

The implementation does not provide mmap, true hard links, advisory locks, kernel path interception, cross-mount atomic rename, multi-writer conflict resolution, host shell process execution, or in-place random writes.

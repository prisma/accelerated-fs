# Recovery

The filesystem treats S3 as the durable source of truth and the local cache as disposable.

## Mount recovery

On mount, the implementation reads `heads/main.json`.

If the local SQLite database already matches the head checksum, it is reused. Otherwise:

1. delete local SQLite sidecars,
2. download the head snapshot database,
3. open it with `bun:sqlite`,
4. replay WAL records after the snapshot sequence,
5. persist the local head metadata.

## WAL replay

WAL records are idempotent. `remote_tx` stores applied transaction sequence numbers. If a WAL record has already been applied, replay skips it.

Each WAL record includes:

- sequence number
- transaction id
- parent transaction id
- writer id
- object references
- metadata operations
- checksum

Checksum failure aborts mount or refresh.

## Head conflicts

A writer publishes a commit with `If-Match` against the previously observed head ETag. If the head changed, the commit fails. The implementation reports `EAGAIN` instead of trying to merge, because the supported concurrency model is single writer.

## Snapshot recovery

Snapshots are serialized SQLite images. A snapshot head can be published without changing the logical transaction sequence. Readers using an older snapshot can still replay WAL; readers mounting later can start from the newer snapshot.

## Orphans

The following objects can become orphaned after a crash or failed CAS:

- uploaded blobs not referenced by a published head
- uploaded packs not referenced by a published head
- WAL records not referenced by a published head
- old snapshots

They are harmless but consume storage. A production deployment should add a mark-and-sweep garbage collector that starts from retained heads and snapshots.

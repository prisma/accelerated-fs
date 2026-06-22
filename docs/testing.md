# Testing

The test suite uses `LocalObjectStore`, which maps object keys to files under a temporary directory and enforces the same conditional-write behavior used by S3 commits.

Run:

```bash
bun test
bun run typecheck
bun run demo:all
```

Important scenarios covered:

- write/read/stat
- range reads across chunks
- small-file packing
- readonly remount from snapshot/WAL
- reader refresh
- `Bun.write()` through `openWrite()`
- materialized `BunFile` reads
- metadata operations
- single-writer lock rejection
- Mastra `AcceleratedFS` workspace operations
- just-bash filesystem wrapper operations, symlink sidecar persistence, and shell wiring
- Flue sandbox adapter file operations and just-bash-backed `exec()` wiring
- runnable demos for the core filesystem and all three adapters

For production, also run integration tests against your S3-compatible provider, especially conditional writes and range reads.

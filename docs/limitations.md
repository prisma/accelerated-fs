# Limitations

This project is a virtual filesystem library, not a POSIX filesystem.

Not supported:

- kernel-level mount paths
- hard links
- mmap
- byte-range in-place mutation
- multi-writer conflict resolution
- cross-mount atomic rename
- POSIX advisory locks
- POSIX permissions enforcement beyond stored mode bits
- automatic remote garbage collection

## Whole-file replace semantics

Writes replace whole files. Internally a replacement creates a new version and new extents.

## Single writer only

The protocol is designed for many readers and one writer. The writer lease and head CAS protect against accidental concurrent writers, but there is no merge algorithm.

## Garbage collection

Old blob, pack, WAL, and snapshot objects are retained. A production system should add a GC job that marks reachable objects from retained heads and snapshots, then deletes unreferenced objects after a safety delay.

## S3-compatible services

The TypeScript S3 backend signs AWS SigV4 requests. It supports standard S3-compatible services that accept AWS-style signatures, conditional headers, range reads, and ListObjectsV2. Some S3-compatible services differ in ETag or conditional-write behavior; test the backend against your provider before production.

## just-bash and Flue adapters

The just-bash and Flue adapters do not provide host process execution. They run commands through just-bash, which is a TypeScript bash environment. That keeps commands inside the virtual filesystem instead of exposing the host filesystem.

Adapter-specific compromises:

- symbolic links are implemented by a hidden metadata sidecar file
- hard links are simulated by copying file bytes
- directory `chmod` and `utimes` are no-ops because the core API does not currently expose metadata-only directory updates
- `getAllPaths()` is backed by a path cache; use `refreshPathCache()` / `primePathCache` for exact initial glob expansion across a large existing tree

These limitations do not affect the core write-through durability guarantees. Any files written by just-bash or Flue file tools still go through the same remote WAL and head-publish protocol.

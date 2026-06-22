# Cache policy

The local cache is bounded by `cacheBytes`.

## Cache classes

```text
objects/       clean cached blob and pack objects
materialized/  full local files assembled for BunFile consumers
tmp/           active write handles
meta.sqlite    local metadata database
```

`tmp/` and `meta.sqlite` are not part of the clean LRU cache. Dirty write handles are never evicted.

## LRU eviction

`cache_entry` records:

- object key
- local path
- byte size
- last access time
- hit count
- pin count
- state

Before storing a new object or materialized file, the implementation evicts unpinned entries ordered by least recent access.

## Pinning

`materialize()` increments `pin_count`. The returned lease must be released:

```ts
const lease = await fs.materialize("/model.json");
try {
  await use(lease.path);
} finally {
  await lease.release();
}
```

Pinned files are not evicted.

## Working set guidance

A 500 MB cache can operate over tens of GB when the active working set fits in cache or reads are mostly sequential. If the active random working set is much larger than the cache, correctness still holds, but S3 reads increase.

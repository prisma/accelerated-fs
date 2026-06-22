# Examples

For complete runnable examples, use the demo apps:

```bash
bun run demo:core
bun run demo:mastra
bun run demo:just-bash
bun run demo:flue
```

The source files live in [`../demos`](../demos) and are covered by [`../test/demo-apps.test.ts`](../test/demo-apps.test.ts).

## Lambda-style processing

```ts
const manager = new S3CachedFsManagerImpl({ cacheRoot: "/tmp/s3vfs" });

const fs = await manager.mount({
  name: "job",
  mode: "readwrite",
  bucket: process.env.BUCKET!,
  prefix: `jobs/${process.env.JOB_ID}`,
  region: process.env.AWS_REGION,
  cacheBytes: 500 * 1024 * 1024,
});

const manifest = JSON.parse(await fs.readText("/manifest.json"));

await fs.transaction(async tx => {
  for (const item of manifest.items) {
    await tx.writeFile(`/out/${item.id}.json`, JSON.stringify(processItem(item)));
  }
});

await fs.close();
```

## Large streamed read

```ts
const stream = fs.stream("/dataset/huge.bin");
for await (const chunk of stream as any) {
  consume(chunk);
}
```

## Local test backend

```ts
const objectRoot = "/tmp/s3vfs-objects";
const manager = new S3CachedFsManagerImpl({
  cacheRoot: "/tmp/s3vfs-cache",
  storeFactory: () => new LocalObjectStore(objectRoot),
});
```

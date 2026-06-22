import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { LocalObjectStore, S3CachedFsManagerImpl } from "../src/index";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = path.join("/tmp", `s3vfs-${name}-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function makeManager(name: string, objectRoot: string, cacheRoot = tempRoot(`${name}-cache`)) {
  const store = new LocalObjectStore(objectRoot);
  const manager = new S3CachedFsManagerImpl({
    cacheRoot,
    storeFactory: () => store,
  });
  return { manager, store };
}

test("writeFile, readFile, readText, and cross-chunk readRange", async () => {
  const objectRoot = tempRoot("objects");
  const { manager } = makeManager("basic", objectRoot);
  const fs = await manager.mount({
    name: "m",
    mode: "readwrite",
    cacheBytes: 8 * 1024 * 1024,
    chunkBytes: 16,
    smallFileBytes: 8,
    packBytes: 64,
  });

  await fs.writeFile("/hello.txt", "hello world");
  expect(await fs.readText("/hello.txt")).toBe("hello world");

  const bytes = new Uint8Array(100);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  await fs.writeFile("/large.bin", bytes);
  expect(Array.from(await fs.readRange("/large.bin", 14, 40))).toEqual(Array.from(bytes.slice(14, 54)));
  expect((await fs.stat("/large.bin")).size).toBe(100);
  await manager.closeAll();
});

test("transaction packs many small files into a small number of pack objects", async () => {
  const objectRoot = tempRoot("objects");
  const { manager, store } = makeManager("packs", objectRoot);
  const fs = await manager.mount({
    name: "m",
    mode: "readwrite",
    cacheBytes: 16 * 1024 * 1024,
    smallFileBytes: 1024,
    packBytes: 128 * 1024,
  });

  await fs.transaction(async tx => {
    for (let i = 0; i < 1000; i++) {
      await tx.writeFile(`/shards/${i}.json`, JSON.stringify({ i }));
    }
  });

  expect(JSON.parse(await fs.readText("/shards/999.json"))).toEqual({ i: 999 });
  const packs = await store.list("packs/");
  expect(packs.keys.length).toBeLessThanOrEqual(2);
  await manager.closeAll();
});

test("readonly remount rebuilds metadata from remote snapshot and WAL", async () => {
  const objectRoot = tempRoot("objects");
  const first = makeManager("writer", objectRoot);
  const fs = await first.manager.mount({ name: "m", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  await fs.writeFile("/a/b/c.txt", "persisted");
  await fs.mkdir("/empty");
  await first.manager.closeAll();

  const second = makeManager("reader", objectRoot);
  const ro = await second.manager.mount({ name: "m", mode: "readonly", cacheBytes: 8 * 1024 * 1024 });
  expect(await ro.readText("/a/b/c.txt")).toBe("persisted");
  expect((await ro.stat("/empty")).kind).toBe("dir");
  await second.manager.closeAll();
});

test("reader refresh observes a writer commit atomically", async () => {
  const objectRoot = tempRoot("objects");
  const writerMgr = makeManager("writer", objectRoot);
  const writer = await writerMgr.manager.mount({ name: "writer", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  await writer.writeFile("/version.txt", "v1");

  const readerMgr = makeManager("reader", objectRoot);
  const reader = await readerMgr.manager.mount({ name: "reader", mode: "readonly", cacheBytes: 8 * 1024 * 1024 });
  expect(await reader.readText("/version.txt")).toBe("v1");

  await writer.writeFile("/version.txt", "v2");
  expect(await reader.readText("/version.txt")).toBe("v1");
  await reader.refresh();
  expect(await reader.readText("/version.txt")).toBe("v2");

  await writerMgr.manager.closeAll();
  await readerMgr.manager.closeAll();
});

test("openWrite accepts Bun.write to a real local BunFile", async () => {
  const objectRoot = tempRoot("objects");
  const { manager } = makeManager("open-write", objectRoot);
  const fs = await manager.mount({ name: "m", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  const h = await fs.openWrite("/out.txt");
  await Bun.write(h.file, "via Bun.write");
  await h.close();
  expect(await fs.readText("/out.txt")).toBe("via Bun.write");
  await manager.closeAll();
});

test("materialize returns a real BunFile and release unpins it", async () => {
  const objectRoot = tempRoot("objects");
  const { manager } = makeManager("materialize", objectRoot);
  const fs = await manager.mount({ name: "m", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  await fs.writeFile("/data.json", JSON.stringify({ ok: true }));
  const lease = await fs.materialize("/data.json");
  try {
    expect(await lease.file.json()).toEqual({ ok: true });
  } finally {
    await lease.release();
  }
  await manager.closeAll();
});

test("rm and rename are WAL-backed metadata operations", async () => {
  const objectRoot = tempRoot("objects");
  const { manager } = makeManager("metadata", objectRoot);
  const fs = await manager.mount({ name: "m", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  await fs.writeFile("/dir/one.txt", "1");
  await fs.rename("/dir/one.txt", "/dir/two.txt");
  expect(await fs.exists("/dir/one.txt")).toBe(false);
  expect(await fs.readText("/dir/two.txt")).toBe("1");
  await fs.rm("/dir", { recursive: true });
  expect(await fs.exists("/dir/two.txt")).toBe(false);
  await manager.closeAll();
});

test("single writer lease rejects concurrent readwrite mounts", async () => {
  const objectRoot = tempRoot("objects");
  const first = makeManager("w1", objectRoot);
  const second = makeManager("w2", objectRoot);
  await first.manager.mount({ name: "m1", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  let failed = false;
  try {
    await second.manager.mount({ name: "m2", mode: "readwrite", cacheBytes: 8 * 1024 * 1024 });
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  await first.manager.closeAll();
  await second.manager.closeAll();
});

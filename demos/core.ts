import path from "node:path";
import { LocalObjectStore } from "../src/core";
import {
  cleanupDemo,
  createDemoManager,
  createDemoPaths,
  DEMO_CACHE_BYTES,
  isMain,
  printDemoResult,
} from "./shared";

export interface CoreDemoResult {
  files: string[];
  firstRange: string;
  persistedAfterRemount: string;
  objectCounts: {
    wal: number;
    packs: number;
    blobs: number;
  };
}

export async function runCoreDemo(): Promise<CoreDemoResult> {
  const paths = createDemoPaths("core");
  const manager = createDemoManager(paths);

  try {
    const fs = await manager.mount({
      name: "core-demo",
      mode: "readwrite",
      cacheBytes: DEMO_CACHE_BYTES,
      chunkBytes: 32,
      smallFileBytes: 32,
      packBytes: 1024,
    });

    await fs.writeFile("/incoming/manifest.json", JSON.stringify({ batch: 1, items: ["alpha", "beta"] }, null, 2));
    await fs.transaction(async tx => {
      await tx.mkdir("/reports", { recursive: true });
      await tx.writeFile("/reports/alpha.txt", "batch-1 complete\n");
      await tx.writeFile("/reports/beta.txt", "batch-1 complete\n");
    });

    const handle = await fs.openWrite("/reports/large.txt");
    await Bun.write(
      handle.file,
      [
        "streamed write from a real BunFile handle",
        "second line",
        "third line",
        "fourth line",
      ].join("\n"),
    );
    await handle.close();

    const files = (await fs.readdir("/reports")).map(entry => entry.name).sort();
    const firstRange = new TextDecoder().decode(await fs.readRange("/reports/large.txt", 0, 14));

    await manager.closeAll();

    const reader = createDemoManager({
      objectRoot: paths.objectRoot,
      cacheRoot: path.join(paths.root, "reader-cache"),
    });
    const readonly = await reader.mount({
      name: "core-demo-reader",
      mode: "readonly",
      cacheBytes: DEMO_CACHE_BYTES,
    });
    const persistedAfterRemount = await readonly.readText("/reports/alpha.txt");
    await reader.closeAll();

    const store = new LocalObjectStore(paths.objectRoot);
    const [wal, packs, blobs] = await Promise.all([
      store.list("wal/"),
      store.list("packs/"),
      store.list("blobs/"),
    ]);

    return {
      files,
      firstRange,
      persistedAfterRemount,
      objectCounts: {
        wal: wal.keys.length,
        packs: packs.keys.length,
        blobs: blobs.keys.length,
      },
    };
  } finally {
    await manager.closeAll().catch(() => {});
    await cleanupDemo(paths);
  }
}

if (isMain(import.meta)) {
  printDemoResult(await runCoreDemo());
}

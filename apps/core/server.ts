import path from "node:path";
import { rm } from "node:fs/promises";
import { LocalObjectStore, S3CachedFsManagerImpl } from "../../src/core";
import { createMountConfig, serveDemoApp, withCoreFilesystem } from "../_shared/runtime";

serveDemoApp("core", () =>
  withCoreFilesystem("core", async (fs, context) => {
    await fs.writeFile("/incoming/manifest.json", JSON.stringify({ source: "prisma-compute", items: 2 }));
    await fs.transaction(async tx => {
      await tx.mkdir("/reports", { recursive: true });
      await tx.writeFile("/reports/alpha.txt", "core alpha\n");
      await tx.writeFile("/reports/beta.txt", "core beta\n");
    });

    const handle = await fs.openWrite("/reports/large.txt");
    await Bun.write(handle.file, "core streamed write\n".repeat(128));
    await handle.close();

    const files = (await fs.readdir("/reports")).map(entry => entry.name).sort();
    const range = new TextDecoder().decode(await fs.readRange("/reports/large.txt", 0, 19));
    await fs.close();

    const readerCacheRoot = path.join("/tmp", "accelerated-fs", "core-reader", context.requestId);
    const reader = new S3CachedFsManagerImpl({ cacheRoot: readerCacheRoot });
    try {
      const readonly = await reader.mount({
        ...createMountConfig("core-reader", context.prefix),
        mode: "readonly",
      });
      const persisted = await readonly.readText("/reports/alpha.txt");
      return {
        files,
        range,
        persisted,
        store: process.env.AFS_ENDPOINT ? "s3-compatible" : LocalObjectStore.name,
      };
    } finally {
      await reader.closeAll().catch(() => {});
      await rm(readerCacheRoot, { recursive: true, force: true }).catch(() => {});
    }
  }),
);

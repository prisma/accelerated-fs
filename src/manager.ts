import path from "node:path";
import type { ManagerConfig, MountConfig, ObjectStoreFactory, ResolvedMountConfig, S3CachedFs, S3CachedFsManager } from "./types";
import { VfsError } from "./types";
import { S3ObjectStore } from "./stores/s3-object-store";
import { S3CachedFsImpl } from "./s3-cached-fs";
import { ensureDir } from "./util/fs";

export interface S3CachedFsManagerOptions extends ManagerConfig {
  storeFactory?: ObjectStoreFactory;
}

export class S3CachedFsManagerImpl implements S3CachedFsManager {
  private mounts = new Map<string, S3CachedFs>();
  private storeFactory: ObjectStoreFactory;

  constructor(readonly options: S3CachedFsManagerOptions) {
    this.storeFactory = options.storeFactory ?? (({ config }) => S3ObjectStore.fromMount(config));
  }

  async mount(config: MountConfig): Promise<S3CachedFs> {
    if (this.mounts.has(config.name)) throw new VfsError(`Mount already exists: ${config.name}`, "EEXIST");
    const resolved = resolveConfig(config);
    const cacheRoot = path.join(this.options.cacheRoot, safeMountName(resolved.name));
    await ensureDir(cacheRoot);
    const store = this.storeFactory({ config: resolved });
    const fs = await S3CachedFsImpl.mount(store, resolved, cacheRoot);
    this.mounts.set(resolved.name, fs);
    return fs;
  }

  async unmount(name: string): Promise<void> {
    const fs = this.mounts.get(name);
    if (!fs) return;
    await fs.close();
    this.mounts.delete(name);
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.mounts.entries());
    for (const [name, fs] of entries) {
      await fs.close();
      this.mounts.delete(name);
    }
  }
}

export function resolveConfig(config: MountConfig): ResolvedMountConfig {
  return {
    ...config,
    prefix: (config.prefix ?? "").replace(/^\/+|\/+$/g, ""),
    chunkBytes: config.chunkBytes ?? 8 * 1024 * 1024,
    smallFileBytes: config.smallFileBytes ?? 256 * 1024,
    packBytes: config.packBytes ?? 16 * 1024 * 1024,
    snapshotWalBytes: config.snapshotWalBytes ?? 64 * 1024 * 1024,
    snapshotTxCount: config.snapshotTxCount ?? 10_000,
    materializeMaxBytes: config.materializeMaxBytes ?? Math.min(128 * 1024 * 1024, Math.max(0, Math.floor(config.cacheBytes * 0.75))),
    cacheReserveBytes: config.cacheReserveBytes ?? Math.min(64 * 1024 * 1024, Math.floor(config.cacheBytes * 0.1)),
    lockTtlMs: config.lockTtlMs ?? 60_000,
    lockRenewMs: config.lockRenewMs ?? 20_000,
    readAheadChunks: config.readAheadChunks ?? 2,
  };
}

function safeMountName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

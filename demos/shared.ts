import { rm } from "node:fs/promises";
import path from "node:path";
import { LocalObjectStore, S3CachedFsManagerImpl } from "../src/core";

export const DEMO_CACHE_BYTES = 16 * 1024 * 1024;

export interface DemoPaths {
  root: string;
  objectRoot: string;
  cacheRoot: string;
}

export function createDemoPaths(name: string): DemoPaths {
  const root = path.join("/tmp", `accelerated-fs-demo-${name}-${crypto.randomUUID()}`);
  return {
    root,
    objectRoot: path.join(root, "objects"),
    cacheRoot: path.join(root, "cache"),
  };
}

export function createDemoManager(paths: Pick<DemoPaths, "cacheRoot" | "objectRoot">): S3CachedFsManagerImpl {
  const store = new LocalObjectStore(paths.objectRoot);
  return new S3CachedFsManagerImpl({
    cacheRoot: paths.cacheRoot,
    storeFactory: () => store,
  });
}

export async function cleanupDemo(paths: Pick<DemoPaths, "root">): Promise<void> {
  await rm(paths.root, { recursive: true, force: true });
}

export function isMain(meta: ImportMeta): boolean {
  return (meta as ImportMeta & { main?: boolean }).main === true;
}

export function printDemoResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

import { rm } from "node:fs/promises";
import path from "node:path";
import type { MountConfig, S3CachedFs } from "../../src/core";
import { S3CachedFsManagerImpl } from "../../src/core";

export const DEFAULT_PORT = 8080;

export interface DemoContext {
  requestId: string;
  prefix: string;
}

export interface DemoResult {
  app: string;
  requestId: string;
  prefix: string;
  result: unknown;
}

export type DemoHandler = () => Promise<DemoResult>;

export function serveDemoApp(app: string, runDemo: DemoHandler): void {
  Bun.serve({
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json({ ok: true, app });
      }
      if (url.pathname === "/" || url.pathname === "/demo") {
        try {
          return json(await runDemo());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json({ ok: false, app, error: message }, 500);
        }
      }
      return json({ ok: false, error: "not found" }, 404);
    },
  });
}

export async function withCoreFilesystem<T>(
  app: string,
  fn: (fs: S3CachedFs, context: DemoContext) => Promise<T>,
): Promise<DemoResult> {
  const context = createDemoContext(app);
  const cacheRoot = path.join("/tmp", "accelerated-fs", app, context.requestId);
  const manager = new S3CachedFsManagerImpl({ cacheRoot });

  try {
    const fs = await manager.mount(createMountConfig(app, context.prefix));
    const result = await fn(fs, context);
    return { app, requestId: context.requestId, prefix: context.prefix, result };
  } finally {
    await manager.closeAll().catch(() => {});
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function createDemoContext(app: string): DemoContext {
  const requestId = crypto.randomUUID();
  return {
    requestId,
    prefix: [process.env.AFS_PREFIX_BASE ?? "accelerated-fs/compute", app, requestId].join("/"),
  };
}

export function createMountConfig(app: string, prefix: string): MountConfig {
  const config: MountConfig = {
    name: `${app}-${crypto.randomUUID()}`,
    mode: "readwrite",
    bucket: requiredEnv("AFS_BUCKET"),
    prefix,
    region: process.env.AFS_REGION ?? "auto",
    accessKeyId: requiredEnv("AFS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("AFS_SECRET_ACCESS_KEY"),
    cacheBytes: Number(process.env.AFS_CACHE_BYTES ?? 64 * 1024 * 1024),
    chunkBytes: Number(process.env.AFS_CHUNK_BYTES ?? 1024 * 1024),
    smallFileBytes: Number(process.env.AFS_SMALL_FILE_BYTES ?? 64 * 1024),
    packBytes: Number(process.env.AFS_PACK_BYTES ?? 4 * 1024 * 1024),
    lockTtlMs: 15_000,
    lockRenewMs: 5_000,
  };
  if (process.env.AFS_ENDPOINT) config.endpoint = process.env.AFS_ENDPOINT;
  return config;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

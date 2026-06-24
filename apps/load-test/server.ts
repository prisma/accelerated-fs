import { waitUntil } from "@prisma/compute";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { MountConfig, S3CachedFs } from "../../src/core";
import { S3CachedFsManagerImpl } from "../../src/core";
import { DEFAULT_PORT, json } from "../_shared/runtime";

const APP = "load-test";
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const FILE_BYTES = 10 * KIB;
const CACHE_BYTES = 100 * MIB;
const READ_COUNT = 1_000;
const WRITE_COUNT = 1_000;
const DEFAULT_BATCH_FILES = 400;
const DEFAULT_KEEP_AWAKE_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MAX_EVENTS = 200;

const FULL_SIZES: DataSize[] = [
  { label: "50mb", totalBytes: 50 * MIB },
  { label: "500mb", totalBytes: 500 * MIB },
  { label: "5gb", totalBytes: 5 * GIB },
];

const QUICK_SIZES: DataSize[] = [
  { label: "1mb", totalBytes: 1 * MIB },
  { label: "4mb", totalBytes: 4 * MIB },
  { label: "8mb", totalBytes: 8 * MIB },
];

interface DataSize {
  label: string;
  totalBytes: number;
}

interface Progress {
  stage: string;
  sizeLabel?: string;
  completed?: number;
  total?: number;
  detail?: string;
  updatedAt: string;
}

interface EventLog {
  at: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface BenchmarkOptions {
  profile: string;
  sizes: DataSize[];
  seed: number;
  batchFiles: number;
  keepAwakeTimeoutMs: number;
}

interface StorageTarget {
  bucket: string;
  region: string;
  endpoint?: string;
  prefixBase: string;
  provisionedBucket?: R2ProvisionedBucket;
}

interface R2ProvisionedBucket {
  name: string;
  accountId: string;
  endpoint: string;
  locationHint?: string;
  jurisdiction?: string;
  createdAt: string;
  result?: unknown;
}

interface PhaseTiming {
  startedAt: string;
  completedAt: string;
  ms: number;
}

interface SizeResult {
  label: string;
  prefix: string;
  requestedBytes: number;
  actualBytes: number;
  fileBytes: number;
  fileCount: number;
  cacheBytes: number;
  packBytes: number;
  batchFiles: number;
  insert: PhaseTiming & { batches: number };
  mixed: PhaseTiming & {
    operations: number;
    reads: number;
    writes: number;
    checksum: number;
  };
  closeMs: number;
}

interface BenchmarkJob {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  completedAt?: string;
  options: BenchmarkOptions;
  storage?: StorageTarget;
  progress: Progress;
  results: SizeResult[];
  events: EventLog[];
  error?: string;
}

interface MixedOperation {
  kind: "read" | "write";
  fileIndex: number;
}

let currentJob: BenchmarkJob | null = null;
let runningPromise: Promise<void> | null = null;

Bun.serve({
  port: Number(process.env.PORT ?? DEFAULT_PORT),
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        app: APP,
        running: currentJob?.status === "running",
        jobId: currentJob?.id ?? null,
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        app: APP,
        endpoints: {
          start: "POST /run",
          status: "GET /status",
          results: "GET /results",
          quickSmoke: "POST /run?profile=quick",
          singleSize: "POST /run?sizes=50mb",
        },
        defaults: {
          cacheBytes: CACHE_BYTES,
          fileBytes: FILE_BYTES,
          reads: READ_COUNT,
          writes: WRITE_COUNT,
          sizes: FULL_SIZES,
          storageProvisioner: process.env.LOAD_TEST_STORAGE_PROVISIONER ?? "static",
        },
      });
    }

    if (url.pathname === "/run") {
      if (request.method !== "POST") return json({ ok: false, error: "use POST /run" }, 405);
      if (currentJob?.status === "running") return json(summarizeJob(currentJob), 202);

      let options: BenchmarkOptions;
      try {
        options = parseBenchmarkOptions(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ ok: false, error: message }, 400);
      }

      const job = createJob(options);
      currentJob = job;
      runningPromise = runBenchmarkJob(job).finally(() => {
        runningPromise = null;
      });
      waitUntil(runningPromise, { signal: timeoutSignal(options.keepAwakeTimeoutMs) });
      return json(summarizeJob(job), 202);
    }

    if (url.pathname === "/status" || url.pathname === "/results") {
      if (!currentJob) return json({ ok: false, error: "no benchmark job has been started" }, 404);
      return json(summarizeJob(currentJob), currentJob.status === "running" ? 202 : 200);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
});

function createJob(options: BenchmarkOptions): BenchmarkJob {
  const now = new Date().toISOString();
  const job: BenchmarkJob = {
    id: crypto.randomUUID(),
    status: "running",
    startedAt: now,
    options,
    progress: { stage: "queued", updatedAt: now },
    results: [],
    events: [],
  };
  addEvent(job, "job started", {
    profile: options.profile,
    sizes: options.sizes.map(size => size.label),
    cacheBytes: CACHE_BYTES,
  });
  return job;
}

async function runBenchmarkJob(job: BenchmarkJob): Promise<void> {
  try {
    job.storage = await prepareStorageTarget(job);
    for (const size of job.options.sizes) {
      const result = await runSizeBenchmark(job, size);
      job.results.push(result);
    }
    job.status = "succeeded";
    setProgress(job, { stage: "completed", completed: job.results.length, total: job.options.sizes.length });
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.stack ?? error.message : String(error);
    setProgress(job, { stage: "failed", detail: error instanceof Error ? error.message : String(error) });
    addEvent(job, "job failed", { error: job.error });
  } finally {
    job.completedAt = new Date().toISOString();
  }
}

async function runSizeBenchmark(job: BenchmarkJob, size: DataSize): Promise<SizeResult> {
  const fileCount = Math.ceil(size.totalBytes / FILE_BYTES);
  const actualBytes = fileCount * FILE_BYTES;
  const batches = Math.ceil(fileCount / job.options.batchFiles);
  const storage = job.storage ?? await prepareStorageTarget(job);
  const prefix = [
    storage.prefixBase,
    APP,
    job.id,
    size.label,
  ].join("/");
  const cacheRoot = path.join("/tmp", "accelerated-fs", APP, job.id, size.label);
  const manager = new S3CachedFsManagerImpl({ cacheRoot, totalCacheBytes: CACHE_BYTES });
  const mountConfig = createLoadTestMountConfig(`${APP}-${size.label}-${job.id}`, prefix, storage);
  let result: Omit<SizeResult, "closeMs"> | null = null;

  addEvent(job, "size started", { label: size.label, fileCount, actualBytes, prefix });
  setProgress(job, {
    stage: "mounting",
    sizeLabel: size.label,
    completed: 0,
    total: fileCount,
    detail: "mounting filesystem",
  });

  try {
    await rm(cacheRoot, { recursive: true, force: true });
    const fs = await manager.mount(mountConfig);
    await fs.mkdir("/data", { recursive: true });

    const { value: _insertValue, ...insert } = await timePhase(async () => {
      await insertData(job, fs, size.label, fileCount, job.options.batchFiles);
    });

    const { value: checksum, ...mixed } = await timePhase(async () => {
      return await runMixedOperations(job, fs, size.label, fileCount, job.options.seed);
    });

    result = {
      label: size.label,
      prefix,
      requestedBytes: size.totalBytes,
      actualBytes,
      fileBytes: FILE_BYTES,
      fileCount,
      cacheBytes: CACHE_BYTES,
      packBytes: mountConfig.packBytes ?? 0,
      batchFiles: job.options.batchFiles,
      insert: { ...insert, batches },
      mixed: {
        ...mixed,
        operations: READ_COUNT + WRITE_COUNT,
        reads: READ_COUNT,
        writes: WRITE_COUNT,
        checksum,
      },
    };
  } finally {
    setProgress(job, {
      stage: "closing",
      sizeLabel: size.label,
      completed: fileCount,
      total: fileCount,
      detail: "closing filesystem and publishing final snapshot",
    });
    const closeStart = performance.now();
    await manager.closeAll().catch(error => {
      addEvent(job, "close failed", { label: size.label, error: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    const closeMs = performance.now() - closeStart;
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});

    if (result) {
      addEvent(job, "size completed", {
        label: size.label,
        insertMs: Math.round(result.insert.ms),
        mixedMs: Math.round(result.mixed.ms),
        closeMs: Math.round(closeMs),
      });
      return { ...result, closeMs };
    }
  }

  throw new Error(`Benchmark did not produce a result for ${size.label}`);
}

async function insertData(
  job: BenchmarkJob,
  fs: S3CachedFs,
  sizeLabel: string,
  fileCount: number,
  batchFiles: number,
): Promise<void> {
  let lastProgressAt = 0;
  for (let start = 0; start < fileCount; start += batchFiles) {
    const end = Math.min(start + batchFiles, fileCount);
    await fs.transaction(async tx => {
      for (let index = start; index < end; index++) {
        await tx.writeFile(filePath(index), makeFileBytes(index, 0));
      }
    });

    const now = performance.now();
    if (now - lastProgressAt > 5_000 || end === fileCount) {
      lastProgressAt = now;
      setProgress(job, {
        stage: "inserting",
        sizeLabel,
        completed: end,
        total: fileCount,
        detail: `${end}/${fileCount} files`,
      });
      addEvent(job, "insert progress", { label: sizeLabel, files: end, total: fileCount });
    }
  }
}

async function runMixedOperations(
  job: BenchmarkJob,
  fs: S3CachedFs,
  sizeLabel: string,
  fileCount: number,
  seed: number,
): Promise<number> {
  const operations = buildMixedOperations(fileCount, seed ^ hashLabel(sizeLabel));
  let checksum = 0;
  let reads = 0;
  let writes = 0;
  let lastProgressAt = 0;

  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]!;
    if (operation.kind === "read") {
      const bytes = await fs.readFile(filePath(operation.fileIndex));
      if (bytes.byteLength !== FILE_BYTES) {
        throw new Error(`Read ${bytes.byteLength} bytes from ${filePath(operation.fileIndex)}, expected ${FILE_BYTES}`);
      }
      checksum = (checksum + bytes[0]! + bytes[bytes.byteLength - 1]!) >>> 0;
      reads++;
    } else {
      writes++;
      await fs.writeFile(filePath(operation.fileIndex), makeFileBytes(operation.fileIndex, writes));
    }

    const completed = index + 1;
    const now = performance.now();
    if (now - lastProgressAt > 5_000 || completed === operations.length) {
      lastProgressAt = now;
      setProgress(job, {
        stage: "mixed",
        sizeLabel,
        completed,
        total: operations.length,
        detail: `${reads} reads, ${writes} writes`,
      });
      addEvent(job, "mixed progress", { label: sizeLabel, operations: completed, total: operations.length, reads, writes });
    }
  }

  if (reads !== READ_COUNT || writes !== WRITE_COUNT) {
    throw new Error(`Mixed operation count mismatch: ${reads} reads and ${writes} writes`);
  }

  return checksum;
}

async function timePhase<T>(fn: () => Promise<T>): Promise<PhaseTiming & { value: T }> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const value = await fn();
  const ms = performance.now() - start;
  return { startedAt, completedAt: new Date().toISOString(), ms, value };
}

async function prepareStorageTarget(job: BenchmarkJob): Promise<StorageTarget> {
  if (job.storage) return job.storage;

  const prefixBase = process.env.AFS_PREFIX_BASE ?? "accelerated-fs/compute";
  const provisioner = (process.env.LOAD_TEST_STORAGE_PROVISIONER ?? "static").toLowerCase();

  if (provisioner === "r2-one-time-bucket" || provisioner === "r2") {
    const bucket = await provisionR2Bucket(job);
    const target: StorageTarget = {
      bucket: bucket.name,
      region: process.env.AFS_REGION ?? "auto",
      endpoint: bucket.endpoint,
      prefixBase,
      provisionedBucket: bucket,
    };
    addEvent(job, "storage target ready", {
      provisioner,
      bucket: target.bucket,
      endpoint: target.endpoint,
      locationHint: bucket.locationHint ?? null,
      jurisdiction: bucket.jurisdiction ?? null,
    });
    job.storage = target;
    return target;
  }

  if (provisioner !== "static") {
    throw new Error(`Unknown LOAD_TEST_STORAGE_PROVISIONER "${provisioner}"`);
  }

  const target: StorageTarget = {
    bucket: requiredEnv("AFS_BUCKET"),
    region: process.env.AFS_REGION ?? "auto",
    prefixBase,
  };
  const endpoint = process.env.AFS_ENDPOINT;
  if (endpoint) target.endpoint = endpoint;
  addEvent(job, "storage target ready", { provisioner, bucket: target.bucket, endpoint: target.endpoint ?? null });
  job.storage = target;
  return target;
}

async function provisionR2Bucket(job: BenchmarkJob): Promise<R2ProvisionedBucket> {
  const endpoint = requiredEnv("AFS_ENDPOINT");
  const accountId = process.env.R2_ACCOUNT_ID ?? parseR2AccountId(endpoint);
  const token = requiredEnv("R2_API_TOKEN");
  const locationHint = optionalLowerEnv("R2_LOCATION_HINT");
  const jurisdiction = optionalLowerEnv("R2_JURISDICTION");
  const bucket = makeR2BucketName(job.id);
  const body: Record<string, string> = { name: bucket };
  if (locationHint) body.locationHint = locationHint;
  if (process.env.R2_STORAGE_CLASS) body.storageClass = process.env.R2_STORAGE_CLASS;

  setProgress(job, {
    stage: "provisioning-storage",
    completed: 0,
    total: job.options.sizes.length,
    detail: `creating R2 bucket ${bucket}`,
  });
  addEvent(job, "creating r2 bucket", {
    bucket,
    accountId,
    locationHint: locationHint ?? null,
    jurisdiction: jurisdiction ?? null,
  });

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  if (jurisdiction) headers.set("cf-r2-jurisdiction", jurisdiction);

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isCloudflareSuccess(responseBody)) {
    throw new Error(`Failed to create R2 bucket ${bucket}: ${response.status} ${formatCloudflareError(responseBody)}`);
  }

  const result = isObject(responseBody) ? responseBody.result : undefined;
  return {
    name: bucket,
    accountId,
    endpoint,
    ...(locationHint ? { locationHint } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    createdAt: new Date().toISOString(),
    result,
  };
}

function createLoadTestMountConfig(name: string, prefix: string, storage: StorageTarget): MountConfig {
  const config: MountConfig = {
    name,
    mode: "readwrite",
    bucket: storage.bucket,
    prefix,
    region: storage.region,
    accessKeyId: requiredEnv("AFS_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("AFS_SECRET_ACCESS_KEY"),
    cacheBytes: CACHE_BYTES,
    cacheReserveBytes: numberEnv("LOAD_TEST_CACHE_RESERVE_BYTES", 10 * MIB),
    chunkBytes: numberEnv("LOAD_TEST_CHUNK_BYTES", 1 * MIB),
    smallFileBytes: numberEnv("LOAD_TEST_SMALL_FILE_BYTES", 16 * KIB),
    packBytes: numberEnv("LOAD_TEST_PACK_BYTES", 4 * MIB),
    lockTtlMs: numberEnv("LOAD_TEST_LOCK_TTL_MS", 60_000),
    lockRenewMs: numberEnv("LOAD_TEST_LOCK_RENEW_MS", 20_000),
  };
  if (storage.endpoint) config.endpoint = storage.endpoint;
  return config;
}

function parseBenchmarkOptions(url: URL): BenchmarkOptions {
  const profile = (url.searchParams.get("profile") ?? process.env.LOAD_TEST_PROFILE ?? "full").toLowerCase();
  const sizes = parseSizes(url.searchParams.get("sizes"), profile);
  const seed = numberParam(url, "seed", numberEnv("LOAD_TEST_SEED", 0x5eed_1234));
  const batchFiles = numberParam(url, "batchFiles", numberEnv("LOAD_TEST_BATCH_FILES", DEFAULT_BATCH_FILES));
  const keepAwakeTimeoutMs = numberParam(
    url,
    "keepAwakeTimeoutMs",
    numberEnv("LOAD_TEST_KEEP_AWAKE_TIMEOUT_MS", DEFAULT_KEEP_AWAKE_TIMEOUT_MS),
  );

  if (!Number.isInteger(batchFiles) || batchFiles < 1) throw new Error("batchFiles must be a positive integer");
  if (keepAwakeTimeoutMs < 60_000) throw new Error("keepAwakeTimeoutMs must be at least 60000");

  return { profile, sizes, seed, batchFiles, keepAwakeTimeoutMs };
}

function parseSizes(value: string | null, profile: string): DataSize[] {
  const source = profile === "quick" ? QUICK_SIZES : FULL_SIZES;
  if (!value) return source;

  const byLabel = new Map([...FULL_SIZES, ...QUICK_SIZES].map(size => [size.label, size]));
  const sizes = value.split(",").map(part => part.trim().toLowerCase()).filter(Boolean).map(label => {
    const size = byLabel.get(label);
    if (!size) throw new Error(`Unknown size "${label}". Use one of: ${Array.from(byLabel.keys()).join(", ")}`);
    return size;
  });
  if (sizes.length === 0) throw new Error("sizes must include at least one size label");
  return sizes;
}

function buildMixedOperations(fileCount: number, seed: number): MixedOperation[] {
  const rng = mulberry32(seed);
  const kinds: Array<"read" | "write"> = [];
  for (let index = 0; index < READ_COUNT; index++) kinds.push("read");
  for (let index = 0; index < WRITE_COUNT; index++) kinds.push("write");

  for (let index = kinds.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1));
    const tmp = kinds[index]!;
    kinds[index] = kinds[swap]!;
    kinds[swap] = tmp;
  }

  return kinds.map(kind => ({
    kind,
    fileIndex: Math.floor(rng() * fileCount),
  }));
}

function makeFileBytes(fileIndex: number, generation: number): Uint8Array {
  const bytes = new Uint8Array(FILE_BYTES);
  bytes.fill((fileIndex * 31 + generation * 17) & 0xff);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, fileIndex >>> 0, true);
  view.setUint32(4, generation >>> 0, true);
  view.setUint32(8, FILE_BYTES, true);
  return bytes;
}

function filePath(index: number): string {
  return `/data/file-${String(index).padStart(8, "0")}.bin`;
}

function summarizeJob(job: BenchmarkJob): BenchmarkJob & { ok: boolean } {
  return { ok: job.status !== "failed", ...job };
}

function setProgress(job: BenchmarkJob, progress: Omit<Progress, "updatedAt">): void {
  job.progress = { ...progress, updatedAt: new Date().toISOString() };
}

function addEvent(job: BenchmarkJob, message: string, fields?: Record<string, unknown>): void {
  const event: EventLog = { at: new Date().toISOString(), message };
  if (fields) event.fields = fields;
  job.events.push(event);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  console.log(`[${APP}] ${message}`, fields ? JSON.stringify(fields) : "");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalLowerEnv(name: string): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  return value || undefined;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function numberParam(url: URL, name: string, fallback: number): number {
  const value = url.searchParams.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function hashLabel(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseR2AccountId(endpoint: string): string {
  const host = new URL(endpoint).hostname;
  const accountId = host.split(".")[0];
  if (!accountId || accountId === "r2") throw new Error(`Could not parse R2 account id from AFS_ENDPOINT ${endpoint}`);
  return accountId;
}

function makeR2BucketName(jobId: string): string {
  const prefix = (process.env.R2_BUCKET_PREFIX ?? "afs-bench").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const compactJobId = jobId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const bucket = `${prefix}-${compactJobId}`.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (bucket.length < 3 || bucket.length > 64) {
    throw new Error(`Generated R2 bucket name "${bucket}" must be between 3 and 64 characters`);
  }
  return bucket;
}

function isCloudflareSuccess(value: unknown): boolean {
  return isObject(value) && value.success === true;
}

function formatCloudflareError(value: unknown): string {
  if (!isObject(value)) return String(value);
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const messages = errors.map(error => {
    if (!isObject(error)) return String(error);
    const code = typeof error.code === "number" ? `${error.code}: ` : "";
    return `${code}${String(error.message ?? "unknown error")}`;
  });
  return messages.length > 0 ? messages.join("; ") : JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

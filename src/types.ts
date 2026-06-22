export type VfsKind = "file" | "dir" | "symlink";

export type WriteInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView
  | Blob
  | Response
  | ReadableStream<Uint8Array>;

export interface MountConfig {
  name: string;
  mode: "readonly" | "readwrite";
  cacheBytes: number;

  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  forcePathStyle?: boolean;

  chunkBytes?: number;
  smallFileBytes?: number;
  packBytes?: number;
  snapshotWalBytes?: number;
  snapshotTxCount?: number;
  materializeMaxBytes?: number;
  cacheReserveBytes?: number;
  lockTtlMs?: number;
  lockRenewMs?: number;
  readAheadChunks?: number;
}

export interface ResolvedMountConfig extends MountConfig {
  prefix: string;
  chunkBytes: number;
  smallFileBytes: number;
  packBytes: number;
  snapshotWalBytes: number;
  snapshotTxCount: number;
  materializeMaxBytes: number;
  cacheReserveBytes: number;
  lockTtlMs: number;
  lockRenewMs: number;
  readAheadChunks: number;
}

export interface ManagerConfig {
  cacheRoot: string;
  totalCacheBytes?: number;
}

export interface VfsStat {
  path: string;
  inodeId: number;
  kind: VfsKind;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  version: number;
}

export interface VfsDirent {
  name: string;
  path: string;
  kind: VfsKind;
  inodeId: number;
  size: number;
  mtimeMs: number;
}

export interface CachedFileLease {
  path: string;
  file: Bun.BunFile;
  release(): Promise<void>;
}

export interface WriteHandle {
  path: string;
  localPath: string;
  file: Bun.BunFile;
  writer(): Bun.FileSink;
  close(): Promise<void>;
  discard(): Promise<void>;
}

export interface MaterializeOptions {
  allowLarge?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface RmOptions {
  recursive?: boolean;
  missingOk?: boolean;
}

export interface S3CachedFsTx {
  writeFile(path: string, input: WriteInput, opts?: { mode?: number; mtimeMs?: number }): Promise<void>;
  mkdir(path: string, opts?: MkdirOptions): Promise<void>;
  rm(path: string, opts?: RmOptions): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface S3CachedFs {
  readonly name: string;
  readonly cacheRoot: string;

  stat(path: string): Promise<VfsStat>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<VfsDirent[]>;

  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  stream(path: string): ReadableStream<Uint8Array>;

  materialize(path: string, opts?: MaterializeOptions): Promise<CachedFileLease>;

  writeFile(path: string, input: WriteInput, opts?: { mode?: number; mtimeMs?: number }): Promise<void>;
  openWrite(path: string, opts?: { mode?: number; mtimeMs?: number }): Promise<WriteHandle>;
  mkdir(path: string, opts?: MkdirOptions): Promise<void>;
  rm(path: string, opts?: RmOptions): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;

  transaction<T>(fn: (tx: S3CachedFsTx) => Promise<T>): Promise<T>;
  refresh(): Promise<void>;
  snapshot(opts?: { force?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface S3CachedFsManager {
  mount(config: MountConfig): Promise<S3CachedFs>;
  unmount(name: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ObjectStat {
  key: string;
  etag: string;
  size: number;
  lastModified?: Date;
  contentType?: string;
}

export interface ObjectListResult {
  keys: string[];
  cursor?: string;
}

export interface PutOptions {
  contentType?: string;
  ifMatch?: string;
  ifNoneMatch?: "*";
}

export interface DeleteOptions {
  ifMatch?: string;
}

export interface ObjectStore {
  get(key: string): Promise<Uint8Array>;
  getRange(key: string, offset: number, length: number): Promise<Uint8Array>;
  put(key: string, body: WriteInput, opts?: PutOptions): Promise<{ etag: string }>;
  head(key: string): Promise<ObjectStat | null>;
  delete(key: string, opts?: DeleteOptions): Promise<void>;
  list(prefix: string, cursor?: string, limit?: number): Promise<ObjectListResult>;
}

export interface StoreFactoryInput {
  config: ResolvedMountConfig;
}

export type ObjectStoreFactory = (input: StoreFactoryInput) => ObjectStore;

export class VfsError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message);
    this.name = "VfsError";
  }
}

export class PreconditionFailedError extends Error {
  constructor(message: string, readonly key: string) {
    super(message);
    this.name = "PreconditionFailedError";
  }
}

export class NotFoundError extends VfsError {
  constructor(path: string) {
    super(`Path not found: ${path}`, "ENOENT");
  }
}

export class IsDirectoryError extends VfsError {
  constructor(path: string) {
    super(`Is a directory: ${path}`, "EISDIR");
  }
}

export class NotDirectoryError extends VfsError {
  constructor(path: string) {
    super(`Not a directory: ${path}`, "ENOTDIR");
  }
}

export class ReadonlyFilesystemError extends VfsError {
  constructor() {
    super("Filesystem is readonly", "EROFS");
  }
}

export class ClosedFilesystemError extends VfsError {
  constructor() {
    super("Filesystem is closed", "EBADF");
  }
}

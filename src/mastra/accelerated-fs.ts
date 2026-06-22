import path from "node:path";
import type {
  CachedFileLease,
  MaterializeOptions,
  MountConfig,
  ObjectStoreFactory,
  S3CachedFs,
  S3CachedFsManager,
  S3CachedFsTx,
  VfsStat,
  WriteHandle,
  WriteInput,
} from "../types";
import {
  IsDirectoryError as VfsIsDirectoryError,
  NotDirectoryError as VfsNotDirectoryError,
  NotFoundError as VfsNotFoundError,
  ReadonlyFilesystemError as VfsReadonlyFilesystemError,
  VfsError,
} from "../types";
import { S3CachedFsManagerImpl } from "../manager";
import { basename, normalizeVfsPath, parentPath } from "../util/path";

export type AcceleratedFSStatus =
  | "pending"
  | "initializing"
  | "ready"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "destroying"
  | "destroyed"
  | "error";

export type AcceleratedFSFileContent = string | Buffer | Uint8Array;
export type AcceleratedFSIcon = any;

export interface AcceleratedFSReadOptions {
  /** Text reads default to utf-8. Use binary when the caller needs a Buffer. */
  encoding?: "utf-8" | "utf8" | "binary" | string;

  /** Non-standard convenience used by some agents/tools; 1-based and inclusive. */
  startLine?: number;

  /** Non-standard convenience used by some agents/tools; 1-based and inclusive. */
  endLine?: number;
}

export interface AcceleratedFSWriteOptions {
  recursive?: boolean;
  overwrite?: boolean;
  mimeType?: string;
  expectedMtime?: Date;
}

export interface AcceleratedFSListOptions {
  recursive?: boolean;
  extension?: string | string[];
  maxDepth?: number;
  /** Optional glob matched against entry names, or recursive relative paths when recursive is true. */
  glob?: string | string[];
  /** Alias for glob, matching Mastra filesystem-tool wording. */
  pattern?: string | string[];
}

export interface AcceleratedFSRemoveOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface AcceleratedFSCopyOptions {
  overwrite?: boolean;
  recursive?: boolean;
}

export interface AcceleratedFSGrepOptions {
  /** File or directory to search. Defaults to the filesystem root. */
  path?: string;

  /** Glob(s) to include. Matched against recursive relative paths. */
  include?: string | string[];

  /** Alias for include, matching Mastra search tool wording. */
  glob?: string | string[];

  /** Glob(s) to exclude. */
  exclude?: string | string[];

  /** File extension filter, e.g. ".ts" or [".ts", ".tsx"]. */
  extension?: string | string[];

  /** Case-sensitive by default, matching grep. */
  caseSensitive?: boolean;

  /** Number of context lines before and after each match. */
  contextLines?: number;

  /** Maximum matches per file. */
  maxCount?: number;

  /** Maximum total matches returned. */
  maxResults?: number;

  /** Decode text files as utf-8 by default. */
  encoding?: Exclude<AcceleratedFSReadOptions["encoding"], "binary">;

  /** Include hidden files and directories. Defaults to false. */
  includeHidden?: boolean;
}

export interface AcceleratedFSGrepMatch {
  path: string;
  line: number;
  column: number;
  match: string;
  text: string;
  before?: string[];
  after?: string[];
}

export interface AcceleratedFSFileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

export interface AcceleratedFSFileStat {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  createdAt: Date;
  modifiedAt: Date;
  mimeType?: string;
}

export interface AcceleratedFSInfo<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string;
  provider: string;
  basePath?: string;
  status?: AcceleratedFSStatus;
  error?: string;
  readOnly?: boolean;
  icon?: AcceleratedFSIcon;
  storage?: {
    totalBytes?: number;
    usedBytes?: number;
    availableBytes?: number;
  };
  metadata?: TMetadata;
}

export type AcceleratedFSInstructions =
  | string
  | ((opts: { defaultInstructions: string; requestContext?: unknown }) => string);

export type MaybePromise<T> = T | Promise<T>;

/**
 * Structural subset of Mastra's WorkspaceFilesystem interface.
 * This avoids a runtime or peer dependency on @mastra/core while keeping
 * AcceleratedFS assignable in ordinary Mastra workspace configuration.
 */
export interface MastraWorkspaceFilesystemLike {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly basePath?: string;
  readonly readOnly?: boolean;

  init?(): MaybePromise<void>;
  destroy?(): MaybePromise<void>;

  readFile(path: string, options?: AcceleratedFSReadOptions): Promise<string | Buffer>;
  writeFile(path: string, content: string | Buffer, options?: AcceleratedFSWriteOptions): Promise<void>;
  appendFile(path: string, content: string | Buffer): Promise<void>;
  deleteFile(path: string, options?: { force?: boolean }): Promise<void>;
  copyFile(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void>;
  moveFile(src: string, dest: string, options?: { overwrite?: boolean }): Promise<void>;
  readdir(path: string, options?: AcceleratedFSListOptions): Promise<AcceleratedFSFileEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<AcceleratedFSFileStat>;
  grep?(pattern: string | RegExp, options?: AcceleratedFSGrepOptions): Promise<AcceleratedFSGrepMatch[]>;

  getInfo?(): MaybePromise<AcceleratedFSInfo>;
  getInstructions?(opts?: { requestContext?: unknown }): string;
}

export interface AcceleratedFSOptions extends Omit<MountConfig, "name" | "mode" | "cacheBytes"> {
  /** Unique Mastra filesystem instance id. Defaults to crypto.randomUUID(). */
  id?: string;

  /**
   * Internal S3CachedFs mount name. Defaults to the id. This is separate from
   * the Mastra provider name, which is always "AcceleratedFS".
   */
  mountName?: string;

  /** Cache bytes for the internal S3CachedFs mount. Required unless `filesystem` is supplied. */
  cacheBytes?: number;

  /** Cache root used by the internal S3CachedFsManager. Required unless a manager or filesystem is supplied. */
  cacheRoot?: string;

  /** Optional global cache budget passed to S3CachedFsManagerImpl. */
  totalCacheBytes?: number;

  /** Mastra read-only flag. When true, AcceleratedFS mounts the remote FS in readonly mode. */
  readOnly?: boolean;

  /** Explicit remote mount mode. Overrides readOnly when supplied. */
  mode?: "readonly" | "readwrite";

  /** Reuse an existing manager. Useful when multiple AcceleratedFS instances share one cache root. */
  manager?: S3CachedFsManager;

  /** Override object-store creation, mainly for tests or non-S3-compatible backends. */
  storeFactory?: ObjectStoreFactory;

  /** Use an already mounted S3CachedFs. */
  filesystem?: S3CachedFs;

  /** Whether destroy() should close a filesystem supplied via `filesystem`. Defaults to true. */
  closeSuppliedFilesystemOnDestroy?: boolean;

  displayName?: string;
  icon?: AcceleratedFSIcon;
  description?: string;
  instructions?: AcceleratedFSInstructions;
}

export class AcceleratedFSError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AcceleratedFSError";
  }
}

export class FileNotFoundError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`File not found: ${filePath}`, "ENOENT", filePath, cause);
    this.name = "FileNotFoundError";
  }
}

export class DirectoryNotFoundError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`Directory not found: ${filePath}`, "ENOENT", filePath, cause);
    this.name = "DirectoryNotFoundError";
  }
}

export class FileExistsError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`File already exists: ${filePath}`, "EEXIST", filePath, cause);
    this.name = "FileExistsError";
  }
}

export class AcceleratedFSIsDirectoryError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`Is a directory: ${filePath}`, "EISDIR", filePath, cause);
    this.name = "AcceleratedFSIsDirectoryError";
  }
}

export class AcceleratedFSNotDirectoryError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`Not a directory: ${filePath}`, "ENOTDIR", filePath, cause);
    this.name = "AcceleratedFSNotDirectoryError";
  }
}

export class DirectoryNotEmptyError extends AcceleratedFSError {
  constructor(filePath: string, cause?: unknown) {
    super(`Directory not empty: ${filePath}`, "ENOTEMPTY", filePath, cause);
    this.name = "DirectoryNotEmptyError";
  }
}

export class AcceleratedFSReadonlyFilesystemError extends AcceleratedFSError {
  constructor(operation: string, cause?: unknown) {
    super(`Filesystem is read-only; cannot ${operation}`, "EROFS", undefined, cause);
    this.name = "AcceleratedFSReadonlyFilesystemError";
  }
}

export class StaleFileError extends AcceleratedFSError {
  constructor(
    filePath: string,
    readonly expectedMtime: Date,
    readonly actualMtime: Date,
  ) {
    super(
      `Stale file: ${filePath}; expected mtime ${expectedMtime.toISOString()}, got ${actualMtime.toISOString()}`,
      "ESTALE",
      filePath,
    );
    this.name = "StaleFileError";
  }
}

/**
 * Mastra WorkspaceFilesystem provider backed by S3CachedFs.
 *
 * The class is intentionally structural: it has the shape Mastra expects, but
 * does not import @mastra/core. That keeps this package usable in constrained
 * Bun deployments where @mastra/core is provided by the application.
 */
export class AcceleratedFS implements MastraWorkspaceFilesystemLike {
  readonly id: string;
  readonly name = "AcceleratedFS";
  readonly provider = "accelerated-s3";
  readonly readOnly: boolean;
  readonly displayName?: string;
  readonly icon?: AcceleratedFSIcon;
  readonly description?: string;
  readonly basePath: string;

  private readonly mountName: string;
  private readonly mountMode: "readonly" | "readwrite";
  private readonly instructionsOverride: AcceleratedFSInstructions | undefined;
  private readonly closeSuppliedFilesystemOnDestroy: boolean;

  private manager: S3CachedFsManager | null;
  private fs: S3CachedFs | null;
  private initPromise: Promise<void> | null = null;
  private ownsManager = false;
  private _status: AcceleratedFSStatus = "pending";
  private _error: string | undefined;

  constructor(private readonly options: AcceleratedFSOptions) {
    this.id = options.id ?? crypto.randomUUID();
    this.mountName = options.mountName ?? this.id;
    this.mountMode = options.mode ?? (options.readOnly ? "readonly" : "readwrite");
    this.readOnly = this.mountMode === "readonly";
    this.manager = options.manager ?? null;
    this.fs = options.filesystem ?? null;
    this.ownsManager = !options.manager && !options.filesystem;
    this.closeSuppliedFilesystemOnDestroy = options.closeSuppliedFilesystemOnDestroy ?? true;
    this.instructionsOverride = options.instructions;
    if (options.displayName !== undefined) this.displayName = options.displayName;
    if (options.icon !== undefined) this.icon = options.icon;
    if (options.description !== undefined) this.description = options.description;
    this.basePath = this.remoteBasePath();
    if (this.fs) this._status = "ready";
  }

  get status(): AcceleratedFSStatus {
    return this._status;
  }

  get error(): string | undefined {
    return this._error;
  }

  async init(): Promise<void> {
    if (this._status === "destroyed" || this._status === "destroying") {
      throw new AcceleratedFSError("Filesystem has been destroyed", "EBADF");
    }
    if (this.fs) {
      this._status = "ready";
      this._error = undefined;
      return;
    }
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this._status = "initializing";
      this._error = undefined;
      try {
        let manager = this.manager;
        if (!manager) {
          if (!this.options.cacheRoot) {
            throw new AcceleratedFSError("cacheRoot is required unless manager or filesystem is supplied", "EINVAL");
          }
          const managerOptions: ConstructorParameters<typeof S3CachedFsManagerImpl>[0] = {
            cacheRoot: this.options.cacheRoot,
          };
          if (this.options.totalCacheBytes !== undefined) managerOptions.totalCacheBytes = this.options.totalCacheBytes;
          if (this.options.storeFactory !== undefined) managerOptions.storeFactory = this.options.storeFactory;
          manager = new S3CachedFsManagerImpl(managerOptions);
          this.manager = manager;
          this.ownsManager = true;
        }

        this.fs = await manager.mount({
          ...this.mountFields(),
          name: this.mountName,
          mode: this.mountMode,
        });
        this._status = "ready";
      } catch (err) {
        this._status = "error";
        this._error = err instanceof Error ? err.message : String(err);
        throw this.toMastraError(err, "/");
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async destroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this._status === "destroyed") return;
    this._status = "destroying";
    const fs = this.fs;
    const manager = this.manager;
    this.fs = null;
    this.manager = null;
    try {
      if (manager && this.ownsManager) {
        await manager.closeAll();
      } else if (manager) {
        await manager.unmount(this.mountName);
      } else if (fs && this.closeSuppliedFilesystemOnDestroy) {
        await fs.close();
      }
      this._status = "destroyed";
      this._error = undefined;
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      throw this.toMastraError(err, "/");
    }
  }

  async readFile(filePath: string, options: AcceleratedFSReadOptions = {}): Promise<string | Buffer> {
    const normalized = normalizeVfsPath(filePath);
    try {
      const fs = await this.ensureReady();
      const bytes = await fs.readFile(normalized);
      if (options.encoding === "binary") return toBuffer(bytes);
      const text = decodeBytes(bytes, options.encoding ?? "utf-8");
      return sliceLines(text, options.startLine, options.endLine);
    } catch (err) {
      throw this.toMastraError(err, normalized, "file");
    }
  }

  async writeFile(filePath: string, content: AcceleratedFSFileContent, options: AcceleratedFSWriteOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(filePath);
    this.assertWritable("writeFile");
    try {
      const fs = await this.ensureReady();
      if (!(options.recursive ?? false)) await this.assertParentDirectoryExists(fs, normalized);
      if (options.overwrite === false && await fs.exists(normalized)) throw new FileExistsError(normalized);
      if (options.expectedMtime) await this.assertExpectedMtime(fs, normalized, options.expectedMtime);
      await fs.writeFile(normalized, toWriteInput(content));
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, normalized, "file");
    }
  }

  async appendFile(filePath: string, content: AcceleratedFSFileContent, options: AcceleratedFSWriteOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(filePath);
    this.assertWritable("appendFile");
    try {
      const fs = await this.ensureReady();
      // Mastra appendFile creates the file and missing parents automatically.
      if (options.recursive === false) await this.assertParentDirectoryExists(fs, normalized);
      if (options.expectedMtime) await this.assertExpectedMtime(fs, normalized, options.expectedMtime);
      const suffix = contentToBytes(content);
      let prefix: Uint8Array = new Uint8Array();
      if (await fs.exists(normalized)) {
        const st = await fs.stat(normalized);
        if (st.kind === "dir") throw new AcceleratedFSIsDirectoryError(normalized);
        prefix = await fs.readFile(normalized);
      }
      const combined = new Uint8Array(prefix.byteLength + suffix.byteLength);
      combined.set(prefix, 0);
      combined.set(suffix, prefix.byteLength);
      await fs.writeFile(normalized, combined);
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, normalized, "file");
    }
  }

  async deleteFile(filePath: string, options: AcceleratedFSRemoveOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(filePath);
    this.assertWritable("deleteFile");
    try {
      const fs = await this.ensureReady();
      const st = await this.statOrNull(fs, normalized);
      if (!st) {
        if (options.force) return;
        throw new FileNotFoundError(normalized);
      }
      if (st.kind === "dir") throw new AcceleratedFSIsDirectoryError(normalized);
      await fs.unlink(normalized);
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, normalized, "file");
    }
  }

  async copyFile(src: string, dest: string, options: AcceleratedFSCopyOptions = {}): Promise<void> {
    const from = normalizeVfsPath(src);
    const to = normalizeVfsPath(dest);
    this.assertWritable("copyFile");
    try {
      const fs = await this.ensureReady();
      const sourceStat = await fs.stat(from);
      if (sourceStat.kind === "dir") {
        if (!options.recursive) throw new AcceleratedFSIsDirectoryError(from);
        await this.copyDirectory(fs, from, to, options);
        return;
      }
      if (options.overwrite === false && await fs.exists(to)) throw new FileExistsError(to);
      const bytes = await fs.readFile(from);
      await fs.writeFile(to, bytes, { mode: sourceStat.mode, mtimeMs: sourceStat.mtimeMs });
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, from, "file");
    }
  }

  async moveFile(src: string, dest: string, options: AcceleratedFSCopyOptions = {}): Promise<void> {
    const from = normalizeVfsPath(src);
    const to = normalizeVfsPath(dest);
    this.assertWritable("moveFile");
    try {
      const fs = await this.ensureReady();
      if (options.overwrite === false && await fs.exists(to)) throw new FileExistsError(to);
      await fs.rename(from, to);
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, from);
    }
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizeVfsPath(dirPath);
    this.assertWritable("mkdir");
    try {
      const fs = await this.ensureReady();
      const existing = await this.statOrNull(fs, normalized);
      if (existing) {
        if (existing.kind !== "dir") throw new FileExistsError(normalized);
        return;
      }
      if (!(options.recursive ?? false)) await this.assertParentDirectoryExists(fs, normalized);
      await fs.mkdir(normalized, { recursive: options.recursive ?? false });
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, normalized, "directory");
    }
  }

  async rmdir(dirPath: string, options: AcceleratedFSRemoveOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(dirPath);
    this.assertWritable("rmdir");
    try {
      const fs = await this.ensureReady();
      const st = await this.statOrNull(fs, normalized);
      if (!st) {
        if (options.force) return;
        throw new DirectoryNotFoundError(normalized);
      }
      if (st.kind !== "dir") throw new AcceleratedFSNotDirectoryError(normalized);
      if (!options.recursive) {
        const entries = await fs.readdir(normalized);
        if (entries.length > 0) throw new DirectoryNotEmptyError(normalized);
      }
      await fs.rm(normalized, { recursive: options.recursive ?? false, missingOk: options.force ?? false });
    } catch (err) {
      if (err instanceof AcceleratedFSError) throw err;
      throw this.toMastraError(err, normalized, "directory");
    }
  }

  async readdir(dirPath: string, options: AcceleratedFSListOptions = {}): Promise<AcceleratedFSFileEntry[]> {
    const normalized = normalizeVfsPath(dirPath);
    try {
      const fs = await this.ensureReady();
      const entries = await this.readdirInternal(fs, normalized, options, options.maxDepth ?? 100);
      return entries.filter(entry => matchesGlobList(entry.name, options.glob ?? options.pattern));
    } catch (err) {
      throw this.toMastraError(err, normalized, "directory");
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const normalized = normalizeVfsPath(filePath);
    try {
      const fs = await this.ensureReady();
      return await fs.exists(normalized);
    } catch (err) {
      throw this.toMastraError(err, normalized);
    }
  }

  async stat(filePath: string): Promise<AcceleratedFSFileStat> {
    const normalized = normalizeVfsPath(filePath);
    try {
      const fs = await this.ensureReady();
      return toMastraStat(await fs.stat(normalized), normalized);
    } catch (err) {
      throw this.toMastraError(err, normalized);
    }
  }

  async realpath(filePath: string): Promise<string> {
    const normalized = normalizeVfsPath(filePath);
    try {
      const fs = await this.ensureReady();
      await fs.stat(normalized);
      return normalized;
    } catch (err) {
      throw this.toMastraError(err, normalized);
    }
  }

  /**
   * Search file contents using a regular expression. Mastra exposes this as
   * the workspace grep/search-content tool; the core WorkspaceFilesystem
   * reference does not currently require a grep method, so this is safe as an
   * extra provider capability.
   */
  async grep(pattern: string | RegExp, options: AcceleratedFSGrepOptions = {}): Promise<AcceleratedFSGrepMatch[]> {
    const fs = await this.ensureReady();
    const basePath = normalizeVfsPath(options.path ?? "/");
    const baseStat = await fs.stat(basePath);
    const re = toSearchRegExp(pattern, options.caseSensitive ?? true);
    const maxResults = Math.max(1, options.maxResults ?? Number.POSITIVE_INFINITY);
    const maxCount = Math.max(1, options.maxCount ?? Number.POSITIVE_INFINITY);
    const contextLines = Math.max(0, Math.floor(options.contextLines ?? 0));
    const include = options.include ?? options.glob;
    const results: AcceleratedFSGrepMatch[] = [];

    const searchFile = async (filePath: string, relativeName: string): Promise<void> => {
      if (results.length >= maxResults) return;
      if (!matchesExtension(relativeName, options.extension)) return;
      if (!matchesGlobList(relativeName, include)) return;
      if (options.exclude !== undefined && matchesGlobList(relativeName, options.exclude)) return;

      const bytes = await fs.readFile(filePath);
      const text = decodeBytes(bytes, options.encoding ?? "utf-8");
      const lines = text.split(/\r?\n/);
      let fileMatches = 0;

      for (let i = 0; i < lines.length && fileMatches < maxCount && results.length < maxResults; i++) {
        const lineText = lines[i]!;
        re.lastIndex = 0;
        const match = re.exec(lineText);
        if (!match) continue;

        const item: AcceleratedFSGrepMatch = {
          path: filePath,
          line: i + 1,
          column: match.index + 1,
          match: match[0] ?? "",
          text: lineText,
        };
        if (contextLines > 0) {
          const before = lines.slice(Math.max(0, i - contextLines), i);
          const after = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
          if (before.length > 0) item.before = before;
          if (after.length > 0) item.after = after;
        }
        results.push(item);
        fileMatches++;
      }
    };

    const walk = async (dirPath: string, prefix: string): Promise<void> => {
      if (results.length >= maxResults) return;
      for (const entry of await fs.readdir(dirPath)) {
        if (results.length >= maxResults) return;
        const childName = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!options.includeHidden && entry.name.startsWith(".")) {
          // Mastra's search tools avoid hidden/token-sink paths by default; callers can
          // include them by targeting a hidden path directly via options.path.
          if (basePath !== entry.path && !basePath.includes("/.")) continue;
        }
        if (entry.kind === "dir") {
          await walk(entry.path, childName);
        } else if (entry.kind === "file") {
          await searchFile(entry.path, childName);
        }
      }
    };

    try {
      if (baseStat.kind === "file") {
        await searchFile(basePath, basename(basePath));
      } else {
        await walk(basePath, "");
      }
      return results;
    } catch (err) {
      throw this.toMastraError(err, basePath);
    }
  }

  async refresh(): Promise<void> {
    const fs = await this.ensureReady();
    await fs.refresh();
  }

  async readRange(filePath: string, offset: number, length: number): Promise<Uint8Array> {
    const normalized = normalizeVfsPath(filePath);
    const fs = await this.ensureReady();
    return fs.readRange(normalized, offset, length);
  }

  stream(filePath: string): ReadableStream<Uint8Array> {
    const normalized = normalizeVfsPath(filePath);
    let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        readerPromise ??= this.ensureReady().then(fs => fs.stream(normalized).getReader());
        const reader = await readerPromise;
        const chunk = await reader.read();
        if (chunk.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: async () => {
        const reader = await readerPromise;
        reader?.releaseLock();
      },
    });
  }

  async materialize(filePath: string, options?: MaterializeOptions): Promise<CachedFileLease> {
    const fs = await this.ensureReady();
    return fs.materialize(normalizeVfsPath(filePath), options);
  }

  async openWrite(filePath: string): Promise<WriteHandle> {
    this.assertWritable("openWrite");
    const fs = await this.ensureReady();
    return fs.openWrite(normalizeVfsPath(filePath));
  }

  async transaction<T>(fn: (tx: S3CachedFsTx) => Promise<T>): Promise<T> {
    this.assertWritable("transaction");
    const fs = await this.ensureReady();
    return fs.transaction(fn);
  }

  async underlying(): Promise<S3CachedFs> {
    return this.ensureReady();
  }

  /** Remote providers do not expose a stable host path for arbitrary files. */
  resolveAbsolutePath(_filePath: string): string | undefined {
    return undefined;
  }

  getInfo(): AcceleratedFSInfo<{
    mountName: string;
    bucket?: string;
    prefix: string;
    cacheRoot?: string;
    cacheBytes?: number;
    mode: "readonly" | "readwrite";
    accelerated: true;
  }> {
    const metadata: {
      mountName: string;
      bucket?: string;
      prefix: string;
      cacheRoot?: string;
      cacheBytes?: number;
      mode: "readonly" | "readwrite";
      accelerated: true;
    } = {
      mountName: this.mountName,
      prefix: this.options.prefix ?? "",
      mode: this.mountMode,
      accelerated: true,
    };
    if (this.options.bucket !== undefined) metadata.bucket = this.options.bucket;
    if (this.options.cacheRoot !== undefined) metadata.cacheRoot = this.options.cacheRoot;
    if (this.options.cacheBytes !== undefined) metadata.cacheBytes = this.options.cacheBytes;

    const info: AcceleratedFSInfo<typeof metadata> = {
      id: this.id,
      name: this.name,
      provider: this.provider,
      basePath: this.basePath,
      status: this._status,
      readOnly: this.readOnly,
      metadata,
    };
    if (this._error) info.error = this._error;
    if (this.icon !== undefined) info.icon = this.icon;
    if (this.options.cacheBytes !== undefined) info.storage = { totalBytes: this.options.cacheBytes };
    return info;
  }

  getInstructions(opts: { requestContext?: unknown } = {}): string {
    const defaultInstructions = this.defaultInstructions();
    if (typeof this.instructionsOverride === "string") return this.instructionsOverride;
    if (typeof this.instructionsOverride === "function") {
      return this.instructionsOverride({ defaultInstructions, requestContext: opts.requestContext });
    }
    return defaultInstructions;
  }

  private mountFields(): Omit<MountConfig, "name" | "mode"> {
    if (this.options.cacheBytes === undefined) {
      throw new AcceleratedFSError("cacheBytes is required unless filesystem is supplied", "EINVAL");
    }
    const out: Omit<MountConfig, "name" | "mode"> = {
      cacheBytes: this.options.cacheBytes,
    };
    const keys: Array<keyof Omit<MountConfig, "name" | "mode" | "cacheBytes">> = [
      "bucket",
      "prefix",
      "region",
      "endpoint",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "forcePathStyle",
      "chunkBytes",
      "smallFileBytes",
      "packBytes",
      "snapshotWalBytes",
      "snapshotTxCount",
      "materializeMaxBytes",
      "cacheReserveBytes",
      "lockTtlMs",
      "lockRenewMs",
      "readAheadChunks",
    ];
    for (const key of keys) {
      const value = this.options[key];
      if (value !== undefined) (out as any)[key] = value;
    }
    return out;
  }

  private async ensureReady(): Promise<S3CachedFs> {
    if (!this.fs) await this.init();
    if (!this.fs) throw new AcceleratedFSError("Filesystem is not initialized", "EBADF");
    if (this._status !== "ready") throw new AcceleratedFSError(`Filesystem is not ready; status=${this._status}`, "EBADF");
    return this.fs;
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) throw new AcceleratedFSReadonlyFilesystemError(operation);
  }

  private async assertParentDirectoryExists(fs: S3CachedFs, filePath: string): Promise<void> {
    const parent = parentPath(filePath);
    const st = await this.statOrNull(fs, parent);
    if (!st) throw new DirectoryNotFoundError(parent);
    if (st.kind !== "dir") throw new AcceleratedFSNotDirectoryError(parent);
  }

  private async assertExpectedMtime(fs: S3CachedFs, filePath: string, expected: Date): Promise<void> {
    const st = await this.statOrNull(fs, filePath);
    if (!st) throw new StaleFileError(filePath, expected, new Date(0));
    const actual = new Date(st.mtimeMs);
    if (actual.getTime() !== expected.getTime()) throw new StaleFileError(filePath, expected, actual);
  }

  private async statOrNull(fs: S3CachedFs, filePath: string): Promise<VfsStat | null> {
    try {
      return await fs.stat(filePath);
    } catch (err) {
      if (err instanceof VfsNotFoundError || (err instanceof VfsError && err.code === "ENOENT")) return null;
      throw err;
    }
  }

  private async copyDirectory(fs: S3CachedFs, from: string, to: string, options: AcceleratedFSCopyOptions): Promise<void> {
    const targetStat = await this.statOrNull(fs, to);
    if (targetStat) {
      if (targetStat.kind !== "dir") throw new FileExistsError(to);
      if (options.overwrite === false) throw new FileExistsError(to);
    } else {
      await fs.mkdir(to, { recursive: true });
    }

    const entries = await fs.readdir(from);
    for (const entry of entries) {
      const childFrom = joinChild(from, entry.name);
      const childTo = joinChild(to, entry.name);
      if (entry.kind === "dir") {
        await this.copyDirectory(fs, childFrom, childTo, options);
      } else if (entry.kind === "file") {
        if (options.overwrite === false && await fs.exists(childTo)) throw new FileExistsError(childTo);
        const st = await fs.stat(childFrom);
        const bytes = await fs.readFile(childFrom);
        await fs.writeFile(childTo, bytes, { mode: st.mode, mtimeMs: st.mtimeMs });
      }
    }
  }

  private async readdirInternal(
    fs: S3CachedFs,
    dirPath: string,
    options: AcceleratedFSListOptions,
    depth: number,
  ): Promise<AcceleratedFSFileEntry[]> {
    const entries = await fs.readdir(dirPath);
    const result: AcceleratedFSFileEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === "file" && !matchesExtension(entry.name, options.extension)) {
        // Extension filters apply only to files; directories are still walked in recursive mode.
      } else {
        const item: AcceleratedFSFileEntry = {
          name: entry.name,
          type: entry.kind === "dir" ? "directory" : "file",
        };
        if (entry.kind === "file") item.size = entry.size;
        result.push(item);
      }

      if (options.recursive && entry.kind === "dir" && depth > 0) {
        const subEntries = await this.readdirInternal(fs, entry.path, options, depth - 1);
        for (const sub of subEntries) {
          result.push({ ...sub, name: `${entry.name}/${sub.name}` });
        }
      }
    }
    return result;
  }

  private remoteBasePath(): string {
    const bucket = this.options.bucket;
    const prefix = (this.options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (!bucket) return prefix ? `acceleratedfs://${this.mountName}/${prefix}` : `acceleratedfs://${this.mountName}`;
    return prefix ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
  }

  private defaultInstructions(): string {
    const parts = [
      "AcceleratedFS is a remote cached filesystem backed by S3-compatible object storage.",
      "Use normal workspace paths such as /docs/guide.md or docs/guide.md; both resolve inside the AcceleratedFS root.",
      "Directory listings and stat calls are served from local SQLite metadata, while file contents are fetched through a bounded local cache.",
      "Writes are write-through and become visible atomically after the operation commits.",
    ];
    if (this.readOnly) {
      parts.push("This filesystem is read-only; write, delete, move, mkdir, and append operations are unavailable.");
    } else {
      parts.push("This filesystem supports one active writer and many readers; use batch operations when creating many small files.");
    }
    parts.push("It is not a host disk path, so command sandboxes cannot assume files exist on the local OS unless the application materializes them explicitly.");
    return parts.join(" ");
  }

  private toMastraError(err: unknown, filePath: string, expected?: "file" | "directory"): Error {
    if (err instanceof AcceleratedFSError) return err;
    if (err instanceof VfsReadonlyFilesystemError) return new AcceleratedFSReadonlyFilesystemError("write", err);
    if (err instanceof VfsIsDirectoryError || (err instanceof VfsError && err.code === "EISDIR")) return new AcceleratedFSIsDirectoryError(filePath, err);
    if (err instanceof VfsNotDirectoryError || (err instanceof VfsError && err.code === "ENOTDIR")) return new AcceleratedFSNotDirectoryError(filePath, err);
    if (err instanceof VfsNotFoundError || (err instanceof VfsError && err.code === "ENOENT")) {
      return expected === "directory" ? new DirectoryNotFoundError(filePath, err) : new FileNotFoundError(filePath, err);
    }
    if (err instanceof VfsError && err.code === "ENOTEMPTY") return new DirectoryNotEmptyError(filePath, err);
    if (err instanceof VfsError && err.code === "EEXIST") return new FileExistsError(filePath, err);
    if (err instanceof VfsError) return new AcceleratedFSError(err.message, err.code, filePath, err);
    if (err instanceof Error) return err;
    return new AcceleratedFSError(String(err), "EIO", filePath);
  }
}


function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function contentToBytes(content: AcceleratedFSFileContent): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function toWriteInput(content: AcceleratedFSFileContent): WriteInput {
  return typeof content === "string" ? content : contentToBytes(content);
}

function decodeBytes(bytes: Uint8Array, encoding: string): string {
  const normalized = encoding.toLowerCase() === "utf8" ? "utf-8" : encoding;
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    return toBuffer(bytes).toString(normalized);
  }
}

function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.max(start, endLine ?? lines.length);
  return lines.slice(start - 1, end).join("\n");
}

function toSearchRegExp(pattern: string | RegExp, caseSensitive: boolean): RegExp {
  const flags = caseSensitive ? "g" : "gi";
  if (pattern instanceof RegExp) {
    const merged = new Set((pattern.flags + flags).split(""));
    return new RegExp(pattern.source, Array.from(merged).join(""));
  }
  return new RegExp(pattern, flags);
}

function toMastraStat(stat: VfsStat, normalizedPath: string): AcceleratedFSFileStat {
  const out: AcceleratedFSFileStat = {
    name: normalizedPath === "/" ? "" : basename(normalizedPath),
    path: normalizedPath,
    type: stat.kind === "dir" ? "directory" : "file",
    size: stat.kind === "dir" ? 0 : stat.size,
    createdAt: new Date(stat.ctimeMs),
    modifiedAt: new Date(stat.mtimeMs),
  };
  const mimeType = stat.kind === "file" ? guessMimeType(normalizedPath) : undefined;
  if (mimeType) out.mimeType = mimeType;
  return out;
}

function matchesExtension(name: string, extension?: string | string[]): boolean {
  if (!extension) return true;
  const ext = fileExtension(name);
  const candidates = Array.isArray(extension) ? extension : [extension];
  return candidates.some(candidate => {
    const normalized = candidate.startsWith(".") ? candidate : `.${candidate}`;
    return ext === normalized;
  });
}

function matchesGlobList(value: string, patterns?: string | string[]): boolean {
  if (!patterns) return true;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  if (list.length === 0) return true;
  return list.some(pattern => globToRegExp(pattern).test(value));
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    const next = glob[i + 1];
    const afterNext = glob[i + 2];
    if (ch === "*" && next === "*" && afterNext === "/") {
      // Standard glob behavior: **/*.ts matches both a.ts and nested/a.ts.
      source += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(ch);
    }
  }
  source += "$";
  const re = new RegExp(source);
  globCache.set(glob, re);
  return re;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function fileExtension(name: string): string {
  const slash = name.lastIndexOf("/");
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

function joinChild(parent: string, child: string): string {
  return normalizeVfsPath(path.posix.join(parent, child));
}

function guessMimeType(filePath: string): string | undefined {
  const ext = fileExtension(filePath).toLowerCase();
  switch (ext) {
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".json": return "application/json";
    case ".jsonl": return "application/x-ndjson";
    case ".csv": return "text/csv";
    case ".html": return "text/html";
    case ".css": return "text/css";
    case ".js": return "text/javascript";
    case ".mjs": return "text/javascript";
    case ".ts": return "text/typescript";
    case ".tsx": return "text/typescript";
    case ".png": return "image/png";
    case ".jpg": return "image/jpeg";
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".pdf": return "application/pdf";
    case ".wasm": return "application/wasm";
    default: return undefined;
  }
}

export function isAcceleratedFS(value: unknown): value is AcceleratedFS {
  return value instanceof AcceleratedFS;
}

export {
  FileNotFoundError as AcceleratedFSFileNotFoundError,
  DirectoryNotFoundError as AcceleratedFSDirectoryNotFoundError,
  FileExistsError as AcceleratedFSFileExistsError,
  DirectoryNotEmptyError as AcceleratedFSDirectoryNotEmptyError,
  AcceleratedFSReadonlyFilesystemError as AcceleratedFSReadonlyError,
};

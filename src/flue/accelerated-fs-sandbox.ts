import type {
  ManagerConfig,
  MountConfig,
  ObjectStoreFactory,
  S3CachedFs,
  S3CachedFsManager,
} from "../types";
import { S3CachedFsManagerImpl, type S3CachedFsManagerOptions } from "../manager";
import { normalizeVfsPath } from "../util/path";
import {
  AcceleratedJustBashFs,
  AcceleratedJustBashShell,
  type AcceleratedJustBashExecOptions,
  type AcceleratedJustBashExecResult,
  type JustBashConstructorLike,
  type JustBashFsStat,
  type JustBashModuleLike,
} from "../just-bash/accelerated-just-bash-fs";

export interface FlueFileStatLike {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}

export interface FlueShellResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FlueExecOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FlueSandboxApiLike {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FlueFileStatLike>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  exec(command: string, options?: FlueExecOptionsLike): Promise<FlueShellResultLike>;
}

export interface FlueRuntimeModuleLike {
  createSandboxSessionEnv(api: FlueSandboxApiLike, cwd: string): unknown;
  SandboxOperationUnsupportedError?: new (message: string) => Error;
}

export interface FlueSandboxFactoryLike {
  createSessionEnv(options: { id: string }): Promise<unknown>;
  tools?: unknown;
}

export interface AcceleratedFlueSandboxOptions {
  /** Existing mounted filesystem. If supplied, mount/manager options are ignored. */
  filesystem?: S3CachedFs;

  /** Existing manager used when mount is supplied. */
  manager?: S3CachedFsManager;

  /** Manager options used when this adapter creates a manager. */
  managerConfig?: S3CachedFsManagerOptions;

  /** Convenience object-store override for tests and non-S3-compatible stores. */
  storeFactory?: ObjectStoreFactory;

  /** Mount config used when filesystem is not supplied. */
  mount?: MountConfig;

  /** Provider-owned base cwd passed to Flue. Defaults to `/workspace`. */
  cwd?: string;

  /** Create cwd on init when the filesystem is writable. Defaults to true. */
  ensureCwd?: boolean;

  /**
   * Existing just-bash constructor/module or custom importer. If omitted, the
   * adapter dynamically imports `just-bash` the first time exec() is called.
   */
  Bash?: JustBashConstructorLike;
  justBashModule?: JustBashModuleLike;
  importJustBash?: () => Promise<JustBashModuleLike>;
  bashOptions?: Record<string, unknown>;

  /** Override Flue runtime import, mainly for tests. */
  runtime?: FlueRuntimeModuleLike;
  importFlueRuntime?: () => Promise<FlueRuntimeModuleLike>;

  /** Prime just-bash getAllPaths() with a full tree walk. Expensive on large workspaces. */
  primePathCache?: boolean;

  /** Persist just-bash symlink metadata into the AcceleratedFS workspace. Defaults to true. */
  persistSymlinks?: boolean;

  symlinkMetadataPath?: string;

  /**
   * Close resources created by this adapter when close() is called. Flue does
   * not call close() automatically; the application owns sandbox lifetime.
   *
   * Default: true when this adapter created its own manager, false when an
   * existing filesystem was supplied.
   */
  closeOnClose?: boolean;
}

export class AcceleratedFlueSandboxApi implements FlueSandboxApiLike {
  constructor(
    readonly fs: AcceleratedJustBashFs,
    readonly shell: AcceleratedJustBashShell,
  ) {}

  async readFile(filePath: string): Promise<string> {
    return this.fs.readFile(filePath, "utf8");
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    return this.fs.readFileBuffer(filePath);
  }

  async writeFile(filePath: string, content: string | Uint8Array): Promise<void> {
    await this.fs.writeFile(filePath, content);
  }

  async stat(filePath: string): Promise<FlueFileStatLike> {
    return toFlueStat(await this.fs.stat(filePath));
  }

  async readdir(dirPath: string): Promise<string[]> {
    return this.fs.readdir(dirPath);
  }

  async exists(filePath: string): Promise<boolean> {
    return this.fs.exists(filePath);
  }

  async mkdir(dirPath: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.fs.mkdir(dirPath, { recursive: options.recursive ?? false });
  }

  async rm(filePath: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.fs.rm(filePath, { recursive: options.recursive ?? false, force: options.force ?? false });
  }

  async exec(command: string, options: FlueExecOptionsLike = {}): Promise<FlueShellResultLike> {
    const execOptions: AcceleratedJustBashExecOptions = {};
    if (options.cwd !== undefined) execOptions.cwd = options.cwd;
    if (options.env !== undefined) execOptions.env = options.env;
    if (options.timeoutMs !== undefined) execOptions.timeoutMs = options.timeoutMs;
    if (options.signal !== undefined) execOptions.signal = options.signal;
    const result: AcceleratedJustBashExecResult = await this.shell.exec(command, execOptions);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
}

export class AcceleratedFlueSandbox implements FlueSandboxFactoryLike {
  private fsPromise: Promise<S3CachedFs> | null = null;
  private justFsPromise: Promise<AcceleratedJustBashFs> | null = null;
  private shellPromise: Promise<AcceleratedJustBashShell> | null = null;
  private apiPromise: Promise<AcceleratedFlueSandboxApi> | null = null;
  private manager: S3CachedFsManager | null = null;
  private ownsManager = false;
  private closed = false;

  constructor(private readonly options: AcceleratedFlueSandboxOptions) {}

  async createSessionEnv(_options: { id: string }): Promise<unknown> {
    if (this.closed) throw new Error("AcceleratedFlueSandbox is closed");
    const runtime = this.options.runtime ?? await (this.options.importFlueRuntime ?? importFlueRuntime)();
    if (typeof runtime.createSandboxSessionEnv !== "function") {
      throw new Error("@flue/runtime did not export createSandboxSessionEnv");
    }
    const api = await this.getApi();
    return runtime.createSandboxSessionEnv(api, normalizeVfsPath(this.options.cwd ?? "/workspace"));
  }

  async api(): Promise<AcceleratedFlueSandboxApi> {
    return this.getApi();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const shell = this.shellPromise ? await this.shellPromise.catch(() => null) : null;
    await shell?.close();
    const shouldCloseOwnedResources = this.options.closeOnClose ?? this.ownsManager;
    if (shouldCloseOwnedResources) {
      if (this.ownsManager && this.manager) {
        await this.manager.closeAll();
      } else if (!this.manager && this.options.filesystem) {
        await this.options.filesystem.close();
      }
    }
  }

  private async getApi(): Promise<AcceleratedFlueSandboxApi> {
    if (!this.apiPromise) {
      this.apiPromise = (async () => new AcceleratedFlueSandboxApi(await this.getJustFs(), await this.getShell()))();
    }
    return this.apiPromise;
  }

  private async getJustFs(): Promise<AcceleratedJustBashFs> {
    if (!this.justFsPromise) {
      this.justFsPromise = (async () => {
        const justFsOptions: ConstructorParameters<typeof AcceleratedJustBashFs>[1] = { primePathCache: false };
        if (this.options.persistSymlinks !== undefined) justFsOptions.persistSymlinks = this.options.persistSymlinks;
        if (this.options.symlinkMetadataPath !== undefined) justFsOptions.symlinkMetadataPath = this.options.symlinkMetadataPath;
        const fs = new AcceleratedJustBashFs(await this.getFilesystem(), justFsOptions);
        if (this.options.primePathCache) await fs.refreshPathCache();
        if (this.options.ensureCwd ?? true) {
          await fs.mkdir(normalizeVfsPath(this.options.cwd ?? "/workspace"), { recursive: true }).catch(() => {});
        }
        return fs;
      })();
    }
    return this.justFsPromise;
  }

  private async getShell(): Promise<AcceleratedJustBashShell> {
    if (!this.shellPromise) {
      this.shellPromise = (async () => {
        const shellOptions: ConstructorParameters<typeof AcceleratedJustBashShell>[1] = {
          cwd: normalizeVfsPath(this.options.cwd ?? "/workspace"),
          closeFilesystemOnClose: false,
        };
        if (this.options.Bash !== undefined) shellOptions.Bash = this.options.Bash;
        if (this.options.justBashModule !== undefined) shellOptions.justBashModule = this.options.justBashModule;
        if (this.options.importJustBash !== undefined) shellOptions.importJustBash = this.options.importJustBash;
        if (this.options.bashOptions !== undefined) shellOptions.bashOptions = this.options.bashOptions;
        return new AcceleratedJustBashShell(await this.getJustFs(), shellOptions);
      })();
    }
    return this.shellPromise;
  }

  private async getFilesystem(): Promise<S3CachedFs> {
    if (!this.fsPromise) {
      this.fsPromise = (async () => {
        if (this.options.filesystem) return this.options.filesystem;
        if (!this.options.mount) throw new Error("acceleratedFsSandbox requires either filesystem or mount");

        if (this.options.manager) {
          this.manager = this.options.manager;
          return this.options.manager.mount(this.options.mount);
        }

        const managerConfig: ManagerConfig = this.options.managerConfig ?? { cacheRoot: "/tmp/accelerated-fs-flue" };
        const managerOptions: S3CachedFsManagerOptions = { ...managerConfig };
        if (this.options.storeFactory !== undefined) managerOptions.storeFactory = this.options.storeFactory;
        const manager = new S3CachedFsManagerImpl(managerOptions);
        this.manager = manager;
        this.ownsManager = true;
        return manager.mount(this.options.mount);
      })();
    }
    return this.fsPromise;
  }
}

export function acceleratedFsSandbox(options: AcceleratedFlueSandboxOptions): AcceleratedFlueSandbox {
  return new AcceleratedFlueSandbox(options);
}

async function importFlueRuntime(): Promise<FlueRuntimeModuleLike> {
  const moduleName = "@flue/runtime";
  return await import(moduleName) as unknown as FlueRuntimeModuleLike;
}

function toFlueStat(stat: JustBashFsStat): FlueFileStatLike {
  const out: FlueFileStatLike = {
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
  };
  if (stat.isSymbolicLink) out.isSymbolicLink = true;
  if (stat.isFile) out.size = stat.size;
  out.mtime = stat.mtime;
  return out;
}

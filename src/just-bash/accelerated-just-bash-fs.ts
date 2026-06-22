import path from "node:path";
import type {
  ManagerConfig,
  MountConfig,
  ObjectStoreFactory,
  S3CachedFs,
  S3CachedFsManager,
  VfsDirent,
  VfsStat,
  WriteInput,
} from "../types";
import {
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  ReadonlyFilesystemError,
  VfsError,
} from "../types";
import { S3CachedFsManagerImpl, type S3CachedFsManagerOptions } from "../manager";
import { normalizeVfsPath, parentPath, basename } from "../util/path";

export type JustBashBufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

export type JustBashFileContent = string | Uint8Array;

export interface JustBashReadFileOptions {
  encoding?: JustBashBufferEncoding | null;
}

export interface JustBashWriteFileOptions {
  encoding?: JustBashBufferEncoding;
}

export interface JustBashDirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface JustBashFsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface JustBashMkdirOptions {
  recursive?: boolean;
}

export interface JustBashRmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface JustBashCpOptions {
  recursive?: boolean;
}

/**
 * Structural copy of just-bash's IFileSystem shape.
 *
 * The package intentionally does not import just-bash types at runtime. When a
 * project has just-bash installed, AcceleratedJustBashFs is assignable to the
 * fs option expected by `new Bash({ fs })`.
 */
export interface JustBashFileSystemLike {
  readFile(path: string, options?: JustBashReadFileOptions | JustBashBufferEncoding): Promise<string>;
  readFileBytes?(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: JustBashFileContent, options?: JustBashWriteFileOptions | JustBashBufferEncoding): Promise<void>;
  appendFile(path: string, content: JustBashFileContent, options?: JustBashWriteFileOptions | JustBashBufferEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<JustBashFsStat>;
  mkdir(path: string, options?: JustBashMkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<JustBashDirentEntry[]>;
  rm(path: string, options?: JustBashRmOptions): Promise<void>;
  cp(src: string, dest: string, options?: JustBashCpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  lstat(path: string): Promise<JustBashFsStat>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

export interface AcceleratedJustBashFsOptions {
  /** Underlying cached S3 filesystem. */
  filesystem: S3CachedFs;

  /**
   * Persist just-bash symlink metadata as a small hidden JSON file in the
   * underlying filesystem. Defaults to true.
   */
  persistSymlinks?: boolean;

  /** Hidden JSON file used when persistSymlinks is true. */
  symlinkMetadataPath?: string;

  /**
   * Prime getAllPaths() from the remote namespace on construction via
   * refreshPathCache(). This can be expensive on very large trees, so the
   * default is false. The wrapper still updates the cache as commands touch
   * paths.
   */
  primePathCache?: boolean;

  /** Ignore the hidden symlink metadata file in readdir/getAllPaths. Defaults to true. */
  hideMetadataFile?: boolean;
}

export interface CreateAcceleratedJustBashFsOptions extends Omit<AcceleratedJustBashFsOptions, "filesystem"> {
  filesystem?: S3CachedFs;
  manager?: S3CachedFsManager;
  managerConfig?: S3CachedFsManagerOptions;
  storeFactory?: ObjectStoreFactory;
  mount?: MountConfig;
}

export interface AcceleratedJustBashExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  args?: string[];
  replaceEnv?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  rawScript?: boolean;
}

export interface AcceleratedJustBashExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface JustBashConstructorLike {
  new (options?: Record<string, unknown>): {
    exec(command: string, options?: Record<string, unknown>): Promise<AcceleratedJustBashExecResult>;
    fs?: unknown;
  };
}

export interface JustBashModuleLike {
  Bash: JustBashConstructorLike;
}

export interface AcceleratedJustBashShellOptions extends CreateAcceleratedJustBashFsOptions {
  /** Existing filesystem wrapper. Overrides filesystem/mount creation. */
  justBashFs?: AcceleratedJustBashFs;

  /** Existing Bash constructor, useful for tests or when bundlers cannot use dynamic import. */
  Bash?: JustBashConstructorLike;

  /** Existing module object with a Bash export. */
  justBashModule?: JustBashModuleLike;

  /** Override how the just-bash package is imported. */
  importJustBash?: () => Promise<JustBashModuleLike>;

  /** Passed through to `new Bash({ ...bashOptions, fs, cwd })`. */
  bashOptions?: Record<string, unknown>;

  /** Starting cwd for just-bash. Defaults to `/`. */
  cwd?: string;

  /** Close the underlying filesystem when this shell closes. Defaults to false. */
  closeFilesystemOnClose?: boolean;
}

interface SymlinkEntry {
  target: string;
  mtimeMs: number;
  mode: number;
}

interface SymlinkStoreFileV1 {
  format: 1;
  entries: Array<{ path: string; target: string; mtimeMs: number; mode?: number }>;
}

const DEFAULT_SYMLINK_METADATA_PATH = "/.acceleratedfs.just-bash.symlinks.json";
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const SYMLINK_MODE = 0o120777;
const MAX_SYMLINK_DEPTH = 40;

export class JustBashFsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JustBashFsError";
  }
}

export class AcceleratedJustBashFs implements JustBashFileSystemLike {
  readonly symlinkMetadataPath: string;
  readonly persistSymlinks: boolean;
  readonly hideMetadataFile: boolean;

  private readonly symlinks = new Map<string, SymlinkEntry>();
  private symlinksLoaded = false;
  private symlinkLoadPromise: Promise<void> | null = null;
  private symlinkSavePromise: Promise<void> = Promise.resolve();
  private readonly pathCache = new Set<string>(["/"]);

  constructor(private readonly fs: S3CachedFs, options: Omit<AcceleratedJustBashFsOptions, "filesystem"> = {}) {
    this.persistSymlinks = options.persistSymlinks ?? true;
    this.symlinkMetadataPath = normalizeVfsPath(options.symlinkMetadataPath ?? DEFAULT_SYMLINK_METADATA_PATH);
    this.hideMetadataFile = options.hideMetadataFile ?? true;
    if (options.primePathCache) {
      // Fire and forget by design: constructors cannot be async. Shell helpers
      // await refreshPathCache() explicitly when they need a primed cache.
      this.refreshPathCache().catch(() => {});
    }
  }

  underlying(): S3CachedFs {
    return this.fs;
  }

  async readFile(filePath: string, options?: JustBashReadFileOptions | JustBashBufferEncoding): Promise<string> {
    const bytes = await this.readFileBuffer(filePath);
    return decodeForRead(bytes, readEncoding(options));
  }

  async readFileBytes(filePath: string): Promise<string> {
    const bytes = await this.readFileBuffer(filePath);
    return bytesToLatin1(bytes);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      return await this.fs.readFile(resolved);
    } catch (err) {
      throw this.toFsError(err, filePath, "open");
    }
  }

  async writeFile(
    filePath: string,
    content: JustBashFileContent,
    options?: JustBashWriteFileOptions | JustBashBufferEncoding,
  ): Promise<void> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      const bytes = encodeForWrite(content, writeEncoding(options));
      await this.fs.writeFile(resolved, bytes);
      this.addPathAndParents(resolved);
    } catch (err) {
      throw this.toFsError(err, filePath, "write");
    }
  }

  async appendFile(
    filePath: string,
    content: JustBashFileContent,
    options?: JustBashWriteFileOptions | JustBashBufferEncoding,
  ): Promise<void> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      const suffix = encodeForWrite(content, writeEncoding(options));
      let prefix: Uint8Array = new Uint8Array();
      if (await this.fs.exists(resolved)) {
        const st = await this.fs.stat(resolved);
        if (st.kind === "dir") throw new IsDirectoryError(resolved);
        prefix = await this.fs.readFile(resolved);
      }
      const combined = new Uint8Array(prefix.byteLength + suffix.byteLength);
      combined.set(prefix, 0);
      combined.set(suffix, prefix.byteLength);
      await this.fs.writeFile(resolved, combined);
      this.addPathAndParents(resolved);
    } catch (err) {
      throw this.toFsError(err, filePath, "append");
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      const resolved = await this.resolvePathWithSymlinks(filePath, true);
      return await this.fs.exists(resolved);
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<JustBashFsStat> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      return toJustBashStat(await this.fs.stat(resolved), false);
    } catch (err) {
      throw this.toFsError(err, filePath, "stat");
    }
  }

  async lstat(filePath: string): Promise<JustBashFsStat> {
    const normalized = normalizeVfsPath(filePath);
    await this.loadSymlinks();
    const symlink = this.symlinks.get(normalized);
    if (symlink) {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: symlink.mode,
        size: new TextEncoder().encode(symlink.target).byteLength,
        mtime: new Date(symlink.mtimeMs),
      };
    }

    const resolved = await this.resolvePathWithSymlinks(normalized, false);
    try {
      return toJustBashStat(await this.fs.stat(resolved), false);
    } catch (err) {
      throw this.toFsError(err, filePath, "lstat");
    }
  }

  async mkdir(dirPath: string, options: JustBashMkdirOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(dirPath);
    await this.loadSymlinks();
    if (this.symlinks.has(normalized)) throw fsError("EEXIST", `EEXIST: file already exists, mkdir '${dirPath}'`, dirPath);

    const resolved = await this.resolvePathWithSymlinks(normalized, false);
    try {
      const existing = await this.statOrNull(resolved);
      if (existing) {
        if (existing.kind !== "dir") throw fsError("EEXIST", `EEXIST: file already exists, mkdir '${dirPath}'`, dirPath);
        if (!options.recursive) throw fsError("EEXIST", `EEXIST: directory already exists, mkdir '${dirPath}'`, dirPath);
        return;
      }
      if (!options.recursive) {
        const parent = await this.statOrNull(parentPath(resolved));
        if (!parent) throw fsError("ENOENT", `ENOENT: no such file or directory, mkdir '${dirPath}'`, dirPath);
        if (parent.kind !== "dir") throw fsError("ENOTDIR", `ENOTDIR: not a directory, mkdir '${dirPath}'`, dirPath);
      }
      await this.fs.mkdir(resolved, { recursive: options.recursive ?? false });
      this.addPathAndParents(resolved);
    } catch (err) {
      if (err instanceof JustBashFsError) throw err;
      throw this.toFsError(err, dirPath, "mkdir");
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(dirPath);
    return entries.map(entry => entry.name);
  }

  async readdirWithFileTypes(dirPath: string): Promise<JustBashDirentEntry[]> {
    const normalized = normalizeVfsPath(dirPath);
    const resolved = await this.resolvePathWithSymlinks(normalized, true);
    await this.loadSymlinks();
    try {
      const entries = new Map<string, JustBashDirentEntry>();
      for (const entry of await this.fs.readdir(resolved)) {
        if (this.shouldHidePath(entry.path)) continue;
        entries.set(entry.name, {
          name: entry.name,
          isFile: entry.kind === "file",
          isDirectory: entry.kind === "dir",
          isSymbolicLink: entry.kind === "symlink",
        });
        this.addPathAndParents(entry.path);
      }

      for (const [linkPath] of this.symlinks) {
        if (this.shouldHidePath(linkPath)) continue;
        if (parentPath(linkPath) !== resolved) continue;
        const name = basename(linkPath);
        if (!entries.has(name)) {
          entries.set(name, { name, isFile: false, isDirectory: false, isSymbolicLink: true });
          this.addPathAndParents(linkPath);
        }
      }

      return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      throw this.toFsError(err, dirPath, "scandir");
    }
  }

  async rm(filePath: string, options: JustBashRmOptions = {}): Promise<void> {
    const normalized = normalizeVfsPath(filePath);
    if (normalized === "/") throw fsError("EBUSY", "Cannot remove filesystem root", filePath);
    await this.loadSymlinks();

    const exactLink = this.symlinks.get(normalized);
    if (exactLink) {
      this.symlinks.delete(normalized);
      this.removePathPrefix(normalized);
      await this.saveSymlinks();
      return;
    }

    const resolved = await this.resolvePathWithSymlinks(normalized, false);
    try {
      await this.fs.rm(resolved, { recursive: options.recursive ?? false, missingOk: options.force ?? false });
      this.removePathPrefix(resolved);
      this.removeSymlinksUnder(resolved);
      await this.saveSymlinks();
    } catch (err) {
      throw this.toFsError(err, filePath, "rm");
    }
  }

  async cp(src: string, dest: string, options: JustBashCpOptions = {}): Promise<void> {
    const from = normalizeVfsPath(src);
    const to = normalizeVfsPath(dest);
    await this.loadSymlinks();

    const srcLink = this.symlinks.get(from);
    if (srcLink) {
      await this.symlink(srcLink.target, to);
      return;
    }

    const resolvedSrc = await this.resolvePathWithSymlinks(from, true);
    const resolvedDest = await this.resolvePathWithSymlinks(to, false);
    try {
      const st = await this.fs.stat(resolvedSrc);
      if (st.kind === "dir") {
        if (!options.recursive) throw fsError("EISDIR", `EISDIR: is a directory, cp '${src}'`, src);
        await this.copyDirectory(resolvedSrc, resolvedDest);
      } else {
        const bytes = await this.fs.readFile(resolvedSrc);
        await this.fs.writeFile(resolvedDest, bytes, { mode: st.mode, mtimeMs: st.mtimeMs });
        this.addPathAndParents(resolvedDest);
      }
    } catch (err) {
      if (err instanceof JustBashFsError) throw err;
      throw this.toFsError(err, src, "cp");
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = normalizeVfsPath(src);
    const to = normalizeVfsPath(dest);
    await this.loadSymlinks();

    const srcLink = this.symlinks.get(from);
    if (srcLink) {
      if (await this.existsForCreate(to)) throw fsError("EEXIST", `EEXIST: file already exists, rename '${dest}'`, dest);
      this.symlinks.delete(from);
      this.symlinks.set(to, { ...srcLink, mtimeMs: Date.now() });
      this.renamePathPrefix(from, to);
      await this.saveSymlinks();
      return;
    }

    const resolvedSrc = await this.resolvePathWithSymlinks(from, false);
    const resolvedDest = await this.resolvePathWithSymlinks(to, false);
    try {
      await this.fs.rename(resolvedSrc, resolvedDest);
      this.renamePathPrefix(resolvedSrc, resolvedDest);
      this.renameSymlinksUnder(resolvedSrc, resolvedDest);
      await this.saveSymlinks();
    } catch (err) {
      throw this.toFsError(err, src, "rename");
    }
  }

  resolvePath(base: string, targetPath: string): string {
    if (targetPath.startsWith("/")) return normalizeVfsPath(targetPath);
    return normalizeVfsPath(path.posix.resolve(normalizeVfsPath(base), targetPath));
  }

  getAllPaths(): string[] {
    const paths = new Set(this.pathCache);
    for (const linkPath of this.symlinks.keys()) {
      if (!this.shouldHidePath(linkPath)) paths.add(linkPath);
    }
    return Array.from(paths).filter(p => !this.shouldHidePath(p)).sort();
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      const st = await this.fs.stat(resolved);
      if (st.kind === "dir") return;
      const bytes = await this.fs.readFile(resolved);
      await this.fs.writeFile(resolved, bytes, { mode, mtimeMs: st.mtimeMs });
    } catch (err) {
      throw this.toFsError(err, filePath, "chmod");
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const normalized = normalizeVfsPath(linkPath);
    if (normalized === "/") throw fsError("EEXIST", `EEXIST: file already exists, symlink '${linkPath}'`, linkPath);
    await this.loadSymlinks();
    if (await this.existsForCreate(normalized)) throw fsError("EEXIST", `EEXIST: file already exists, symlink '${linkPath}'`, linkPath);
    const parent = await this.resolvePathWithSymlinks(parentPath(normalized), true);
    const parentStat = await this.statOrNull(parent);
    if (!parentStat) throw fsError("ENOENT", `ENOENT: no such file or directory, symlink '${linkPath}'`, linkPath);
    if (parentStat.kind !== "dir") throw fsError("ENOTDIR", `ENOTDIR: not a directory, symlink '${linkPath}'`, linkPath);
    this.symlinks.set(normalized, { target, mode: SYMLINK_MODE, mtimeMs: Date.now() });
    this.addPathAndParents(normalized);
    await this.saveSymlinks();
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    // S3CachedFs does not expose inode-level hard links. Copying bytes gives the
    // behavior just-bash commands need while preserving isolation and durability.
    await this.cp(existingPath, newPath, { recursive: false });
  }

  async readlink(filePath: string): Promise<string> {
    const normalized = normalizeVfsPath(filePath);
    await this.loadSymlinks();
    const entry = this.symlinks.get(normalized);
    if (!entry) throw fsError("EINVAL", `EINVAL: invalid argument, readlink '${filePath}'`, filePath);
    return entry.target;
  }

  async realpath(filePath: string): Promise<string> {
    const resolved = await this.resolvePathWithSymlinks(filePath, true);
    try {
      await this.fs.stat(resolved);
      return resolved;
    } catch (err) {
      throw this.toFsError(err, filePath, "realpath");
    }
  }

  async utimes(filePath: string, _atime: Date, mtime: Date): Promise<void> {
    const normalized = normalizeVfsPath(filePath);
    await this.loadSymlinks();
    const link = this.symlinks.get(normalized);
    if (link) {
      this.symlinks.set(normalized, { ...link, mtimeMs: mtime.getTime() });
      await this.saveSymlinks();
      return;
    }

    const resolved = await this.resolvePathWithSymlinks(normalized, true);
    try {
      const st = await this.fs.stat(resolved);
      if (st.kind === "dir") return;
      const bytes = await this.fs.readFile(resolved);
      await this.fs.writeFile(resolved, bytes, { mode: st.mode, mtimeMs: mtime.getTime() });
    } catch (err) {
      throw this.toFsError(err, filePath, "utimes");
    }
  }

  /** Expensive full tree walk used when exact glob expansion is more important than mount speed. */
  async refreshPathCache(): Promise<void> {
    await this.loadSymlinks();
    this.pathCache.clear();
    this.pathCache.add("/");
    const walk = async (dirPath: string): Promise<void> => {
      let entries: VfsDirent[];
      try {
        entries = await this.fs.readdir(dirPath);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (this.shouldHidePath(entry.path)) continue;
        this.pathCache.add(entry.path);
        if (entry.kind === "dir") await walk(entry.path);
      }
    };
    await walk("/");
    for (const linkPath of this.symlinks.keys()) this.addPathAndParents(linkPath);
  }

  private async copyDirectory(from: string, to: string): Promise<void> {
    await this.fs.mkdir(to, { recursive: true });
    this.addPathAndParents(to);
    for (const entry of await this.fs.readdir(from)) {
      const childFrom = joinVfs(from, entry.name);
      const childTo = joinVfs(to, entry.name);
      if (entry.kind === "dir") {
        await this.copyDirectory(childFrom, childTo);
      } else if (entry.kind === "file") {
        const st = await this.fs.stat(childFrom);
        const bytes = await this.fs.readFile(childFrom);
        await this.fs.writeFile(childTo, bytes, { mode: st.mode, mtimeMs: st.mtimeMs });
        this.addPathAndParents(childTo);
      }
    }
  }

  private async statOrNull(filePath: string): Promise<VfsStat | null> {
    try {
      return await this.fs.stat(filePath);
    } catch (err) {
      if (err instanceof NotFoundError || (err instanceof VfsError && err.code === "ENOENT")) return null;
      throw err;
    }
  }

  private async existsForCreate(filePath: string): Promise<boolean> {
    if (this.symlinks.has(filePath)) return true;
    return await this.fs.exists(filePath);
  }

  private async loadSymlinks(): Promise<void> {
    if (this.symlinksLoaded) return;
    if (this.symlinkLoadPromise) return this.symlinkLoadPromise;
    this.symlinkLoadPromise = (async () => {
      this.symlinksLoaded = true;
      this.symlinks.clear();
      if (!this.persistSymlinks) return;
      try {
        if (!(await this.fs.exists(this.symlinkMetadataPath))) return;
        const bytes = await this.fs.readFile(this.symlinkMetadataPath);
        const text = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(text) as Partial<SymlinkStoreFileV1>;
        if (parsed.format !== 1 || !Array.isArray(parsed.entries)) return;
        for (const entry of parsed.entries) {
          if (!entry || typeof entry.path !== "string" || typeof entry.target !== "string") continue;
          const linkPath = normalizeVfsPath(entry.path);
          this.symlinks.set(linkPath, {
            target: entry.target,
            mtimeMs: Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : Date.now(),
            mode: entry.mode ?? SYMLINK_MODE,
          });
          this.addPathAndParents(linkPath);
        }
      } catch {
        // Corrupt symlink metadata should not make the whole filesystem unusable.
        // New symlink writes will replace the metadata file.
      }
    })();
    try {
      await this.symlinkLoadPromise;
    } finally {
      this.symlinkLoadPromise = null;
    }
  }

  private async saveSymlinks(): Promise<void> {
    if (!this.persistSymlinks) return;
    this.symlinkSavePromise = this.symlinkSavePromise.then(async () => {
      const entries = Array.from(this.symlinks.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([linkPath, entry]) => ({ path: linkPath, target: entry.target, mtimeMs: entry.mtimeMs, mode: entry.mode }));
      const doc: SymlinkStoreFileV1 = { format: 1, entries };
      await this.fs.writeFile(this.symlinkMetadataPath, JSON.stringify(doc, null, 2));
      this.addPathAndParents(this.symlinkMetadataPath);
    });
    await this.symlinkSavePromise;
  }

  private async resolvePathWithSymlinks(input: string, followFinal: boolean): Promise<string> {
    await this.loadSymlinks();
    let current = normalizeVfsPath(input);
    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      const next = this.resolveOneSymlinkPass(current, followFinal);
      if (next === current) return current;
      current = next;
    }
    throw fsError("ELOOP", `ELOOP: too many levels of symbolic links, open '${input}'`, input);
  }

  private resolveOneSymlinkPass(input: string, followFinal: boolean): string {
    const normalized = normalizeVfsPath(input);
    if (normalized === "/") return normalized;
    const parts = normalized.slice(1).split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      current = current ? `${current}/${part}` : `/${part}`;
      const isFinal = i === parts.length - 1;
      if (isFinal && !followFinal) continue;
      const link = this.symlinks.get(current);
      if (!link) continue;
      const target = resolveSymlinkTarget(current, link.target);
      const rest = parts.slice(i + 1).join("/");
      return normalizeVfsPath(rest ? path.posix.join(target, rest) : target);
    }
    return normalized;
  }

  private removeSymlinksUnder(basePath: string): void {
    for (const linkPath of Array.from(this.symlinks.keys())) {
      if (linkPath === basePath || linkPath.startsWith(`${basePath}/`)) this.symlinks.delete(linkPath);
    }
  }

  private renameSymlinksUnder(from: string, to: string): void {
    for (const [linkPath, entry] of Array.from(this.symlinks.entries())) {
      if (linkPath !== from && !linkPath.startsWith(`${from}/`)) continue;
      const suffix = linkPath === from ? "" : linkPath.slice(from.length);
      this.symlinks.delete(linkPath);
      this.symlinks.set(normalizeVfsPath(`${to}${suffix}`), entry);
    }
  }

  private addPathAndParents(filePath: string): void {
    let current = normalizeVfsPath(filePath);
    while (true) {
      if (!this.shouldHidePath(current)) this.pathCache.add(current);
      if (current === "/") return;
      current = parentPath(current);
    }
  }

  private removePathPrefix(filePath: string): void {
    const normalized = normalizeVfsPath(filePath);
    for (const item of Array.from(this.pathCache)) {
      if (item === normalized || item.startsWith(`${normalized}/`)) this.pathCache.delete(item);
    }
  }

  private renamePathPrefix(from: string, to: string): void {
    const normalizedFrom = normalizeVfsPath(from);
    const normalizedTo = normalizeVfsPath(to);
    for (const item of Array.from(this.pathCache)) {
      if (item !== normalizedFrom && !item.startsWith(`${normalizedFrom}/`)) continue;
      const suffix = item === normalizedFrom ? "" : item.slice(normalizedFrom.length);
      this.pathCache.delete(item);
      this.addPathAndParents(`${normalizedTo}${suffix}`);
    }
  }

  private shouldHidePath(filePath: string): boolean {
    return this.hideMetadataFile && normalizeVfsPath(filePath) === this.symlinkMetadataPath;
  }

  private toFsError(err: unknown, originalPath: string, op: string): Error {
    if (err instanceof JustBashFsError) return err;
    if (err instanceof NotFoundError || (err instanceof VfsError && err.code === "ENOENT")) {
      return fsError("ENOENT", `ENOENT: no such file or directory, ${op} '${originalPath}'`, originalPath, err);
    }
    if (err instanceof IsDirectoryError || (err instanceof VfsError && err.code === "EISDIR")) {
      return fsError("EISDIR", `EISDIR: illegal operation on a directory, ${op} '${originalPath}'`, originalPath, err);
    }
    if (err instanceof NotDirectoryError || (err instanceof VfsError && err.code === "ENOTDIR")) {
      return fsError("ENOTDIR", `ENOTDIR: not a directory, ${op} '${originalPath}'`, originalPath, err);
    }
    if (err instanceof ReadonlyFilesystemError || (err instanceof VfsError && err.code === "EROFS")) {
      return fsError("EROFS", `EROFS: read-only filesystem, ${op} '${originalPath}'`, originalPath, err);
    }
    if (err instanceof VfsError) return fsError(err.code, `${err.code}: ${err.message}`, originalPath, err);
    if (err instanceof Error) return err;
    return fsError("EIO", String(err), originalPath);
  }
}

export class AcceleratedJustBashShell {
  readonly fs: AcceleratedJustBashFs;
  private readonly cwd: string;
  private readonly closeFilesystemOnClose: boolean;
  private readonly BashCtor: JustBashConstructorLike | undefined;
  private readonly justBashModule: JustBashModuleLike | undefined;
  private readonly importJustBash: (() => Promise<JustBashModuleLike>) | undefined;
  private readonly bashOptions: Record<string, unknown>;
  private bashPromise: Promise<{ exec(command: string, options?: Record<string, unknown>): Promise<AcceleratedJustBashExecResult> }> | null = null;
  private closed = false;

  constructor(fs: AcceleratedJustBashFs, options: Omit<AcceleratedJustBashShellOptions, keyof CreateAcceleratedJustBashFsOptions | "justBashFs"> = {}) {
    this.fs = fs;
    this.cwd = normalizeVfsPath(options.cwd ?? "/");
    this.closeFilesystemOnClose = options.closeFilesystemOnClose ?? false;
    this.BashCtor = options.Bash;
    this.justBashModule = options.justBashModule;
    this.importJustBash = options.importJustBash;
    this.bashOptions = options.bashOptions ?? {};
  }

  async exec(command: string, options: AcceleratedJustBashExecOptions = {}): Promise<AcceleratedJustBashExecResult> {
    if (this.closed) throw new JustBashFsError("AcceleratedJustBashShell is closed", "EBADF");
    const bash = await this.getBash();
    const signal = withTimeoutSignal(options.signal, options.timeoutMs);
    try {
      const execOptions: Record<string, unknown> = {
        cwd: normalizeVfsPath(options.cwd ?? this.cwd),
        signal: signal.signal,
      };
      if (options.env !== undefined) execOptions.env = options.env;
      if (options.stdin !== undefined) execOptions.stdin = options.stdin;
      if (options.args !== undefined) execOptions.args = options.args;
      if (options.replaceEnv !== undefined) execOptions.replaceEnv = options.replaceEnv;
      if (options.rawScript !== undefined) execOptions.rawScript = options.rawScript;
      return await bash.exec(command, execOptions);
    } catch (err) {
      if (signal.timedOut()) {
        return { stdout: "", stderr: `Command timed out after ${options.timeoutMs}ms\n`, exitCode: 124 };
      }
      if (isAbortError(err)) return { stdout: "", stderr: "Command aborted\n", exitCode: 130 };
      throw err;
    } finally {
      signal.dispose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeFilesystemOnClose) await this.fs.underlying().close();
  }

  private async getBash(): Promise<{ exec(command: string, options?: Record<string, unknown>): Promise<AcceleratedJustBashExecResult> }> {
    if (!this.bashPromise) {
      this.bashPromise = (async () => {
        const BashCtor = this.BashCtor ?? this.justBashModule?.Bash ?? (await (this.importJustBash ?? importJustBash)()).Bash;
        if (!BashCtor) throw new JustBashFsError("just-bash module does not export Bash", "EINVAL");
        return new BashCtor({ ...this.bashOptions, fs: this.fs, cwd: this.cwd });
      })();
    }
    return this.bashPromise;
  }
}

export async function createAcceleratedJustBashFs(options: CreateAcceleratedJustBashFsOptions): Promise<AcceleratedJustBashFs> {
  const filesystem = options.filesystem ?? await mountFilesystemForAdapter(options);
  const fsOptions: Omit<AcceleratedJustBashFsOptions, "filesystem"> = {};
  if (options.persistSymlinks !== undefined) fsOptions.persistSymlinks = options.persistSymlinks;
  if (options.symlinkMetadataPath !== undefined) fsOptions.symlinkMetadataPath = options.symlinkMetadataPath;
  // Do not pass primePathCache into the constructor here; the helper awaits
  // the expensive full tree walk below instead of starting it fire-and-forget.
  if (options.hideMetadataFile !== undefined) fsOptions.hideMetadataFile = options.hideMetadataFile;
  const fs = new AcceleratedJustBashFs(filesystem, fsOptions);
  if (options.primePathCache) await fs.refreshPathCache();
  return fs;
}

export async function createAcceleratedJustBashShell(options: AcceleratedJustBashShellOptions): Promise<AcceleratedJustBashShell> {
  const fs = options.justBashFs ?? await createAcceleratedJustBashFs(options);
  const shellOptions: Omit<AcceleratedJustBashShellOptions, keyof CreateAcceleratedJustBashFsOptions | "justBashFs"> = {};
  if (options.Bash !== undefined) shellOptions.Bash = options.Bash;
  if (options.justBashModule !== undefined) shellOptions.justBashModule = options.justBashModule;
  if (options.importJustBash !== undefined) shellOptions.importJustBash = options.importJustBash;
  if (options.bashOptions !== undefined) shellOptions.bashOptions = options.bashOptions;
  if (options.cwd !== undefined) shellOptions.cwd = options.cwd;
  if (options.closeFilesystemOnClose !== undefined) shellOptions.closeFilesystemOnClose = options.closeFilesystemOnClose;
  return new AcceleratedJustBashShell(fs, shellOptions);
}

async function mountFilesystemForAdapter(options: CreateAcceleratedJustBashFsOptions): Promise<S3CachedFs> {
  if (options.manager) {
    if (!options.mount) throw new JustBashFsError("mount is required when filesystem is not supplied", "EINVAL");
    return options.manager.mount(options.mount);
  }
  if (!options.mount) throw new JustBashFsError("mount is required when filesystem is not supplied", "EINVAL");
  const managerConfig: ManagerConfig = options.managerConfig ?? { cacheRoot: "/tmp/accelerated-fs" };
  const managerOptions: S3CachedFsManagerOptions = { ...managerConfig };
  if (options.storeFactory !== undefined) managerOptions.storeFactory = options.storeFactory;
  const manager = new S3CachedFsManagerImpl(managerOptions);
  return manager.mount(options.mount);
}

async function importJustBash(): Promise<JustBashModuleLike> {
  const moduleName = "just-bash";
  return await import(moduleName) as unknown as JustBashModuleLike;
}

function toJustBashStat(stat: VfsStat, isSymlink: boolean): JustBashFsStat {
  return {
    isFile: stat.kind === "file",
    isDirectory: stat.kind === "dir",
    isSymbolicLink: isSymlink,
    mode: stat.mode,
    size: stat.kind === "file" ? stat.size : 0,
    mtime: new Date(stat.mtimeMs),
  };
}

function readEncoding(options?: JustBashReadFileOptions | JustBashBufferEncoding): JustBashBufferEncoding | null {
  if (!options) return "utf8";
  if (typeof options === "string") return options;
  return options.encoding === undefined ? "utf8" : options.encoding;
}

function writeEncoding(options?: JustBashWriteFileOptions | JustBashBufferEncoding): JustBashBufferEncoding | undefined {
  if (!options) return undefined;
  if (typeof options === "string") return options;
  return options.encoding;
}

function decodeForRead(bytes: Uint8Array, encoding: JustBashBufferEncoding | null): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (normalizeEncoding(encoding ?? "utf8")) {
    case "binary":
    case "latin1":
      return buffer.toString("latin1");
    case "base64":
      return buffer.toString("base64");
    case "hex":
      return buffer.toString("hex");
    case "ascii":
      return buffer.toString("ascii");
    case "utf8":
    default:
      return new TextDecoder().decode(bytes);
  }
}

function encodeForWrite(content: JustBashFileContent, encoding?: JustBashBufferEncoding): Uint8Array {
  if (content instanceof Uint8Array) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  const normalized = normalizeEncoding(encoding ?? "utf8");
  switch (normalized) {
    case "binary":
    case "latin1":
      return Buffer.from(content, "latin1");
    case "base64":
      return Buffer.from(content, "base64");
    case "hex":
      return Buffer.from(content, "hex");
    case "ascii":
      return Buffer.from(content, "ascii");
    case "utf8":
    default:
      return new TextEncoder().encode(content);
  }
}

function normalizeEncoding(encoding: JustBashBufferEncoding): "utf8" | "ascii" | "binary" | "base64" | "hex" | "latin1" {
  return encoding === "utf-8" ? "utf8" : encoding;
}

function bytesToLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function resolveSymlinkTarget(linkPath: string, target: string): string {
  if (target.startsWith("/")) return normalizeVfsPath(target);
  return normalizeVfsPath(path.posix.resolve(parentPath(linkPath), target));
}

function joinVfs(parent: string, child: string): string {
  return normalizeVfsPath(path.posix.join(parent, child));
}

function fsError(code: string, message: string, filePath?: string, cause?: unknown): JustBashFsError {
  return new JustBashFsError(message, code, filePath, cause);
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal?: AbortSignal;
  dispose(): void;
  timedOut(): boolean;
} {
  if (timeoutMs === undefined) {
    const out: { signal?: AbortSignal; dispose(): void; timedOut(): boolean } = { dispose: () => {}, timedOut: () => false };
    if (signal !== undefined) out.signal = signal;
    return out;
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Command timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "ExecutionAbortedError";
}

export function isAcceleratedJustBashFs(value: unknown): value is AcceleratedJustBashFs {
  return value instanceof AcceleratedJustBashFs;
}

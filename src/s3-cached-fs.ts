import { Database } from "bun:sqlite";
import { mkdir, open, readFile, rename, rm, stat as fsStat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CachedFileLease,
  MaterializeOptions,
  MkdirOptions,
  ObjectStore,
  ResolvedMountConfig,
  RmOptions,
  S3CachedFs,
  S3CachedFsTx,
  VfsDirent,
  VfsKind,
  VfsStat,
  WriteHandle,
  WriteInput,
} from "./types";
import {
  ClosedFilesystemError,
  IsDirectoryError,
  NotDirectoryError,
  NotFoundError,
  PreconditionFailedError,
  ReadonlyFilesystemError,
  VfsError,
} from "./types";
import { getMeta, getMetaNumber, initSchema, setMeta } from "./schema";
import {
  encodeWal,
  HeadRecord,
  snapshotDbKey,
  snapshotId,
  snapshotManifestKey,
  SnapshotManifest,
  WalExtent,
  walKey,
  WalObject,
  WalOp,
  WalRecord,
  withChecksum,
  verifyChecksum,
} from "./wal";
import { bodyToBytes, concatBytes, decodeUtf8, sha256Hex } from "./util/bytes";
import { ensureDir, rmIfExists, writeFileAtomic } from "./util/fs";
import { parseJsonBytes } from "./util/json";
import { basename, normalizeVfsPath, parentPath, splitVfsPath } from "./util/path";

interface HeadState {
  doc: HeadRecord;
  etag: string;
}

interface PendingPutFile {
  kind: "putFile";
  path: string;
  input?: WriteInput;
  localPath?: string;
  mode: number;
  mtimeMs: number;
}

interface PendingMkdir {
  kind: "mkdir";
  path: string;
  recursive: boolean;
  mode: number;
  mtimeMs: number;
}

interface PendingRm {
  kind: "rm";
  path: string;
  recursive: boolean;
  missingOk: boolean;
}

interface PendingRename {
  kind: "rename";
  from: string;
  to: string;
}

type PendingOp = PendingPutFile | PendingMkdir | PendingRm | PendingRename;

interface ExtentRow {
  inode_id: number;
  file_version: number;
  logical_offset: number;
  length: number;
  object_key: string;
  object_offset: number;
  object_length: number;
  sha256: string;
  compression: string | null;
}

interface InodeRow {
  inode_id: number;
  kind: VfsKind;
  mode: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  version: number;
}

interface DirentRow {
  name: string;
  path?: string;
  inode_id: number;
  kind: VfsKind;
  size: number;
  mtime_ms: number;
}

interface CacheEntryRow {
  object_key: string;
  local_path: string;
  size: number;
  last_access_ms: number;
  hit_count: number;
  pin_count: number;
  state: "clean" | "downloading" | "materialized";
}

interface OpenHandleState {
  path: string;
  localPath: string;
  mode: number;
  mtimeMs: number;
  closed: boolean;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
}

class TxCollector implements S3CachedFsTx {
  readonly ops: PendingOp[] = [];

  async writeFile(path: string, input: WriteInput, opts: { mode?: number; mtimeMs?: number } = {}): Promise<void> {
    this.ops.push({
      kind: "putFile",
      path: normalizeVfsPath(path),
      input,
      mode: opts.mode ?? 0o644,
      mtimeMs: opts.mtimeMs ?? Date.now(),
    });
  }

  async mkdir(path: string, opts: MkdirOptions = {}): Promise<void> {
    this.ops.push({
      kind: "mkdir",
      path: normalizeVfsPath(path),
      recursive: opts.recursive ?? true,
      mode: opts.mode ?? 0o755,
      mtimeMs: Date.now(),
    });
  }

  async rm(path: string, opts: RmOptions = {}): Promise<void> {
    this.ops.push({
      kind: "rm",
      path: normalizeVfsPath(path),
      recursive: opts.recursive ?? false,
      missingOk: opts.missingOk ?? false,
    });
  }

  async unlink(path: string): Promise<void> {
    await this.rm(path, { recursive: false, missingOk: false });
  }

  async rename(from: string, to: string): Promise<void> {
    this.ops.push({ kind: "rename", from: normalizeVfsPath(from), to: normalizeVfsPath(to) });
  }
}

class PackBuilder {
  private parts: Array<{ path: string; bytes: Uint8Array; sha256: string; logicalOffset: number; mode: number; mtimeMs: number; size: number }> = [];
  private size = 0;
  private packIndex = 0;
  readonly walOps: WalOp[] = [];

  constructor(
    private readonly fs: S3CachedFsImpl,
    private readonly txid: string,
    private readonly objects: Map<string, WalObject>,
  ) {}

  async addFile(path: string, bytes: Uint8Array, mode: number, mtimeMs: number): Promise<void> {
    if (bytes.byteLength > this.fs.cfg.smallFileBytes) throw new Error("PackBuilder only accepts small files");
    if (this.size > 0 && this.size + bytes.byteLength > this.fs.cfg.packBytes) {
      await this.flush();
    }
    this.parts.push({
      path,
      bytes,
      sha256: sha256Hex(bytes),
      logicalOffset: 0,
      mode,
      mtimeMs,
      size: bytes.byteLength,
    });
    this.size += bytes.byteLength;
  }

  async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
    const objectKey = `packs/${date}/${this.txid}-${String(this.packIndex++).padStart(6, "0")}.pack`;
    const body = concatBytes(this.parts.map(part => part.bytes), this.size);
    const objectSha = sha256Hex(body);
    await this.fs.store.put(objectKey, body, { ifNoneMatch: "*", contentType: "application/octet-stream" });
    this.objects.set(objectKey, { key: objectKey, sha256: objectSha, size: body.byteLength, kind: "pack" });

    let off = 0;
    for (const part of this.parts) {
      const extent: WalExtent = {
        logicalOffset: 0,
        length: part.bytes.byteLength,
        objectKey,
        objectOffset: off,
        objectLength: part.bytes.byteLength,
        sha256: part.sha256,
        compression: null,
      };
      this.walOps.push({
        op: "putFile",
        path: part.path,
        mode: part.mode,
        size: part.size,
        mtimeMs: part.mtimeMs,
        extents: [extent],
      });
      off += part.bytes.byteLength;
    }

    this.parts = [];
    this.size = 0;
  }

  drainWalOps(): WalOp[] {
    const out = this.walOps.splice(0, this.walOps.length);
    return out;
  }
}

export class S3CachedFsImpl implements S3CachedFs {
  readonly name: string;
  readonly writerId = crypto.randomUUID();

  private db!: Database;
  private dbPath: string;
  private head!: HeadState;
  private fsId = "";
  private closed = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private lockEtag: string | null = null;
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private openHandles = new Set<OpenHandleState>();

  constructor(
    readonly store: ObjectStore,
    readonly cfg: ResolvedMountConfig,
    readonly cacheRoot: string,
  ) {
    this.name = cfg.name;
    this.dbPath = path.join(cacheRoot, "meta.sqlite");
  }

  static async mount(store: ObjectStore, cfg: ResolvedMountConfig, cacheRoot: string): Promise<S3CachedFsImpl> {
    const fs = new S3CachedFsImpl(store, cfg, cacheRoot);
    await fs.init();
    return fs;
  }

  async stat(vfsPath: string): Promise<VfsStat> {
    this.assertOpen();
    const path = normalizeVfsPath(vfsPath);
    const row = this.lookupPath(path);
    if (!row) throw new NotFoundError(path);
    return {
      path,
      inodeId: row.inode_id,
      kind: row.kind,
      mode: row.mode,
      size: row.size,
      mtimeMs: row.mtime_ms,
      ctimeMs: row.ctime_ms,
      version: row.version,
    };
  }

  async exists(vfsPath: string): Promise<boolean> {
    this.assertOpen();
    return !!this.lookupPath(normalizeVfsPath(vfsPath));
  }

  async readdir(vfsPath: string): Promise<VfsDirent[]> {
    this.assertOpen();
    const pathName = normalizeVfsPath(vfsPath);
    const row = this.lookupPath(pathName);
    if (!row) throw new NotFoundError(pathName);
    if (row.kind !== "dir") throw new NotDirectoryError(pathName);
    const rows = this.db.query<DirentRow>(`
      SELECT d.name AS name, d.inode_id AS inode_id, d.kind AS kind, i.size AS size, i.mtime_ms AS mtime_ms
      FROM dirent d JOIN inode i ON i.inode_id = d.inode_id
      WHERE d.parent_inode_id = ?
      ORDER BY d.name
    `).all(row.inode_id);
    return rows.map(ent => ({
      name: ent.name,
      path: pathName === "/" ? `/${ent.name}` : `${pathName}/${ent.name}`,
      kind: ent.kind,
      inodeId: ent.inode_id,
      size: ent.size,
      mtimeMs: ent.mtime_ms,
    }));
  }

  async readFile(vfsPath: string): Promise<Uint8Array> {
    const st = await this.stat(vfsPath);
    if (st.kind === "dir") throw new IsDirectoryError(vfsPath);
    return this.readRange(vfsPath, 0, st.size);
  }

  async readText(vfsPath: string): Promise<string> {
    return decodeUtf8(await this.readFile(vfsPath));
  }

  async readRange(vfsPath: string, offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    const pathName = normalizeVfsPath(vfsPath);
    if (offset < 0 || length < 0) throw new RangeError("offset and length must be non-negative");
    const st = await this.stat(pathName);
    if (st.kind !== "file") throw new IsDirectoryError(pathName);
    if (length === 0 || offset >= st.size) return new Uint8Array();
    const end = Math.min(st.size, offset + length);
    const actualLength = end - offset;
    const out = new Uint8Array(actualLength);

    const extents = this.db.query<ExtentRow>(`
      SELECT * FROM extent
      WHERE inode_id = ? AND file_version = ?
        AND logical_offset < ? AND (logical_offset + length) > ?
      ORDER BY logical_offset
    `).all(st.inodeId, st.version, end, offset);

    for (const ex of extents) {
      const exStart = ex.logical_offset;
      const exEnd = ex.logical_offset + ex.length;
      const readStart = Math.max(offset, exStart);
      const readEnd = Math.min(end, exEnd);
      const objectOffset = ex.object_offset + (readStart - exStart);
      const readLen = readEnd - readStart;
      const bytes = await this.readObjectRange(ex.object_key, objectOffset, readLen);
      out.set(bytes, readStart - offset);
    }

    return out;
  }

  stream(vfsPath: string): ReadableStream<Uint8Array> {
    const pathName = normalizeVfsPath(vfsPath);
    let offset = 0;
    let statPromise: Promise<VfsStat> | null = null;
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        statPromise ??= this.stat(pathName);
        const st = await statPromise;
        if (st.kind !== "file") throw new IsDirectoryError(pathName);
        if (offset >= st.size) {
          controller.close();
          return;
        }
        const chunk = await this.readRange(pathName, offset, Math.min(this.cfg.chunkBytes, st.size - offset));
        offset += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
  }

  async materialize(vfsPath: string, opts: MaterializeOptions = {}): Promise<CachedFileLease> {
    this.assertOpen();
    const pathName = normalizeVfsPath(vfsPath);
    const st = await this.stat(pathName);
    if (st.kind !== "file") throw new IsDirectoryError(pathName);
    if (!opts.allowLarge && st.size > this.cfg.materializeMaxBytes) {
      throw new VfsError(
        `Refusing to materialize ${st.size} bytes; use stream(), readRange(), or materialize(path, { allowLarge: true })`,
        "EFBIG",
      );
    }
    await this.ensureCacheBudget(st.size);
    const key = `materialized:${st.inodeId}@${st.version}`;
    const localPath = path.join(this.cacheRoot, "materialized", `${st.inodeId}@${st.version}`);
    const cached = this.db.query<CacheEntryRow>("SELECT * FROM cache_entry WHERE object_key = ?").get(key);
    if (!cached) {
      await ensureDir(path.dirname(localPath));
      const tmp = `${localPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const fh = await open(tmp, "w");
      try {
        let off = 0;
        while (off < st.size) {
          const chunk = await this.readRange(pathName, off, Math.min(this.cfg.chunkBytes, st.size - off));
          await fh.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          off += chunk.byteLength;
        }
      } finally {
        await fh.close();
      }
      await rename(tmp, localPath);
      this.db.query(`
        INSERT INTO cache_entry(object_key, local_path, size, last_access_ms, hit_count, pin_count, state)
        VALUES (?, ?, ?, ?, 0, 0, 'materialized')
      `).run(key, localPath, st.size, Date.now());
    }
    this.db.query("UPDATE cache_entry SET pin_count = pin_count + 1, last_access_ms = ? WHERE object_key = ?").run(Date.now(), key);
    return {
      path: localPath,
      file: Bun.file(localPath),
      release: async () => {
        this.db.query("UPDATE cache_entry SET pin_count = MAX(pin_count - 1, 0), last_access_ms = ? WHERE object_key = ?").run(Date.now(), key);
      },
    };
  }

  async writeFile(vfsPath: string, input: WriteInput, opts: { mode?: number; mtimeMs?: number } = {}): Promise<void> {
    this.assertWritableOpen();
    await this.enqueueWrite(() => this.commitOps([{ kind: "putFile", path: normalizeVfsPath(vfsPath), input, mode: opts.mode ?? 0o644, mtimeMs: opts.mtimeMs ?? Date.now() }]));
  }

  async openWrite(vfsPath: string, opts: { mode?: number; mtimeMs?: number } = {}): Promise<WriteHandle> {
    this.assertWritableOpen();
    const pathName = normalizeVfsPath(vfsPath);
    const dir = path.join(this.cacheRoot, "tmp", this.writerId);
    await mkdir(dir, { recursive: true });
    const localPath = path.join(dir, crypto.randomUUID());
    await writeFile(localPath, new Uint8Array());
    const file = Bun.file(localPath);
    const state: OpenHandleState = {
      path: pathName,
      localPath,
      mode: opts.mode ?? 0o644,
      mtimeMs: opts.mtimeMs ?? Date.now(),
      closed: false,
      commit: async () => {},
      discard: async () => {},
    };
    state.commit = async () => {
      if (state.closed) return;
      state.closed = true;
      this.openHandles.delete(state);
      await this.enqueueWrite(() => this.commitOps([{ kind: "putFile", path: state.path, localPath: state.localPath, mode: state.mode, mtimeMs: state.mtimeMs }]));
      await rm(state.localPath, { force: true });
    };
    state.discard = async () => {
      if (state.closed) return;
      state.closed = true;
      this.openHandles.delete(state);
      await rm(state.localPath, { force: true });
    };
    this.openHandles.add(state);
    return {
      path: pathName,
      localPath,
      file,
      writer: () => file.writer({ highWaterMark: 1024 * 1024 }),
      close: state.commit,
      discard: state.discard,
    };
  }

  async mkdir(vfsPath: string, opts: MkdirOptions = {}): Promise<void> {
    this.assertWritableOpen();
    await this.enqueueWrite(() => this.commitOps([{ kind: "mkdir", path: normalizeVfsPath(vfsPath), recursive: opts.recursive ?? true, mode: opts.mode ?? 0o755, mtimeMs: Date.now() }]));
  }

  async rm(vfsPath: string, opts: RmOptions = {}): Promise<void> {
    this.assertWritableOpen();
    await this.enqueueWrite(() => this.commitOps([{ kind: "rm", path: normalizeVfsPath(vfsPath), recursive: opts.recursive ?? false, missingOk: opts.missingOk ?? false }]));
  }

  async unlink(vfsPath: string): Promise<void> {
    await this.rm(vfsPath, { recursive: false, missingOk: false });
  }

  async rename(from: string, to: string): Promise<void> {
    this.assertWritableOpen();
    await this.enqueueWrite(() => this.commitOps([{ kind: "rename", from: normalizeVfsPath(from), to: normalizeVfsPath(to) }]));
  }

  async transaction<T>(fn: (tx: S3CachedFsTx) => Promise<T>): Promise<T> {
    this.assertWritableOpen();
    const tx = new TxCollector();
    const result = await fn(tx);
    if (tx.ops.length > 0) await this.enqueueWrite(() => this.commitOps(tx.ops));
    return result;
  }

  async refresh(): Promise<void> {
    this.assertOpen();
    const remote = await this.readRemoteHead();
    if (!remote) throw new VfsError("Remote filesystem has no head", "EIO");
    if (remote.doc.checksum === this.head.doc.checksum) {
      this.head = remote;
      return;
    }
    const localSeq = getMetaNumber(this.db, "seq", 0);
    if (remote.doc.snapshotSeq > localSeq || getMeta(this.db, "fsId") !== remote.doc.fsId) {
      await this.rebuildFromHead(remote);
      return;
    }
    await this.replayWalRange(localSeq + 1, remote.doc.seq);
    this.head = remote;
    this.persistHeadMeta(remote.doc);
  }

  async snapshot(opts: { force?: boolean } = {}): Promise<void> {
    this.assertOpen();
    if (this.cfg.mode !== "readwrite") return;
    const currentSeq = this.head.doc.seq;
    const currentSnapshotSeq = this.head.doc.snapshotSeq;
    if (!opts.force && currentSeq - currentSnapshotSeq < this.cfg.snapshotTxCount) return;
    await this.enqueueWrite(() => this.publishSnapshot());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    let firstError: unknown;
    try {
      const handles = Array.from(this.openHandles);
      for (const handle of handles) await handle.commit();
      await this.writeQueue;
      if (this.cfg.mode === "readwrite") await this.snapshot({ force: true });
    } catch (err) {
      firstError = err;
    }
    await this.releaseWriterLease();
    this.closed = true;
    try {
      this.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
      this.db.run("PRAGMA journal_size_limit = 0;");
    } catch {}
    this.db.close(false);
    if (firstError) throw firstError;
  }

  private async init(): Promise<void> {
    await ensureDir(this.cacheRoot);
    await ensureDir(path.join(this.cacheRoot, "objects"));
    await ensureDir(path.join(this.cacheRoot, "materialized"));
    await ensureDir(path.join(this.cacheRoot, "tmp"));

    const remote = await this.readRemoteHead();
    if (!remote) {
      if (this.cfg.mode !== "readwrite") throw new VfsError("Remote filesystem does not exist", "ENOENT");
      await this.openFreshDb();
      await this.initializeRemote();
    } else {
      await this.openOrLoadDb(remote);
    }

    if (this.cfg.mode === "readwrite") await this.acquireWriterLease();
  }

  private async openFreshDb(): Promise<void> {
    await this.deleteDbFiles();
    this.db = new Database(this.dbPath, { create: true, readwrite: true, strict: true });
    this.configureDb();
    initSchema(this.db);
    this.fsId = crypto.randomUUID();
    setMeta(this.db, "fsId", this.fsId);
    setMeta(this.db, "seq", "0");
    setMeta(this.db, "txid", "root");
  }

  private async openOrLoadDb(remote: HeadState): Promise<void> {
    let localUsable = false;
    try {
      this.db = new Database(this.dbPath, { create: true, readwrite: true, strict: true });
      this.configureDb();
      initSchema(this.db);
      localUsable = getMeta(this.db, "headChecksum") === remote.doc.checksum && getMeta(this.db, "fsId") === remote.doc.fsId;
    } catch {
      localUsable = false;
    }
    if (localUsable) {
      this.head = remote;
      this.fsId = remote.doc.fsId;
      return;
    }
    try { this.db?.close(false); } catch {}
    await this.rebuildFromHead(remote);
  }

  private configureDb(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  private async deleteDbFiles(): Promise<void> {
    await rmIfExists(this.dbPath);
    await rmIfExists(`${this.dbPath}-wal`);
    await rmIfExists(`${this.dbPath}-shm`);
  }

  private async initializeRemote(): Promise<void> {
    await this.store.put("format.json", JSON.stringify({ format: 1, createdAt: new Date().toISOString(), fsId: this.fsId }), { ifNoneMatch: "*", contentType: "application/json" }).catch(err => {
      if (!(err instanceof PreconditionFailedError)) throw err;
    });
    const sid = snapshotId(0);
    const skey = snapshotDbKey(sid);
    const dbBytes = this.serializeDb();
    const dbChecksum = `sha256:${sha256Hex(dbBytes)}`;
    await this.store.put(skey, dbBytes, { ifNoneMatch: "*", contentType: "application/vnd.sqlite3" });
    const manifest = withChecksum<SnapshotManifest>({
      format: 1,
      fsId: this.fsId,
      snapshotId: sid,
      snapshotKey: skey,
      seq: 0,
      txid: "root",
      createdAt: new Date().toISOString(),
    });
    await this.store.put(snapshotManifestKey(sid), JSON.stringify(manifest), { ifNoneMatch: "*", contentType: "application/json" });
    const head = withChecksum<HeadRecord>({
      format: 1,
      fsId: this.fsId,
      snapshotKey: skey,
      snapshotSeq: 0,
      snapshotId: sid,
      txid: "root",
      seq: 0,
      walKey: null,
      createdAt: new Date().toISOString(),
      writerId: this.writerId,
    });
    const put = await this.store.put("heads/main.json", JSON.stringify(head), { ifNoneMatch: "*", contentType: "application/json" });
    this.head = { doc: head, etag: put.etag };
    this.persistHeadMeta(head);
    setMeta(this.db, "snapshotChecksum", dbChecksum);
  }

  private async readRemoteHead(): Promise<HeadState | null> {
    const stat = await this.store.head("heads/main.json");
    if (!stat) return null;
    const bytes = await this.store.get("heads/main.json");
    const doc = parseJsonBytes<HeadRecord>(bytes);
    if (!verifyChecksum(doc as any)) throw new VfsError("Remote head checksum failed", "EIO");
    return { doc, etag: stat.etag };
  }

  private async rebuildFromHead(remote: HeadState): Promise<void> {
    await this.deleteDbFiles();
    const snapshot = await this.store.get(remote.doc.snapshotKey);
    await writeFileAtomic(this.dbPath, snapshot);
    this.db = new Database(this.dbPath, { create: true, readwrite: true, strict: true });
    this.configureDb();
    initSchema(this.db);
    this.fsId = remote.doc.fsId;
    setMeta(this.db, "fsId", this.fsId);
    await this.replayWalRange(remote.doc.snapshotSeq + 1, remote.doc.seq);
    this.head = remote;
    this.persistHeadMeta(remote.doc);
  }

  private async replayWalRange(fromSeq: number, toSeq: number): Promise<void> {
    if (fromSeq > toSeq) return;
    const keys = await this.listWalKeys(fromSeq, toSeq);
    for (const key of keys) {
      const record = parseJsonBytes<WalRecord>(await this.store.get(key));
      if (!verifyChecksum(record as any)) throw new VfsError(`WAL checksum failed: ${key}`, "EIO");
      this.applyWalRecord(record, key);
    }
  }

  private async listWalKeys(fromSeq: number, toSeq: number): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.store.list("wal/", cursor, 1000);
      for (const key of res.keys) {
        const seq = parseWalSeq(key);
        if (seq >= fromSeq && seq <= toSeq) keys.push(key);
      }
      cursor = res.cursor;
    } while (cursor);
    keys.sort((a, b) => parseWalSeq(a) - parseWalSeq(b));
    return keys;
  }

  private persistHeadMeta(head: HeadRecord): void {
    this.fsId = head.fsId;
    setMeta(this.db, "fsId", head.fsId);
    setMeta(this.db, "seq", String(head.seq));
    setMeta(this.db, "txid", head.txid);
    setMeta(this.db, "headChecksum", head.checksum);
    setMeta(this.db, "snapshotSeq", String(head.snapshotSeq));
    setMeta(this.db, "snapshotKey", head.snapshotKey);
  }

  private serializeDb(): Uint8Array {
    this.db.run("PRAGMA wal_checkpoint(FULL);");
    return new Uint8Array(this.db.serialize());
  }

  private async commitOps(ops: PendingOp[]): Promise<void> {
    if (ops.length === 0) return;
    const current = this.head;
    const seq = current.doc.seq + 1;
    const txid = crypto.randomUUID();
    const objects = new Map<string, WalObject>();
    const walOps: WalOp[] = [];
    const pack = new PackBuilder(this, txid, objects);

    for (const op of ops) {
      if (op.kind === "putFile") {
        await this.stagePutFile(op, txid, objects, pack, walOps);
      } else {
        await pack.flush();
        walOps.push(...pack.drainWalOps());
        if (op.kind === "mkdir") {
          walOps.push({ op: "mkdir", path: op.path, mode: op.mode, mtimeMs: op.mtimeMs });
        } else if (op.kind === "rm") {
          walOps.push({ op: "rm", path: op.path, recursive: op.recursive, missingOk: op.missingOk });
        } else if (op.kind === "rename") {
          walOps.push({ op: "rename", from: op.from, to: op.to });
        }
      }
    }
    await pack.flush();
    walOps.push(...pack.drainWalOps());

    const record = withChecksum<WalRecord>({
      format: 1,
      fsId: this.fsId,
      seq,
      txid,
      parentTxid: current.doc.txid,
      createdAt: new Date().toISOString(),
      writerId: this.writerId,
      objects: Array.from(objects.values()).sort((a, b) => a.key.localeCompare(b.key)),
      ops: walOps,
    });
    const key = walKey(seq, txid);
    await this.store.put(key, encodeWal(record), { ifNoneMatch: "*", contentType: "application/json" });

    const head = withChecksum<HeadRecord>({
      format: 1,
      fsId: this.fsId,
      snapshotKey: current.doc.snapshotKey,
      snapshotSeq: current.doc.snapshotSeq,
      snapshotId: current.doc.snapshotId,
      txid,
      seq,
      walKey: key,
      createdAt: new Date().toISOString(),
      writerId: this.writerId,
    });

    let put;
    try {
      put = await this.store.put("heads/main.json", JSON.stringify(head), { ifMatch: current.etag, contentType: "application/json" });
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        throw new VfsError("Head CAS failed; another writer committed or the writer lease is stale", "EAGAIN", err);
      }
      throw err;
    }

    try {
      this.applyWalRecord(record, key);
      this.head = { doc: head, etag: put.etag };
      this.persistHeadMeta(head);
    } catch (err) {
      await this.rebuildFromHead({ doc: head, etag: put.etag });
      throw err;
    }
  }

  private async stagePutFile(
    op: PendingPutFile,
    txid: string,
    objects: Map<string, WalObject>,
    pack: PackBuilder,
    walOps: WalOp[],
  ): Promise<void> {
    const size = op.localPath ? (await fsStat(op.localPath)).size : (await bodyToBytes(op.input!)).byteLength;
    if (size === 0) {
      await pack.flush();
      walOps.push(...pack.drainWalOps());
      walOps.push({ op: "putFile", path: op.path, mode: op.mode, size: 0, mtimeMs: op.mtimeMs, extents: [] });
      return;
    }

    if (size <= this.cfg.smallFileBytes) {
      const bytes = op.localPath ? new Uint8Array(await readFile(op.localPath)) : await bodyToBytes(op.input!);
      await pack.addFile(op.path, bytes, op.mode, op.mtimeMs);
      return;
    }

    await pack.flush();
    walOps.push(...pack.drainWalOps());
    const extents: WalExtent[] = [];
    if (op.localPath) {
      const fh = await open(op.localPath, "r");
      try {
        let logical = 0;
        while (logical < size) {
          const len = Math.min(this.cfg.chunkBytes, size - logical);
          const buf = Buffer.alloc(len);
          const read = await fh.read(buf, 0, len, logical);
          const bytes = new Uint8Array(buf.buffer, buf.byteOffset, read.bytesRead);
          const extent = await this.uploadChunk(bytes, logical, objects);
          extents.push(extent);
          logical += read.bytesRead;
        }
      } finally {
        await fh.close();
      }
    } else {
      const bytes = await bodyToBytes(op.input!);
      for (let logical = 0; logical < bytes.byteLength; logical += this.cfg.chunkBytes) {
        const chunk = bytes.subarray(logical, Math.min(bytes.byteLength, logical + this.cfg.chunkBytes));
        extents.push(await this.uploadChunk(chunk, logical, objects));
      }
    }

    walOps.push({ op: "putFile", path: op.path, mode: op.mode, size, mtimeMs: op.mtimeMs, extents });
  }

  private async uploadChunk(bytes: Uint8Array, logicalOffset: number, objects: Map<string, WalObject>): Promise<WalExtent> {
    const hash = sha256Hex(bytes);
    const objectKey = `blobs/sha256/${hash.slice(0, 2)}/${hash}`;
    if (!objects.has(objectKey)) {
      const existing = await this.store.head(objectKey);
      if (!existing) {
        try {
          await this.store.put(objectKey, bytes, { ifNoneMatch: "*", contentType: "application/octet-stream" });
        } catch (err) {
          if (!(err instanceof PreconditionFailedError)) throw err;
        }
      }
      objects.set(objectKey, { key: objectKey, sha256: hash, size: bytes.byteLength, kind: "blob" });
    }
    return {
      logicalOffset,
      length: bytes.byteLength,
      objectKey,
      objectOffset: 0,
      objectLength: bytes.byteLength,
      sha256: hash,
      compression: null,
    };
  }

  private applyWalRecord(record: WalRecord, walObjectKey: string): void {
    const existing = this.db.query<{ seq: number }>("SELECT seq FROM remote_tx WHERE seq = ?").get(record.seq);
    if (existing) return;
    const objects = new Map(record.objects.map(obj => [obj.key, obj]));
    const apply = this.db.transaction(() => {
      for (const op of record.ops) {
        if (op.op === "mkdir") this.applyMkdir(op.path, op.mode, op.mtimeMs);
        else if (op.op === "putFile") this.applyPutFile(op, objects);
        else if (op.op === "rm") this.applyRm(op.path, op.recursive, op.missingOk);
        else if (op.op === "rename") this.applyRename(op.from, op.to);
      }
      this.db.query("INSERT INTO remote_tx(seq, txid, parent_txid, wal_key, applied, created_at_ms) VALUES (?, ?, ?, ?, 1, ?)").run(
        record.seq,
        record.txid,
        record.parentTxid,
        walObjectKey,
        Date.parse(record.createdAt) || Date.now(),
      );
      setMeta(this.db, "seq", String(record.seq));
      setMeta(this.db, "txid", record.txid);
    });
    apply();
  }

  private applyMkdir(pathName: string, mode: number, mtimeMs: number): number {
    pathName = normalizeVfsPath(pathName);
    if (pathName === "/") return 1;
    const existing = this.lookupPath(pathName);
    if (existing) {
      if (existing.kind !== "dir") throw new VfsError(`Cannot mkdir over file: ${pathName}`, "ENOTDIR");
      return existing.inode_id;
    }
    const parent = this.ensureDirPath(parentPath(pathName), mode, mtimeMs);
    return this.createChild(parent, basename(pathName), "dir", mode, 0, mtimeMs);
  }

  private ensureDirPath(pathName: string, mode = 0o755, mtimeMs = Date.now()): number {
    const parts = splitVfsPath(pathName);
    let parent = 1;
    for (const name of parts) {
      const row = this.db.query<{ inode_id: number; kind: VfsKind }>("SELECT inode_id, kind FROM dirent WHERE parent_inode_id = ? AND name = ?").get(parent, name);
      if (row) {
        if (row.kind !== "dir") throw new NotDirectoryError(pathName);
        parent = row.inode_id;
      } else {
        parent = this.createChild(parent, name, "dir", mode, 0, mtimeMs);
      }
    }
    return parent;
  }

  private createChild(parentInode: number, name: string, kind: VfsKind, mode: number, size: number, mtimeMs: number): number {
    const now = Date.now();
    const result = this.db.query("INSERT INTO inode(kind, mode, size, mtime_ms, ctime_ms, version) VALUES (?, ?, ?, ?, ?, 0)").run(kind, mode, size, mtimeMs, now);
    const inode = Number(result.lastInsertRowid);
    this.db.query("INSERT INTO dirent(parent_inode_id, name, inode_id, kind) VALUES (?, ?, ?, ?)").run(parentInode, name, inode, kind);
    return inode;
  }

  private applyPutFile(op: Extract<WalOp, { op: "putFile" }>, objects: Map<string, WalObject>): void {
    const pathName = normalizeVfsPath(op.path);
    const parent = this.ensureDirPath(parentPath(pathName), 0o755, op.mtimeMs);
    const name = basename(pathName);
    let inode = this.lookupChild(parent, name);
    if (inode && inode.kind === "dir") throw new IsDirectoryError(pathName);
    if (!inode) {
      const id = this.createChild(parent, name, "file", op.mode, op.size, op.mtimeMs);
      inode = this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = ?").get(id)!;
    } else {
      this.decrementRefsForInode(inode.inode_id);
      this.db.query("UPDATE inode SET mode = ?, size = ?, mtime_ms = ?, version = version + 1 WHERE inode_id = ?").run(op.mode, op.size, op.mtimeMs, inode.inode_id);
      inode = this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = ?").get(inode.inode_id)!;
    }

    for (const ex of op.extents) {
      const obj = objects.get(ex.objectKey) ?? { key: ex.objectKey, sha256: ex.sha256, size: ex.objectLength, kind: "blob" as const };
      this.db.query(`
        INSERT INTO object_ref(object_key, sha256, size, kind, ref_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(object_key) DO UPDATE SET ref_count = ref_count + 1
      `).run(obj.key, obj.sha256, obj.size, obj.kind);
      this.db.query(`
        INSERT INTO extent(inode_id, file_version, logical_offset, length, object_key, object_offset, object_length, sha256, compression)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(inode.inode_id, inode.version, ex.logicalOffset, ex.length, ex.objectKey, ex.objectOffset, ex.objectLength, ex.sha256, ex.compression ?? null);
    }
  }

  private applyRm(pathName: string, recursive: boolean, missingOk: boolean): void {
    pathName = normalizeVfsPath(pathName);
    if (pathName === "/") throw new VfsError("Cannot remove root", "EINVAL");
    const row = this.lookupPath(pathName);
    if (!row) {
      if (missingOk) return;
      throw new NotFoundError(pathName);
    }
    if (row.kind === "dir" && !recursive) {
      const child = this.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM dirent WHERE parent_inode_id = ?").get(row.inode_id);
      if ((child?.n ?? 0) > 0) throw new VfsError(`Directory not empty: ${pathName}`, "ENOTEMPTY");
    }
    this.deleteInodeRecursive(row.inode_id);
    const parent = this.lookupPath(parentPath(pathName));
    if (parent) this.db.query("DELETE FROM dirent WHERE parent_inode_id = ? AND name = ?").run(parent.inode_id, basename(pathName));
  }

  private applyRename(from: string, to: string): void {
    from = normalizeVfsPath(from);
    to = normalizeVfsPath(to);
    if (from === to) return;
    if (from === "/" || to === "/") throw new VfsError("Cannot rename root", "EINVAL");
    if (to.startsWith(`${from}/`)) throw new VfsError("Cannot move a directory into itself", "EINVAL");
    const src = this.lookupPath(from);
    if (!src) throw new NotFoundError(from);
    const dst = this.lookupPath(to);
    if (dst) this.applyRm(to, true, true);
    const srcParent = this.lookupPath(parentPath(from));
    if (!srcParent) throw new NotFoundError(parentPath(from));
    const dstParentInode = this.ensureDirPath(parentPath(to));
    this.db.query("DELETE FROM dirent WHERE parent_inode_id = ? AND name = ?").run(srcParent.inode_id, basename(from));
    this.db.query("INSERT INTO dirent(parent_inode_id, name, inode_id, kind) VALUES (?, ?, ?, ?)").run(dstParentInode, basename(to), src.inode_id, src.kind);
  }

  private deleteInodeRecursive(inodeId: number): void {
    const row = this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = ?").get(inodeId);
    if (!row) return;
    if (row.kind === "dir") {
      const children = this.db.query<{ inode_id: number }>("SELECT inode_id FROM dirent WHERE parent_inode_id = ?").all(inodeId);
      for (const child of children) this.deleteInodeRecursive(child.inode_id);
      this.db.query("DELETE FROM dirent WHERE parent_inode_id = ?").run(inodeId);
    }
    this.decrementRefsForInode(inodeId);
    this.db.query("DELETE FROM inode WHERE inode_id = ?").run(inodeId);
  }

  private decrementRefsForInode(inodeId: number): void {
    const refs = this.db.query<{ object_key: string; n: number }>("SELECT object_key, COUNT(*) AS n FROM extent WHERE inode_id = ? GROUP BY object_key").all(inodeId);
    for (const ref of refs) {
      this.db.query("UPDATE object_ref SET ref_count = MAX(ref_count - ?, 0) WHERE object_key = ?").run(ref.n, ref.object_key);
      this.db.query("DELETE FROM object_ref WHERE object_key = ? AND ref_count = 0").run(ref.object_key);
    }
    this.db.query("DELETE FROM extent WHERE inode_id = ?").run(inodeId);
  }

  private lookupPath(pathName: string): InodeRow | null {
    pathName = normalizeVfsPath(pathName);
    if (pathName === "/") return this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = 1").get();
    let current = 1;
    for (const part of splitVfsPath(pathName)) {
      const row = this.lookupChild(current, part);
      if (!row) return null;
      current = row.inode_id;
    }
    return this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = ?").get(current);
  }

  private lookupChild(parentInode: number, name: string): InodeRow | null {
    const ent = this.db.query<{ inode_id: number }>("SELECT inode_id FROM dirent WHERE parent_inode_id = ? AND name = ?").get(parentInode, name);
    if (!ent) return null;
    return this.db.query<InodeRow>("SELECT * FROM inode WHERE inode_id = ?").get(ent.inode_id);
  }

  private async readObjectRange(objectKey: string, offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array();
    const localPath = await this.cacheObject(objectKey);
    const fh = await open(localPath, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = await fh.read(buf, 0, length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, read.bytesRead);
    } finally {
      await fh.close();
    }
  }

  private async cacheObject(objectKey: string): Promise<string> {
    const existing = this.db.query<CacheEntryRow>("SELECT * FROM cache_entry WHERE object_key = ?").get(objectKey);
    if (existing) {
      try {
        await fsStat(existing.local_path);
        this.db.query("UPDATE cache_entry SET last_access_ms = ?, hit_count = hit_count + 1 WHERE object_key = ?").run(Date.now(), objectKey);
        return existing.local_path;
      } catch {
        this.db.query("DELETE FROM cache_entry WHERE object_key = ?").run(objectKey);
      }
    }

    const bytes = await this.store.get(objectKey);
    await this.ensureCacheBudget(bytes.byteLength);
    const hash = sha256Hex(new TextEncoder().encode(objectKey));
    const localPath = path.join(this.cacheRoot, "objects", hash.slice(0, 2), hash);
    await ensureDir(path.dirname(localPath));
    await writeFileAtomic(localPath, bytes);
    this.db.query(`
      INSERT INTO cache_entry(object_key, local_path, size, last_access_ms, hit_count, pin_count, state)
      VALUES (?, ?, ?, ?, 0, 0, 'clean')
      ON CONFLICT(object_key) DO UPDATE SET local_path = excluded.local_path, size = excluded.size, last_access_ms = excluded.last_access_ms, state = 'clean'
    `).run(objectKey, localPath, bytes.byteLength, Date.now());
    return localPath;
  }

  private async ensureCacheBudget(additionalBytes: number): Promise<void> {
    const maxBytes = Math.max(0, this.cfg.cacheBytes - this.cfg.cacheReserveBytes);
    if (additionalBytes > this.cfg.cacheBytes) throw new VfsError(`Object larger than total cache budget: ${additionalBytes}`, "ENOSPC");
    let current = this.cacheBytesUsed();
    if (current + additionalBytes <= maxBytes) return;
    const victims = this.db.query<CacheEntryRow>(`
      SELECT * FROM cache_entry WHERE pin_count = 0 ORDER BY last_access_ms ASC
    `).all();
    for (const victim of victims) {
      await rm(victim.local_path, { force: true });
      this.db.query("DELETE FROM cache_entry WHERE object_key = ?").run(victim.object_key);
      current -= victim.size;
      if (current + additionalBytes <= maxBytes) return;
    }
    if (current + additionalBytes > this.cfg.cacheBytes) {
      throw new VfsError("Cache has no evictable space", "ENOSPC");
    }
  }

  private cacheBytesUsed(): number {
    const row = this.db.query<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM cache_entry").get();
    return row?.n ?? 0;
  }

  private async publishSnapshot(): Promise<void> {
    const current = this.head;
    const sid = snapshotId(current.doc.seq);
    const skey = snapshotDbKey(sid);
    const dbBytes = this.serializeDb();
    await this.store.put(skey, dbBytes, { ifNoneMatch: "*", contentType: "application/vnd.sqlite3" }).catch(err => {
      if (!(err instanceof PreconditionFailedError)) throw err;
    });
    const manifest = withChecksum<SnapshotManifest>({
      format: 1,
      fsId: this.fsId,
      snapshotId: sid,
      snapshotKey: skey,
      seq: current.doc.seq,
      txid: current.doc.txid,
      createdAt: new Date().toISOString(),
    });
    await this.store.put(snapshotManifestKey(sid), JSON.stringify(manifest), { ifNoneMatch: "*", contentType: "application/json" }).catch(err => {
      if (!(err instanceof PreconditionFailedError)) throw err;
    });
    const head = withChecksum<HeadRecord>({
      format: 1,
      fsId: this.fsId,
      snapshotKey: skey,
      snapshotSeq: current.doc.seq,
      snapshotId: sid,
      txid: current.doc.txid,
      seq: current.doc.seq,
      walKey: current.doc.walKey,
      createdAt: new Date().toISOString(),
      writerId: this.writerId,
    });
    const put = await this.store.put("heads/main.json", JSON.stringify(head), { ifMatch: current.etag, contentType: "application/json" });
    this.head = { doc: head, etag: put.etag };
    this.persistHeadMeta(head);
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  private async acquireWriterLease(): Promise<void> {
    const key = "locks/writer.json";
    const lock = await this.store.head(key);
    if (lock) {
      try {
        const doc = parseJsonBytes<{ expiresAt: string }>(await this.store.get(key));
        if (Date.parse(doc.expiresAt) < Date.now()) await this.store.delete(key, { ifMatch: lock.etag });
        else throw new VfsError("Remote filesystem already has a live writer", "EBUSY");
      } catch (err) {
        if (err instanceof VfsError) throw err;
      }
    }
    const put = await this.store.put(key, JSON.stringify(this.lockDoc()), { ifNoneMatch: "*", contentType: "application/json" });
    this.lockEtag = put.etag;
    this.lockTimer = setInterval(() => {
      this.renewWriterLease().catch(() => {});
    }, this.cfg.lockRenewMs);
  }

  private lockDoc(): Record<string, unknown> {
    return {
      writerId: this.writerId,
      fsId: this.fsId,
      headTxid: this.head?.doc.txid ?? "root",
      expiresAt: new Date(Date.now() + this.cfg.lockTtlMs).toISOString(),
      token: crypto.randomUUID(),
    };
  }

  private async renewWriterLease(): Promise<void> {
    if (!this.lockEtag || this.closed) return;
    const put = await this.store.put("locks/writer.json", JSON.stringify(this.lockDoc()), { ifMatch: this.lockEtag, contentType: "application/json" });
    this.lockEtag = put.etag;
  }

  private async releaseWriterLease(): Promise<void> {
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = null;
    if (!this.lockEtag) return;
    await this.store.delete("locks/writer.json", { ifMatch: this.lockEtag }).catch(() => {});
    this.lockEtag = null;
  }

  private assertOpen(): void {
    if (this.closed) throw new ClosedFilesystemError();
  }

  private assertWritableOpen(): void {
    this.assertOpen();
    if (this.cfg.mode !== "readwrite") throw new ReadonlyFilesystemError();
  }
}

function parseWalSeq(key: string): number {
  const name = key.split("/").at(-1) ?? key;
  const n = Number(name.split("-")[0]);
  return Number.isFinite(n) ? n : -1;
}

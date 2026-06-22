import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeleteOptions, ObjectListResult, ObjectStat, ObjectStore, PutOptions, WriteInput } from "../types";
import { PreconditionFailedError } from "../types";
import { bodyToBytes, quoteEtag, sha256Hex } from "../util/bytes";
import { ensureDir } from "../util/fs";
import { safeLocalJoin } from "../util/path";

export class LocalObjectStore implements ObjectStore {
  constructor(readonly root: string) {}

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.localPath(key)));
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0) throw new RangeError("offset and length must be non-negative");
    const fh = await open(this.localPath(key), "r");
    try {
      const buffer = Buffer.alloc(length);
      const result = await fh.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, result.bytesRead);
    } finally {
      await fh.close();
    }
  }

  async put(key: string, body: WriteInput, opts: PutOptions = {}): Promise<{ etag: string }> {
    const file = this.localPath(key);
    const current = await this.head(key);
    if (opts.ifNoneMatch === "*" && current) throw new PreconditionFailedError(`Object already exists: ${key}`, key);
    if (opts.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
      throw new PreconditionFailedError(`ETag mismatch for ${key}`, key);
    }
    const bytes = await bodyToBytes(body);
    await ensureDir(path.dirname(file));
    await writeFile(file, bytes);
    const etag = quoteEtag(sha256Hex(bytes));
    await writeFile(`${file}.meta.json`, JSON.stringify({ etag, size: bytes.byteLength, contentType: opts.contentType ?? null }));
    return { etag };
  }

  async head(key: string): Promise<ObjectStat | null> {
    const file = this.localPath(key);
    try {
      const st = await stat(file);
      let etag = quoteEtag(`${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`);
      let contentType: string | undefined;
      try {
        const meta = JSON.parse(await readFile(`${file}.meta.json`, "utf8")) as { etag?: string; contentType?: string | null };
        if (meta.etag) etag = meta.etag;
        if (meta.contentType) contentType = meta.contentType;
      } catch {}
      const out: ObjectStat = { key, etag, size: st.size, lastModified: st.mtime };
      if (contentType) out.contentType = contentType;
      return out;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string, opts: DeleteOptions = {}): Promise<void> {
    const current = await this.head(key);
    if (opts.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
      throw new PreconditionFailedError(`ETag mismatch for ${key}`, key);
    }
    await rm(this.localPath(key), { force: true });
    await rm(`${this.localPath(key)}.meta.json`, { force: true });
  }

  async list(prefix: string, cursor?: string, limit = 1000): Promise<ObjectListResult> {
    const keys = await this.walk("");
    const filtered = keys
      .filter(key => key.startsWith(prefix) && !key.endsWith(".meta.json"))
      .sort();
    const start = cursor ? filtered.findIndex(key => key > cursor) : 0;
    const slice = filtered.slice(Math.max(0, start), Math.max(0, start) + limit);
    const next = slice.length === limit ? slice.at(-1) : undefined;
    return next ? { keys: slice, cursor: next } : { keys: slice };
  }

  private localPath(key: string): string {
    return safeLocalJoin(this.root, key);
  }

  private async walk(prefix: string): Promise<string[]> {
    const dir = safeLocalJoin(this.root, prefix);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const out: string[] = [];
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) out.push(...await this.walk(rel));
      else out.push(rel);
    }
    return out;
  }
}

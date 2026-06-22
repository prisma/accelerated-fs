import { jsonBytes, stableStringify } from "./util/json";
import { sha256Hex } from "./util/bytes";

export interface WalExtent {
  logicalOffset: number;
  length: number;
  objectKey: string;
  objectOffset: number;
  objectLength: number;
  sha256: string;
  compression?: string | null;
}

export interface WalObject {
  key: string;
  sha256: string;
  size: number;
  kind: "blob" | "pack" | "wal-inline";
}

export type WalOp =
  | {
      op: "mkdir";
      path: string;
      mode: number;
      mtimeMs: number;
    }
  | {
      op: "putFile";
      path: string;
      mode: number;
      size: number;
      mtimeMs: number;
      extents: WalExtent[];
    }
  | {
      op: "rm";
      path: string;
      recursive: boolean;
      missingOk: boolean;
    }
  | {
      op: "rename";
      from: string;
      to: string;
    };

export interface WalRecord {
  format: 1;
  fsId: string;
  seq: number;
  txid: string;
  parentTxid: string | null;
  createdAt: string;
  writerId: string;
  objects: WalObject[];
  ops: WalOp[];
  checksum: string;
}

export interface HeadRecord {
  format: 1;
  fsId: string;
  snapshotKey: string;
  snapshotSeq: number;
  snapshotId: string;
  txid: string;
  seq: number;
  walKey: string | null;
  createdAt: string;
  writerId: string;
  checksum: string;
}

export interface SnapshotManifest {
  format: 1;
  fsId: string;
  snapshotId: string;
  snapshotKey: string;
  seq: number;
  txid: string;
  createdAt: string;
  checksum: string;
}

export function withChecksum<T extends object>(record: Omit<T, "checksum">): T {
  const checksum = `sha256:${sha256Hex(stableStringify(record))}`;
  return { ...(record as any), checksum } as T;
}

export function verifyChecksum(record: { checksum: string; [key: string]: unknown }): boolean {
  const { checksum, ...rest } = record;
  return checksum === `sha256:${sha256Hex(stableStringify(rest))}`;
}

export function walKey(seq: number, txid: string): string {
  return `wal/${seq.toString().padStart(18, "0")}-${txid}.json`;
}

export function snapshotId(seq: number): string {
  return `snap-${seq.toString().padStart(18, "0")}`;
}

export function snapshotDbKey(id: string): string {
  return `snapshots/${id}/meta.sqlite`;
}

export function snapshotManifestKey(id: string): string {
  return `snapshots/${id}/manifest.json`;
}

export function encodeWal(record: WalRecord): Uint8Array {
  return jsonBytes(record);
}

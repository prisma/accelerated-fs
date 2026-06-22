declare const process: { pid: number; env: Record<string, string | undefined> };

declare class Buffer extends Uint8Array {
  static alloc(size: number): Buffer;
  static from(data: string, encoding?: string): Buffer;
  static from(data: ArrayBuffer | ArrayBufferLike | ArrayBufferView | Uint8Array, byteOffset?: number, length?: number): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  toString(encoding?: string): string;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): { update(data: any): any; digest(encoding: "hex"): string; digest(): Buffer };
  export function createHmac(algorithm: string, key: any): { update(data: any): any; digest(encoding: "hex"): string; digest(): Buffer };
}

declare module "node:stream" {
  export class Readable {
    static from(iterable: Iterable<any> | AsyncIterable<any>): Readable;
  }
}

declare module "node:path" {
  const path: {
    sep: string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(p: string): string;
    posix: {
      normalize(p: string): string;
      dirname(p: string): string;
      basename(p: string): string;
      join(...parts: string[]): string;
      resolve(...parts: string[]): string;
    };
  };
  export default path;
}

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function createReadStream(path: string): any;
}

declare module "node:fs/promises" {
  import type { Dirent } from "node:fs";

  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string, opts?: { withFileTypes?: false }): Promise<string[]>;
  export function readdir(path: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
  export function stat(path: string): Promise<{ size: number; mtime: Date; mtimeMs: number }>;
  export function open(path: string, flags: string): Promise<{
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    write(buffer: Uint8Array): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    close(): Promise<void>;
  }>;
}

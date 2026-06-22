declare namespace Bun {
  interface BunFile extends Blob {
    readonly name?: string;
    readonly size: number;
    bytes(): Promise<Uint8Array>;
    text(): Promise<string>;
    json(): Promise<any>;
    stream(): ReadableStream<Uint8Array>;
    writer(opts?: { highWaterMark?: number; [key: string]: unknown }): FileSink;
  }

  interface FileSink {
    write(chunk: string | Uint8Array | ArrayBuffer | ArrayBufferView): number | Promise<number>;
    flush(): Promise<void> | void;
    end(chunk?: string | Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void> | void;
  }

  interface S3File extends BunFile {
    slice(start?: number, end?: number, contentType?: string): S3File;
    exists(): Promise<boolean>;
    stat(): Promise<{ etag: string; size: number; lastModified?: Date; type?: string }>;
    write(data: any, opts?: any): Promise<number>;
    delete(): Promise<void>;
  }

  class S3Client {
    constructor(opts?: Record<string, unknown>);
    file(key: string): S3File;
    write(key: string, data: any, opts?: any): Promise<number>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    stat(key: string): Promise<{ etag: string; size: number; lastModified?: Date; type?: string }>;
    list(opts?: any): Promise<{ contents?: Array<{ key: string }>; isTruncated?: boolean }>;
  }

  function file(path: string, opts?: any): BunFile;
  function write(dest: string | BunFile, input: any): Promise<number>;
  function serve(options: {
    port?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): unknown;
}

declare var Bun: typeof Bun;

declare module "bun:sqlite" {
  export class Statement<T = unknown> {
    get(...args: any[]): T | null;
    all(...args: any[]): T[];
    values(...args: any[]): any[][];
    run(...args: any[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class Database {
    constructor(path?: string | Uint8Array, opts?: { create?: boolean; readwrite?: boolean; strict?: boolean });
    static deserialize(bytes: Uint8Array): Database;
    query<T = unknown>(sql: string): Statement<T>;
    prepare<T = unknown>(sql: string): Statement<T>;
    run(sql: string, ...args: any[]): { changes: number; lastInsertRowid: number | bigint };
    exec(sql: string): void;
    close(throwOnError?: boolean): void;
    serialize(name?: string): Buffer;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
  }
}

declare module "bun:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function expect(value: any): any;
  export function beforeEach(fn: () => unknown | Promise<unknown>): void;
  export function afterEach(fn: () => unknown | Promise<unknown>): void;
}

declare module "just-bash" {
  export const Bash: any;
  export const InMemoryFs: any;
  export const MountableFs: any;
  export function defineCommand(...args: any[]): any;
  export function decodeBytesToUtf8(value: any): string;
}

declare module "@flue/runtime" {
  export function createSandboxSessionEnv(api: any, cwd: string): any;
  export class SandboxOperationUnsupportedError extends Error {
    constructor(message: string);
  }
  export type SandboxApi = any;
  export type SandboxFactory = any;
  export type SessionEnv = any;
  export type FileStat = any;
  export type SessionToolFactory = any;
}

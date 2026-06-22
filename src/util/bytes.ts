import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { WriteInput } from "../types";

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function decodeUtf8(input: Uint8Array): string {
  return new TextDecoder().decode(input);
}

export function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

export async function bodyToBytes(input: WriteInput): Promise<Uint8Array> {
  if (typeof input === "string") return utf8(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof Response !== "undefined" && input instanceof Response) return new Uint8Array(await input.arrayBuffer());
  if (typeof Blob !== "undefined" && input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (isReadableStream(input)) {
    const reader = input.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const value = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    return concatBytes(chunks, total);
  }
  throw new TypeError("Unsupported write input");
}

export function sha256Hex(input: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  return h.digest("hex");
}

export function md5Hex(input: Uint8Array | string): string {
  const h = createHash("md5");
  h.update(typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  return h.digest("hex");
}

export function quoteEtag(value: string): string {
  return value.startsWith('"') ? value : `"${value}"`;
}

export function unquoteEtag(value: string): string {
  return value.replace(/^"|"$/g, "");
}

export function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof value === "object" && "getReader" in value && typeof (value as any).getReader === "function";
}

export async function readableToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return bodyToBytes(stream);
}

export function nodeReadableFromBytes(bytes: Uint8Array): Readable {
  return Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

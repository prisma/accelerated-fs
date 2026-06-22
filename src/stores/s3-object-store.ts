import { createHash, createHmac } from "node:crypto";
import type { DeleteOptions, ObjectListResult, ObjectStat, ObjectStore, PutOptions, ResolvedMountConfig, WriteInput } from "../types";
import { PreconditionFailedError, VfsError } from "../types";
import { bodyToBytes, sha256Hex } from "../util/bytes";

export interface S3ObjectStoreConfig {
  bucket: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  sessionToken?: string | undefined;
  prefix?: string | undefined;
  forcePathStyle?: boolean | undefined;
}

interface SignedRequestInput {
  method: string;
  key?: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string | undefined;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  readonly sessionToken: string | undefined;

  constructor(config: S3ObjectStoreConfig) {
    if (!config.bucket) throw new VfsError("S3 bucket is required", "EINVAL");
    this.bucket = config.bucket;
    this.region = config.region ?? "us-east-1";
    this.endpoint = config.endpoint;
    this.prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.forcePathStyle = config.forcePathStyle ?? !!config.endpoint;
    this.accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    this.secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    this.sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN;
  }

  static fromMount(config: ResolvedMountConfig): S3ObjectStore {
    if (!config.bucket) throw new VfsError("Mount config requires bucket unless a custom ObjectStore is supplied", "EINVAL");
    return new S3ObjectStore({
      bucket: config.bucket,
      region: config.region,
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      prefix: config.prefix,
      forcePathStyle: config.forcePathStyle,
    });
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.fetchSigned({ method: "GET", key: this.fullKey(key) });
    if (res.status === 404) throw new VfsError(`Object not found: ${key}`, "ENOENT");
    await assertOk(res, key);
    return new Uint8Array(await res.arrayBuffer());
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0) throw new RangeError("offset and length must be non-negative");
    if (length === 0) return new Uint8Array();
    const end = offset + length - 1;
    const res = await this.fetchSigned({
      method: "GET",
      key: this.fullKey(key),
      headers: { range: `bytes=${offset}-${end}` },
    });
    if (res.status === 404) throw new VfsError(`Object not found: ${key}`, "ENOENT");
    await assertOk(res, key, [200, 206]);
    return new Uint8Array(await res.arrayBuffer());
  }

  async put(key: string, body: WriteInput, opts: PutOptions = {}): Promise<{ etag: string }> {
    const bytes = await bodyToBytes(body);
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? "application/octet-stream",
    };
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch !== undefined) headers["if-none-match"] = opts.ifNoneMatch;
    const res = await this.fetchSigned({ method: "PUT", key: this.fullKey(key), headers, body: bytes });
    if (res.status === 412) throw new PreconditionFailedError(`S3 precondition failed for ${key}`, key);
    await assertOk(res, key, [200, 201]);
    return { etag: res.headers.get("etag") ?? `"${sha256Hex(bytes)}"` };
  }

  async head(key: string): Promise<ObjectStat | null> {
    const res = await this.fetchSigned({ method: "HEAD", key: this.fullKey(key) });
    if (res.status === 404) return null;
    await assertOk(res, key, [200]);
    const out: ObjectStat = {
      key,
      etag: res.headers.get("etag") ?? "",
      size: Number(res.headers.get("content-length") ?? "0"),
    };
    const lastModified = parseHttpDate(res.headers.get("last-modified"));
    const contentType = res.headers.get("content-type") ?? undefined;
    if (lastModified) out.lastModified = lastModified;
    if (contentType) out.contentType = contentType;
    return out;
  }

  async delete(key: string, opts: DeleteOptions = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    const res = await this.fetchSigned({ method: "DELETE", key: this.fullKey(key), headers });
    if (res.status === 412) throw new PreconditionFailedError(`S3 precondition failed for ${key}`, key);
    await assertOk(res, key, [200, 202, 204]);
  }

  async list(prefix: string, cursor?: string, limit = 1000): Promise<ObjectListResult> {
    const query: Record<string, string | undefined> = {
      "list-type": "2",
      prefix: this.fullKey(prefix),
      "max-keys": String(Math.min(Math.max(limit, 1), 1000)),
      "continuation-token": cursor,
    };
    const res = await this.fetchSigned({ method: "GET", query });
    await assertOk(res, prefix, [200]);
    const xml = await res.text();
    const keys = xmlMatches(xml, "Key").map(unescapeXml).map(key => this.stripFullPrefix(key));
    const token = xmlMatch(xml, "NextContinuationToken");
    return token ? { keys, cursor: unescapeXml(token) } : { keys };
  }

  private fullKey(key: string): string {
    const k = key.replace(/^\/+/, "");
    return this.prefix ? `${this.prefix}/${k}` : k;
  }

  private stripFullPrefix(key: string): string {
    if (!this.prefix) return key;
    return key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
  }

  private async fetchSigned(input: SignedRequestInput): Promise<Response> {
    const signed = this.sign(input);
    const init: RequestInit = { method: input.method, headers: signed.headers };
    if (input.body !== undefined) init.body = requestBody(input.body);
    return fetch(signed.url, init);
  }

  private sign(input: SignedRequestInput): { url: string; headers: Record<string, string> } {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new VfsError("Missing AWS credentials", "ERR_S3_MISSING_CREDENTIALS");
    }

    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const service = "s3";
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const payload = input.body ?? new Uint8Array();
    const payloadHash = sha256Hex(payload);

    const url = this.url(input.key, input.query);
    const headers: Record<string, string> = lowerCaseHeaders(input.headers ?? {});
    headers.host = url.host;
    headers["x-amz-content-sha256"] = payloadHash;
    headers["x-amz-date"] = amzDate;
    if (this.sessionToken) headers["x-amz-security-token"] = this.sessionToken;
    if (input.body && headers["content-length"] === undefined) headers["content-length"] = String(input.body.byteLength);

    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map(name => `${name}:${normalizeHeaderValue(headers[name]!)}\n`)
      .join("");

    const canonicalRequest = [
      input.method.toUpperCase(),
      url.pathname,
      canonicalQueryString(url.searchParams),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(new TextEncoder().encode(canonicalRequest)),
    ].join("\n");

    const signingKey = getSignatureKey(this.secretAccessKey, dateStamp, this.region, service);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { url: url.toString(), headers };
  }

  private url(key?: string, query?: Record<string, string | undefined>): URL {
    const encodedKey = key ? encodeS3Key(key) : "";
    let base: URL;
    if (this.endpoint) {
      base = new URL(this.endpoint);
      if (this.forcePathStyle) {
        base.pathname = joinUrlPath(base.pathname, this.bucket, encodedKey);
      } else {
        base.hostname = `${this.bucket}.${base.hostname}`;
        base.pathname = joinUrlPath(base.pathname, encodedKey);
      }
    } else if (this.forcePathStyle) {
      base = new URL(`https://s3.${this.region}.amazonaws.com/${this.bucket}/${encodedKey}`);
    } else {
      base = new URL(`https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) base.searchParams.set(k, v);
    }
    return base;
  }
}

function requestBody(bytes: Uint8Array): BodyInit {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

async function assertOk(res: Response, key: string, ok: number[] = [200]): Promise<void> {
  if (ok.includes(res.status)) return;
  const text = await res.text().catch(() => "");
  throw new VfsError(`S3 request failed for ${key}: HTTP ${res.status} ${text.slice(0, 500)}`, "EIO");
}

function parseHttpDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(secretKey: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

function canonicalQueryString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${encodeRfc3986(key)}=${encodeRfc3986(value)}`);
  }
  return pairs.sort().join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Key(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

function joinUrlPath(...parts: string[]): string {
  const joined = parts
    .filter(part => part !== "")
    .map((part, i) => (i === 0 ? part.replace(/\/+$/g, "") : part.replace(/^\/+|\/+$/g, "")))
    .filter(Boolean)
    .join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function xmlMatch(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1];
}

function xmlMatches(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (;;) {
    const match = re.exec(xml);
    if (!match) return out;
    out.push(match[1]!);
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

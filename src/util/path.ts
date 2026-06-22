import path from "node:path";
import { VfsError } from "../types";

export function normalizeVfsPath(input: string): string {
  if (!input) return "/";
  const withSlash = input.startsWith("/") ? input : `/${input}`;
  const normalized = path.posix.normalize(withSlash).replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) return `/${normalized}`;
  return normalized;
}

export function splitVfsPath(input: string): string[] {
  const p = normalizeVfsPath(input);
  if (p === "/") return [];
  return p.slice(1).split("/").filter(Boolean);
}

export function parentPath(input: string): string {
  const p = normalizeVfsPath(input);
  if (p === "/") return "/";
  const dir = path.posix.dirname(p);
  return dir === "." ? "/" : dir;
}

export function basename(input: string): string {
  const p = normalizeVfsPath(input);
  if (p === "/") return "";
  return path.posix.basename(p);
}

export function joinVfs(...parts: string[]): string {
  return normalizeVfsPath(path.posix.join(...parts));
}

export function ensureSafeObjectKey(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\/+/g, "/");
  if (!normalized || normalized.includes("..")) {
    throw new VfsError(`Unsafe object key: ${key}`, "EINVAL");
  }
  return normalized;
}

export function joinPrefix(prefix: string, key: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const k = key.replace(/^\/+/, "");
  return p ? `${p}/${k}` : k;
}

export function stripPrefix(prefix: string, key: string): string {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const normalized = key.replace(/^\/+/, "");
  if (!p) return normalized;
  if (normalized === p) return "";
  if (normalized.startsWith(`${p}/`)) return normalized.slice(p.length + 1);
  return normalized;
}

export function safeLocalJoin(root: string, key: string): string {
  const safe = key.replace(/^\/+/, "");
  const full = path.resolve(root, safe);
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new VfsError(`Unsafe local path: ${key}`, "EINVAL");
  }
  return full;
}

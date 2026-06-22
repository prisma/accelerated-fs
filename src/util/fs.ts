import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function rmIfExists(file: string): Promise<void> {
  await rm(file, { recursive: true, force: true });
}

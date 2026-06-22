import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  AcceleratedFS,
  AcceleratedFSDirectoryNotEmptyError,
  AcceleratedFSReadonlyFilesystemError,
  FileExistsError,
  LocalObjectStore,
  StaleFileError,
} from "../src/index";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = path.join("/tmp", `acceleratedfs-${name}-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function makeProvider(name: string, objectRoot: string, readOnly = false): AcceleratedFS {
  const store = new LocalObjectStore(objectRoot);
  return new AcceleratedFS({
    id: name,
    mountName: name,
    cacheRoot: tempRoot(`${name}-cache`),
    cacheBytes: 8 * 1024 * 1024,
    readOnly,
    prefix: "workspace",
    storeFactory: () => store,
  });
}

test("AcceleratedFS implements Mastra-style text, binary, stat, and listing operations", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("basic", objectRoot);

  await fs.writeFile("/docs/a.md", "# A\nline 2", { recursive: true });

  expect(await fs.readFile("/docs/a.md")).toBe("# A\nline 2");
  expect(await fs.readFile("/docs/a.md", { startLine: 2, endLine: 2 })).toBe("line 2");

  const binary = await fs.readFile("/docs/a.md", { encoding: "binary" });
  expect(binary instanceof Buffer).toBe(true);
  expect(binary.toString()).toBe("# A\nline 2");

  const stat = await fs.stat("/docs/a.md");
  expect(stat.name).toBe("a.md");
  expect(stat.type).toBe("file");
  expect(stat.size).toBe("# A\nline 2".length);
  expect(stat.mimeType).toBe("text/markdown");

  const entries = await fs.readdir("/docs");
  expect(entries).toEqual([{ name: "a.md", type: "file", size: "# A\nline 2".length }]);

  await fs.destroy();
});

test("appendFile creates parents automatically and copy/move/delete preserve Mastra semantics", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("ops", objectRoot);

  await fs.appendFile("/logs/app.log", "one\n");
  await fs.appendFile("/logs/app.log", "two\n");
  expect(await fs.readFile("/logs/app.log")).toBe("one\ntwo\n");

  await fs.copyFile("/logs/app.log", "/backup/app.log");
  expect(await fs.readFile("/backup/app.log")).toBe("one\ntwo\n");

  await fs.moveFile("/backup/app.log", "/backup/final.log");
  expect(await fs.exists("/backup/app.log")).toBe(false);
  expect(await fs.readFile("/backup/final.log")).toBe("one\ntwo\n");

  await fs.deleteFile("/backup/final.log");
  expect(await fs.exists("/backup/final.log")).toBe(false);

  await fs.destroy();
});

test("writeFile respects recursive, overwrite, and expectedMtime options", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("options", objectRoot);

  let missingParent = false;
  try {
    await fs.writeFile("/missing/file.txt", "nope");
  } catch {
    missingParent = true;
  }
  expect(missingParent).toBe(true);

  await fs.writeFile("/missing/file.txt", "ok", { recursive: true });
  await expect(fs.writeFile("/missing/file.txt", "blocked", { overwrite: false })).rejects.toBeInstanceOf(FileExistsError);

  const stat = await fs.stat("/missing/file.txt");
  await fs.writeFile("/missing/file.txt", "same mtime", { expectedMtime: stat.modifiedAt });
  await expect(fs.writeFile("/missing/file.txt", "stale", { expectedMtime: new Date(0) })).rejects.toBeInstanceOf(StaleFileError);

  await fs.destroy();
});

test("rmdir checks emptiness unless recursive is requested", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("rmdir", objectRoot);

  await fs.writeFile("/dir/child.txt", "x", { recursive: true });
  await expect(fs.rmdir("/dir")).rejects.toBeInstanceOf(AcceleratedFSDirectoryNotEmptyError);
  await fs.rmdir("/dir", { recursive: true });
  expect(await fs.exists("/dir")).toBe(false);

  await fs.destroy();
});

test("read-only AcceleratedFS reads existing data and blocks writes", async () => {
  const objectRoot = tempRoot("objects");
  const writer = makeProvider("writer", objectRoot);
  await writer.writeFile("/shared.txt", "persisted", { recursive: true });
  await writer.destroy();

  const reader = makeProvider("reader", objectRoot, true);
  expect(await reader.readFile("/shared.txt")).toBe("persisted");
  await expect(reader.writeFile("/blocked.txt", "nope", { recursive: true })).rejects.toBeInstanceOf(AcceleratedFSReadonlyFilesystemError);

  await reader.destroy();
});

test("recursive readdir supports extension and glob filters", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("list", objectRoot);

  await fs.writeFile("/data/a.json", "{}", { recursive: true });
  await fs.writeFile("/data/nested/b.json", "{}", { recursive: true });
  await fs.writeFile("/data/nested/c.txt", "txt", { recursive: true });

  const jsonEntries = await fs.readdir("/data", { recursive: true, extension: ".json", glob: "**/*.json" });
  expect(jsonEntries.map(e => e.name).sort()).toEqual(["a.json", "nested/b.json"]);

  await fs.destroy();
});

test("grep searches workspace files with regex, context, and include filters", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("grep", objectRoot);

  await fs.writeFile("/docs/a.md", "before\nHello Alpha\nafter", { recursive: true });
  await fs.writeFile("/docs/b.txt", "Hello Beta", { recursive: true });
  await fs.writeFile("/docs/nested/c.md", "nothing\nhello gamma", { recursive: true });

  const matches = await fs.grep("hello\\s+\\w+", {
    path: "/docs",
    include: "**/*.md",
    caseSensitive: false,
    contextLines: 1,
  });

  expect(matches.map(match => `${match.path}:${match.line}:${match.match}`)).toEqual([
    "/docs/a.md:2:Hello Alpha",
    "/docs/nested/c.md:2:hello gamma",
  ]);
  expect(matches[0]?.before).toEqual(["before"]);
  expect(matches[1]?.before).toEqual(["nothing"]);

  await fs.destroy();
});

test("grep searches cached workspace contents with include filters", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("grep", objectRoot);

  await fs.writeFile("/notes/a.md", "hello\nneedle here\nbye", { recursive: true });
  await fs.writeFile("/notes/b.txt", "needle but excluded", { recursive: true });

  const matches = await fs.grep("needle", { path: "/notes", include: "*.md", contextLines: 1 });
  expect(matches.length).toBe(1);
  expect(matches[0]?.path).toBe("/notes/a.md");
  expect(matches[0]?.line).toBe(2);
  expect(matches[0]?.match).toBe("needle");
  expect(matches[0]?.before).toEqual(["hello"]);

  await fs.destroy();
});


test("getInfo and getInstructions expose Mastra metadata", async () => {
  const objectRoot = tempRoot("objects");
  const fs = makeProvider("info", objectRoot);
  const info = fs.getInfo();

  expect(info.id).toBe("info");
  expect(info.name).toBe("AcceleratedFS");
  expect(info.provider).toBe("accelerated-s3");
  expect(info.readOnly).toBe(false);
  expect(info.basePath).toBe("acceleratedfs://info/workspace");
  expect(fs.getInstructions()).toContain("AcceleratedFS");

  await fs.destroy();
});

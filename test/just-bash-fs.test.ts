import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  AcceleratedJustBashFs,
  createAcceleratedJustBashShell,
  LocalObjectStore,
  S3CachedFsManagerImpl,
  type S3CachedFs,
} from "../src/index";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = path.join("/tmp", `acceleratedfs-just-bash-${name}-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeCore(name: string): Promise<S3CachedFs> {
  const objectRoot = tempRoot(`${name}-objects`);
  const manager = new S3CachedFsManagerImpl({
    cacheRoot: tempRoot(`${name}-cache`),
    storeFactory: () => new LocalObjectStore(objectRoot),
  });
  return manager.mount({
    name,
    mode: "readwrite",
    prefix: "workspace",
    cacheBytes: 8 * 1024 * 1024,
  });
}

test("AcceleratedJustBashFs implements text, binary, append, stat, and listing methods", async () => {
  const core = await makeCore("basic");
  const fs = new AcceleratedJustBashFs(core);

  await fs.mkdir("/docs", { recursive: true });
  await fs.writeFile("/docs/a.txt", "hello");
  await fs.appendFile("/docs/a.txt", " world");

  expect(await fs.readFile("/docs/a.txt")).toBe("hello world");
  expect(await fs.readFile("/docs/a.txt", "hex")).toBe(Buffer.from("hello world").toString("hex"));
  expect(await fs.readFileBuffer("/docs/a.txt")).toEqual(new TextEncoder().encode("hello world"));

  const stat = await fs.stat("/docs/a.txt");
  expect(stat.isFile).toBe(true);
  expect(stat.isDirectory).toBe(false);
  expect(stat.size).toBe("hello world".length);

  const entries = await fs.readdirWithFileTypes("/docs");
  expect(entries).toEqual([{ name: "a.txt", isFile: true, isDirectory: false, isSymbolicLink: false }]);

  await core.close();
});

test("AcceleratedJustBashFs supports persistent symlinks and realpath resolution", async () => {
  const core = await makeCore("links");
  const fs = new AcceleratedJustBashFs(core);

  await fs.writeFile("/data/source.txt", "target");
  await fs.symlink("/data/source.txt", "/data/link.txt");

  expect(await fs.readlink("/data/link.txt")).toBe("/data/source.txt");
  expect(await fs.readFile("/data/link.txt")).toBe("target");
  expect((await fs.lstat("/data/link.txt")).isSymbolicLink).toBe(true);
  expect(await fs.realpath("/data/link.txt")).toBe("/data/source.txt");

  const remountedWrapper = new AcceleratedJustBashFs(core);
  expect(await remountedWrapper.readlink("/data/link.txt")).toBe("/data/source.txt");
  expect((await remountedWrapper.readdir("/")).includes(".acceleratedfs.just-bash.symlinks.json")).toBe(false);

  await core.close();
});

test("AcceleratedJustBashFs copies, moves, removes, chmods, and updates mtimes", async () => {
  const core = await makeCore("ops");
  const fs = new AcceleratedJustBashFs(core);

  await fs.writeFile("/a.txt", "one");
  await fs.cp("/a.txt", "/dir/b.txt");
  expect(await fs.readFile("/dir/b.txt")).toBe("one");

  await fs.mv("/dir/b.txt", "/dir/c.txt");
  expect(await fs.exists("/dir/b.txt")).toBe(false);
  expect(await fs.readFile("/dir/c.txt")).toBe("one");

  await fs.chmod("/dir/c.txt", 0o600);
  expect((await fs.stat("/dir/c.txt")).mode).toBe(0o600);

  const mtime = new Date("2026-01-01T00:00:00.000Z");
  await fs.utimes("/dir/c.txt", mtime, mtime);
  expect((await fs.stat("/dir/c.txt")).mtime.getTime()).toBe(mtime.getTime());

  await fs.rm("/dir", { recursive: true });
  expect(await fs.exists("/dir")).toBe(false);

  await core.close();
});

test("createAcceleratedJustBashShell wires the wrapper into a Bash-compatible constructor", async () => {
  const core = await makeCore("shell");

  class FakeBash {
    readonly fs: AcceleratedJustBashFs;
    readonly cwd: string;

    constructor(options: Record<string, unknown> = {}) {
      this.fs = options.fs as AcceleratedJustBashFs;
      this.cwd = options.cwd as string;
    }

    async exec(command: string, options: Record<string, unknown> = {}) {
      const cwd = options.cwd as string | undefined ?? this.cwd;
      if (command === "write") await this.fs.writeFile(`${cwd}/out.txt`, "from shell");
      const stdout = command === "pwd" ? `${cwd}\n` : "";
      return { stdout, stderr: "", exitCode: 0 };
    }
  }

  const shell = await createAcceleratedJustBashShell({ filesystem: core, Bash: FakeBash, cwd: "/workspace" });
  expect((await shell.exec("pwd")).stdout).toBe("/workspace\n");
  await shell.exec("write");
  expect(await core.readText("/workspace/out.txt")).toBe("from shell");

  await shell.close();
  await core.close();
});

import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  acceleratedFsSandbox,
  AcceleratedJustBashFs,
  LocalObjectStore,
  S3CachedFsManagerImpl,
  type S3CachedFs,
} from "../src/index";

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = path.join("/tmp", `acceleratedfs-flue-${name}-${crypto.randomUUID()}`);
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

test("acceleratedFsSandbox exposes Flue filesystem methods and executes through just-bash", async () => {
  const core = await makeCore("flue");

  class FakeBash {
    readonly fs: AcceleratedJustBashFs;
    readonly cwd: string;

    constructor(options: Record<string, unknown> = {}) {
      this.fs = options.fs as AcceleratedJustBashFs;
      this.cwd = options.cwd as string;
    }

    async exec(command: string, options: Record<string, unknown> = {}) {
      const cwd = options.cwd as string | undefined ?? this.cwd;
      if (command === "cat input") {
        return { stdout: await this.fs.readFile(`${cwd}/input.txt`), stderr: "", exitCode: 0 };
      }
      if (command === "write output") {
        await this.fs.writeFile(`${cwd}/output.txt`, "created by shell");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unknown command", exitCode: 127 };
    }
  }

  const runtime = {
    createSandboxSessionEnv(api: unknown, cwd: string) {
      return { api, cwd };
    },
  };

  const sandbox = acceleratedFsSandbox({ filesystem: core, Bash: FakeBash, runtime, cwd: "/workspace" });
  const env = await sandbox.createSessionEnv({ id: "ctx-1" }) as { api: any; cwd: string };

  expect(env.cwd).toBe("/workspace");
  await env.api.writeFile("/workspace/input.txt", "hello flue");
  expect(await env.api.readFile("/workspace/input.txt")).toBe("hello flue");
  expect((await env.api.stat("/workspace/input.txt")).isFile).toBe(true);
  expect(await env.api.readdir("/workspace")).toEqual(["input.txt"]);

  const result = await env.api.exec("cat input", { cwd: "/workspace" });
  expect(result).toEqual({ stdout: "hello flue", stderr: "", exitCode: 0 });

  await env.api.exec("write output", { cwd: "/workspace" });
  expect(await core.readText("/workspace/output.txt")).toBe("created by shell");

  await sandbox.close();
});

import { acceleratedFsSandbox } from "../src/flue";
import { cleanupDemo, createDemoManager, createDemoPaths, DEMO_CACHE_BYTES, isMain, printDemoResult } from "./shared";
import { DemoBash } from "./bash-compatible";

export interface FlueDemoResult {
  cwd: string;
  readBack: string;
  execStdout: string;
  shellCreatedFile: string;
  listing: string[];
}

export async function runFlueDemo(): Promise<FlueDemoResult> {
  const paths = createDemoPaths("flue");
  const manager = createDemoManager(paths);

  try {
    const core = await manager.mount({
      name: "flue-demo",
      mode: "readwrite",
      cacheBytes: DEMO_CACHE_BYTES,
    });
    const runtime = {
      createSandboxSessionEnv(api: unknown, cwd: string): unknown {
        return { api, cwd };
      },
    };
    const sandbox = acceleratedFsSandbox({
      filesystem: core,
      Bash: DemoBash,
      runtime,
      cwd: "/workspace",
    });
    const env = await sandbox.createSessionEnv({ id: "demo" }) as {
      api: {
        writeFile(path: string, content: string): Promise<void>;
        readFile(path: string): Promise<string>;
        readdir(path: string): Promise<string[]>;
        exec(command: string, options?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
      };
      cwd: string;
    };

    await env.api.writeFile("/workspace/input.txt", "hello from flue\n");
    const readBack = await env.api.readFile("/workspace/input.txt");
    const cat = await env.api.exec("cat input.txt", { cwd: env.cwd });
    await env.api.exec("mkdir -p reports", { cwd: env.cwd });
    await env.api.exec("echo sandbox-output > reports/out.txt", { cwd: env.cwd });
    const shellCreatedFile = await core.readText("/workspace/reports/out.txt");
    const listing = await env.api.readdir("/workspace");

    await sandbox.close();

    return {
      cwd: env.cwd,
      readBack,
      execStdout: cat.stdout,
      shellCreatedFile,
      listing,
    };
  } finally {
    await manager.closeAll().catch(() => {});
    await cleanupDemo(paths);
  }
}

if (isMain(import.meta)) {
  printDemoResult(await runFlueDemo());
}

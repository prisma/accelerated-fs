import { acceleratedFsSandbox } from "../../src/flue";
import { DemoBash } from "../../demos/bash-compatible";
import { serveDemoApp, withCoreFilesystem } from "../_shared/runtime";

serveDemoApp("flue", () =>
  withCoreFilesystem("flue", async fs => {
    const runtime = {
      createSandboxSessionEnv(api: unknown, cwd: string): unknown {
        return { api, cwd };
      },
    };
    const sandbox = acceleratedFsSandbox({
      filesystem: fs,
      Bash: DemoBash,
      runtime,
      cwd: "/workspace",
    });

    try {
      const env = await sandbox.createSessionEnv({ id: "compute-demo" }) as {
        api: {
          writeFile(path: string, content: string): Promise<void>;
          readFile(path: string): Promise<string>;
          readdir(path: string): Promise<string[]>;
          exec(command: string, options?: { cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
        };
        cwd: string;
      };

      await env.api.writeFile("/workspace/input.txt", "hello from flue compute\n");
      const readBack = await env.api.readFile("/workspace/input.txt");
      const cat = await env.api.exec("cat input.txt", { cwd: env.cwd });
      await env.api.exec("mkdir -p reports", { cwd: env.cwd });
      await env.api.exec("echo flue-shell > reports/out.txt", { cwd: env.cwd });

      return {
        cwd: env.cwd,
        readBack,
        execStdout: cat.stdout,
        shellCreatedFile: await fs.readText("/workspace/reports/out.txt"),
        listing: await env.api.readdir("/workspace"),
      };
    } finally {
      await sandbox.close().catch(() => {});
    }
  }),
);

import { createAcceleratedJustBashShell } from "../../src/just-bash";
import { DemoBash } from "../../demos/bash-compatible";
import { serveDemoApp, withCoreFilesystem } from "../_shared/runtime";

serveDemoApp("just-bash", () =>
  withCoreFilesystem("just-bash", async fs => {
    const shell = await createAcceleratedJustBashShell({
      filesystem: fs,
      Bash: DemoBash,
      cwd: "/workspace",
    });

    try {
      const pwd = await shell.exec("pwd");
      await shell.exec("mkdir -p reports");
      await shell.exec("echo compute-shell > reports/out.txt");
      const cat = await shell.exec("cat reports/out.txt");
      const grep = await shell.exec("grep -R compute .");
      const persisted = await fs.readText("/workspace/reports/out.txt");

      return {
        pwd: pwd.stdout,
        cat: cat.stdout,
        grep: grep.stdout,
        persisted,
        knownPaths: shell.fs.getAllPaths(),
      };
    } finally {
      await shell.close().catch(() => {});
    }
  }),
);

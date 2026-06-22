import { createDemoManager, cleanupDemo, createDemoPaths, DEMO_CACHE_BYTES, isMain, printDemoResult } from "./shared";
import { createAcceleratedJustBashShell } from "../src/just-bash";
import { DemoBash } from "./bash-compatible";

export interface JustBashDemoResult {
  pwd: string;
  cat: string;
  grep: string;
  persisted: string;
  knownPaths: string[];
}

export async function runJustBashDemo(): Promise<JustBashDemoResult> {
  const paths = createDemoPaths("just-bash");
  const manager = createDemoManager(paths);

  try {
    const core = await manager.mount({
      name: "just-bash-demo",
      mode: "readwrite",
      cacheBytes: DEMO_CACHE_BYTES,
    });
    const shell = await createAcceleratedJustBashShell({
      filesystem: core,
      Bash: DemoBash,
      cwd: "/workspace",
    });

    const pwd = await shell.exec("pwd");
    await shell.exec("mkdir -p reports");
    await shell.exec("echo cached-shell > reports/out.txt");
    const cat = await shell.exec("cat reports/out.txt");
    const grep = await shell.exec("grep -R cached .");
    const persisted = await core.readText("/workspace/reports/out.txt");
    const knownPaths = shell.fs.getAllPaths();

    await shell.close();
    await manager.closeAll();

    return {
      pwd: pwd.stdout,
      cat: cat.stdout,
      grep: grep.stdout,
      persisted,
      knownPaths,
    };
  } finally {
    await manager.closeAll().catch(() => {});
    await cleanupDemo(paths);
  }
}

if (isMain(import.meta)) {
  printDemoResult(await runJustBashDemo());
}

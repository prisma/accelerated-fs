import { LocalObjectStore } from "../src/core";
import { AcceleratedFS } from "../src/mastra";
import {
  cleanupDemo,
  createDemoPaths,
  DEMO_CACHE_BYTES,
  isMain,
  printDemoResult,
} from "./shared";

interface WorkspaceLike {
  filesystem: AcceleratedFS;
}

export interface MastraDemoResult {
  provider: string;
  basePath: string | undefined;
  entries: string[];
  grepMatches: string[];
  rangePreview: string;
  instructionsMentionCache: boolean;
}

export async function runMastraDemo(): Promise<MastraDemoResult> {
  const paths = createDemoPaths("mastra");
  const store = new LocalObjectStore(paths.objectRoot);
  const filesystem = new AcceleratedFS({
    id: "mastra-demo",
    mountName: "mastra-demo",
    cacheRoot: paths.cacheRoot,
    cacheBytes: DEMO_CACHE_BYTES,
    storeFactory: () => store,
    displayName: "Mastra AcceleratedFS demo",
  });
  const workspace: WorkspaceLike = { filesystem };

  try {
    await workspace.filesystem.writeFile("/docs/brief.md", "# Brief\nTODO: summarize workspace\n", {
      recursive: true,
    });
    await workspace.filesystem.appendFile("/docs/brief.md", "done: cached metadata powers listing\n");
    await workspace.filesystem.writeFile("/data/input.json", JSON.stringify({ rows: 2 }), {
      recursive: true,
    });

    const entries = await workspace.filesystem.readdir("/", { recursive: true });
    const grepMatches = await workspace.filesystem.grep("TODO", {
      path: "/docs",
      include: "*.md",
      contextLines: 0,
    });
    const rangePreview = new TextDecoder().decode(await workspace.filesystem.readRange("/docs/brief.md", 0, 7));
    const info = workspace.filesystem.getInfo();

    return {
      provider: info.provider,
      basePath: info.basePath,
      entries: entries.map(entry => entry.name).sort(),
      grepMatches: grepMatches.map(match => `${match.path}:${match.line}:${match.match}`),
      rangePreview,
      instructionsMentionCache: workspace.filesystem.getInstructions().includes("bounded local cache"),
    };
  } finally {
    await workspace.filesystem.destroy().catch(() => {});
    await cleanupDemo(paths);
  }
}

if (isMain(import.meta)) {
  printDemoResult(await runMastraDemo());
}

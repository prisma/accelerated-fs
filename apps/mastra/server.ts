import { AcceleratedFS } from "../../src/mastra";
import { createDemoContext, createMountConfig, serveDemoApp } from "../_shared/runtime";

serveDemoApp("mastra", async () => {
  const context = createDemoContext("mastra");
  const mount = createMountConfig("mastra", context.prefix);
  const options: ConstructorParameters<typeof AcceleratedFS>[0] = {
    id: "mastra-compute-demo",
    mountName: mount.name,
    cacheRoot: `/tmp/accelerated-fs/mastra/${context.requestId}`,
    cacheBytes: mount.cacheBytes,
  };
  if (mount.bucket !== undefined) options.bucket = mount.bucket;
  if (mount.prefix !== undefined) options.prefix = mount.prefix;
  if (mount.region !== undefined) options.region = mount.region;
  if (mount.endpoint !== undefined) options.endpoint = mount.endpoint;
  if (mount.accessKeyId !== undefined) options.accessKeyId = mount.accessKeyId;
  if (mount.secretAccessKey !== undefined) options.secretAccessKey = mount.secretAccessKey;
  if (mount.chunkBytes !== undefined) options.chunkBytes = mount.chunkBytes;
  if (mount.smallFileBytes !== undefined) options.smallFileBytes = mount.smallFileBytes;
  if (mount.packBytes !== undefined) options.packBytes = mount.packBytes;
  const filesystem = new AcceleratedFS(options);

  try {
    await filesystem.writeFile("/docs/brief.md", "# Brief\nTODO: verify Mastra provider\n", { recursive: true });
    await filesystem.appendFile("/docs/brief.md", "done: write-through commit\n");
    await filesystem.writeFile("/data/input.json", JSON.stringify({ rows: 2 }), { recursive: true });

    const entries = await filesystem.readdir("/", { recursive: true });
    const matches = await filesystem.grep("TODO", { path: "/docs", include: "*.md" });
    const range = new TextDecoder().decode(await filesystem.readRange("/docs/brief.md", 0, 7));
    const info = filesystem.getInfo();

    return {
      app: "mastra",
      requestId: context.requestId,
      prefix: context.prefix,
      result: {
        provider: info.provider,
        entries: entries.map(entry => entry.name).sort(),
        matches: matches.map(match => `${match.path}:${match.line}:${match.match}`),
        range,
      },
    };
  } finally {
    await filesystem.destroy().catch(() => {});
  }
});

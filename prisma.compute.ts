import { defineComputeConfig } from "@prisma/compute-sdk/config";

export default defineComputeConfig({
  apps: {
    core: {
      name: "accelerated-fs-core",
      framework: "bun",
      entry: "apps/core/server.ts",
      httpPort: 8080,
    },
    mastra: {
      name: "accelerated-fs-mastra",
      framework: "bun",
      entry: "apps/mastra/server.ts",
      httpPort: 8080,
    },
    "just-bash": {
      name: "accelerated-fs-just-bash",
      framework: "bun",
      entry: "apps/just-bash/server.ts",
      httpPort: 8080,
    },
    flue: {
      name: "accelerated-fs-flue",
      framework: "bun",
      entry: "apps/flue/server.ts",
      httpPort: 8080,
    },
    "load-test": {
      name: "accelerated-fs-load-test",
      framework: "bun",
      entry: "apps/load-test/server.ts",
      httpPort: 8080,
    },
    "load-test-r2": {
      name: "accelerated-fs-load-test-r2",
      framework: "bun",
      entry: "apps/load-test/server.ts",
      httpPort: 8080,
    },
  },
});

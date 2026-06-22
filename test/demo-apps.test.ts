import { expect, test } from "bun:test";
import { runCoreDemo } from "../demos/core";
import { runFlueDemo } from "../demos/flue";
import { runJustBashDemo } from "../demos/just-bash";
import { runMastraDemo } from "../demos/mastra";

test("core demo app runs against LocalObjectStore and remounts readonly", async () => {
  const result = await runCoreDemo();
  expect(result.files).toEqual(["alpha.txt", "beta.txt", "large.txt"]);
  expect(result.firstRange).toBe("streamed write");
  expect(result.persistedAfterRemount).toBe("batch-1 complete\n");
  expect(result.objectCounts.wal).toBeGreaterThan(0);
  expect(result.objectCounts.packs).toBeGreaterThan(0);
  expect(result.objectCounts.blobs).toBeGreaterThan(0);
});

test("Mastra demo app runs through the structural provider", async () => {
  const result = await runMastraDemo();
  expect(result.provider).toBe("accelerated-s3");
  expect(result.entries).toContain("docs/brief.md");
  expect(result.grepMatches).toEqual(["/docs/brief.md:2:TODO"]);
  expect(result.rangePreview).toBe("# Brief");
  expect(result.instructionsMentionCache).toBe(true);
});

test("just-bash demo app runs through a Bash-compatible shell", async () => {
  const result = await runJustBashDemo();
  expect(result.pwd).toBe("/workspace\n");
  expect(result.cat).toBe("cached-shell\n");
  expect(result.grep).toContain("/workspace/reports/out.txt:1:cached-shell");
  expect(result.persisted).toBe("cached-shell\n");
  expect(result.knownPaths).toContain("/workspace/reports/out.txt");
});

test("Flue demo app runs through the sandbox adapter", async () => {
  const result = await runFlueDemo();
  expect(result.cwd).toBe("/workspace");
  expect(result.readBack).toBe("hello from flue\n");
  expect(result.execStdout).toBe("hello from flue\n");
  expect(result.shellCreatedFile).toBe("sandbox-output\n");
  expect(result.listing.sort()).toEqual(["input.txt", "reports"]);
});

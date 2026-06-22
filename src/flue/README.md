# Flue Adapter

`s3-bun-cached-fs/flue` exports `acceleratedFsSandbox()`, a Flue sandbox factory backed by `S3CachedFs` for file operations and by just-bash for shell execution.

The value proposition: Flue agents get a sandbox-shaped API over a durable S3-backed workspace, with fast local metadata and bounded cache performance, without granting direct access to the host filesystem.

## Why Use It

Use this adapter when a Flue agent needs:

- durable remote workspace files
- fast `stat()` and `readdir()` from local SQLite metadata
- file writes that commit through the core WAL/head protocol
- shell-like `exec()` through just-bash rather than host processes
- a bounded local cache for large remote workspaces
- the same many-reader, single-writer guarantees as the core filesystem

Do not use it as a drop-in replacement for a host sandbox. It intentionally does not expose host process execution or host absolute paths.

## Install

```bash
bun add s3-bun-cached-fs @flue/runtime just-bash
```

`@flue/runtime` and `just-bash` are optional peers. The adapter imports them only when the Flue sandbox or shell execution path is used.

## Agent Wiring

```ts
import { createAgent } from "@flue/runtime";
import { acceleratedFsSandbox } from "s3-bun-cached-fs/flue";

export default createAgent(() => ({
  model: "anthropic/claude-sonnet-4-6",
  sandbox: acceleratedFsSandbox({
    cwd: "/workspace",
    mount: {
      name: "flue-workspace",
      mode: "readwrite",
      bucket: "my-bucket",
      prefix: "flue/workspaces/customer-123",
      region: "us-east-1",
      cacheBytes: 500 * 1024 * 1024,
    },
    managerConfig: {
      cacheRoot: "/tmp/accelerated-fs-flue",
    },
  }),
  cwd: "/workspace",
}));
```

The adapter creates a core mount when `mount` is supplied. You can also pass an already-mounted filesystem:

```ts
const sandbox = acceleratedFsSandbox({
  filesystem: core,
  cwd: "/workspace",
  closeOnClose: false,
});
```

When `filesystem` is supplied, your application owns it by default. When the adapter creates its own manager, `sandbox.close()` closes that manager by default.

## Sandbox API

The session API maps Flue file calls to `AcceleratedJustBashFs`:

```ts
await api.readFile(path);
await api.readFileBuffer(path);
await api.writeFile(path, content);
await api.stat(path);
await api.readdir(path);
await api.exists(path);
await api.mkdir(path, { recursive: true });
await api.rm(path, { recursive: true, force: true });
```

`exec()` maps to `AcceleratedJustBashShell`:

```ts
const result = await api.exec("grep -R TODO .", {
  cwd: "/workspace",
  env: { CI: "1" },
  timeoutMs: 10_000,
});
```

Because execution uses just-bash, commands operate inside the virtual filesystem. They do not see the host filesystem unless you explicitly configure a different just-bash filesystem layer.

## Path Cache

just-bash uses synchronous path enumeration for some commands. The adapter updates the path cache as files are touched.

Use `primePathCache: true` only when command globbing must see the whole existing workspace before any command touches it:

```ts
const sandbox = acceleratedFsSandbox({
  filesystem: core,
  cwd: "/workspace",
  primePathCache: true,
});
```

This walks the full namespace and can be expensive for large workspaces.

## Local Demo

Run the self-contained demo from the repository root:

```bash
bun run demo:flue
```

The demo uses `LocalObjectStore`, a small Flue runtime shim, and a Bash-compatible shim so it runs without AWS credentials or optional peer installs. In a real Flue app, omit those overrides and let the adapter import the actual runtimes.

## Caveats

- `exec()` is just-bash, not `child_process`.
- Host absolute paths are not visible by default.
- Symlinks are persisted through the just-bash sidecar file.
- Hard links are simulated as copies.
- Directory `chmod` and `utimes` are best-effort no-ops because the core API does not expose metadata-only directory updates yet.

Full reference: [`../../docs/flue-accelerated-fs.md`](../../docs/flue-accelerated-fs.md).

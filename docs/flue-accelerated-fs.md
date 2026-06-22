# Flue sandbox: AcceleratedFS with just-bash

`acceleratedFsSandbox()` is a Flue sandbox adapter backed by `S3CachedFs` for file operations and `just-bash` for shell execution.

It implements Flue's sandbox API shape:

```ts
readFile(path): Promise<string>
readFileBuffer(path): Promise<Uint8Array>
writeFile(path, content): Promise<void>
stat(path): Promise<FileStat>
readdir(path): Promise<string[]>
exists(path): Promise<boolean>
mkdir(path, options): Promise<void>
rm(path, options): Promise<void>
exec(command, options): Promise<{ stdout; stderr; exitCode }>
```

The adapter calls Flue's `createSandboxSessionEnv(api, cwd)` and passes the provider-owned base cwd. Flue applies the agent's configured cwd later during harness initialization.

## Install

```bash
bun add just-bash @flue/runtime
```

`@flue/runtime` and `just-bash` are optional peer dependencies of this package. They are imported only when the Flue adapter or shell helper is used.

## Agent wiring

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
      region: "eu-central-1",
      cacheBytes: 500 * 1024 * 1024,
    },
    managerConfig: {
      cacheRoot: "/tmp/accelerated-fs-flue",
    },
  }),
  cwd: "/workspace",
}));
```

## Reusing an existing mount

```ts
import { acceleratedFsSandbox } from "s3-bun-cached-fs/flue";

const sandbox = acceleratedFsSandbox({
  filesystem: core,
  cwd: "/workspace",
  closeOnClose: false,
});
```

When `filesystem` is supplied, the application owns that filesystem by default. When the adapter creates its own manager from `mount`, `close()` closes the owned manager by default.

Flue does not automatically destroy provider sandboxes. Call `sandbox.close()` from your application shutdown path when you want final metadata snapshots and writer lease release.

## Exec behavior

`exec()` uses `AcceleratedJustBashShell`.

```ts
const result = await api.exec("grep -R TODO .", {
  cwd: "/workspace",
  env: { CI: "1" },
  timeoutMs: 10_000,
});
```

The adapter forwards:

- `cwd`
- `env`
- `timeoutMs`
- `signal`

Timeouts return exit code `124` when just-bash observes the abort. Explicit aborts return exit code `130`.

Because this is just-bash, not a host shell, commands run inside a TypeScript sandbox and use the S3-backed virtual filesystem. They do not see the host filesystem unless just-bash itself is configured to expose it through some other filesystem option.

## just-bash options

Pass just-bash options through `bashOptions`:

```ts
const sandbox = acceleratedFsSandbox({
  filesystem: core,
  cwd: "/workspace",
  bashOptions: {
    network: {
      allowedUrlPrefixes: ["https://api.example.com"],
    },
  },
});
```

You can also supply a `Bash` constructor or `justBashModule` directly. This is useful in tests and bundlers that do not want dynamic imports.

## File behavior

File reads and writes go through `AcceleratedJustBashFs`, which in turn writes through the core metadata WAL.

```text
Flue fs call
  -> AcceleratedFlueSandboxApi
  -> AcceleratedJustBashFs
  -> S3CachedFs
  -> S3 WAL + immutable data objects
```

This gives Flue:

- fast `stat()` and `readdir()` from local SQLite metadata
- bounded local cache for large workspaces
- write-through remote durability
- efficient packed storage for small files
- many-reader / single-writer semantics

## Path cache and globbing

just-bash uses synchronous path enumeration in some commands. `AcceleratedJustBashFs` maintains a path cache as files are touched.

Set `primePathCache: true` when shell globbing must know about the entire existing workspace before any command touches it:

```ts
const sandbox = acceleratedFsSandbox({
  filesystem: core,
  cwd: "/workspace",
  primePathCache: true,
});
```

This walks the whole namespace and can be expensive for very large workspaces. For agent workflows where commands mostly operate in known directories, leave it off.

## Limitations

This adapter is not a drop-in replacement for Flue's local host sandbox.

- shell execution is just-bash, not `child_process`
- host paths are not visible unless explicitly exposed through a different just-bash filesystem layer
- symbolic links are persisted in a hidden sidecar file by the wrapper
- hard links are simulated as copies
- directory `chmod` and `utimes` are best-effort no-ops because the core API does not expose metadata-only directory updates yet

For agent workspaces, that limitation is intentional: the agent can use shell-like commands without receiving direct access to the runtime's host filesystem.

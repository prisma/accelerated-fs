import path from "node:path";
import type {
  AcceleratedJustBashExecResult,
  AcceleratedJustBashFs,
} from "../src/just-bash";

export class DemoBash {
  readonly fs: AcceleratedJustBashFs;
  readonly cwd: string;

  constructor(options: Record<string, unknown> = {}) {
    this.fs = options.fs as AcceleratedJustBashFs;
    this.cwd = typeof options.cwd === "string" ? options.cwd : "/";
  }

  async exec(command: string, options: Record<string, unknown> = {}): Promise<AcceleratedJustBashExecResult> {
    const cwd = normalize(options.cwd as string | undefined ?? this.cwd);
    const script = command.trim();

    if (script === "pwd") {
      return ok(`${cwd}\n`);
    }

    const mkdir = /^mkdir\s+-p\s+(.+)$/.exec(script);
    if (mkdir) {
      await this.fs.mkdir(resolvePath(cwd, mkdir[1]!), { recursive: true });
      return ok();
    }

    const echo = /^echo\s+(.+?)\s*>\s*(.+)$/.exec(script);
    if (echo) {
      await this.fs.writeFile(resolvePath(cwd, echo[2]!), `${unquote(echo[1]!)}\n`);
      return ok();
    }

    const cat = /^cat\s+(.+)$/.exec(script);
    if (cat) {
      return ok(await this.fs.readFile(resolvePath(cwd, cat[1]!)));
    }

    const grep = /^grep\s+-R\s+(.+?)\s+(.+)$/.exec(script);
    if (grep) {
      const needle = unquote(grep[1]!);
      const root = resolvePath(cwd, grep[2]!);
      return ok(await this.grepRecursive(root, needle));
    }

    return { stdout: "", stderr: `unsupported demo command: ${command}\n`, exitCode: 127 };
  }

  private async grepRecursive(root: string, needle: string): Promise<string> {
    const stat = await this.fs.stat(root);
    if (stat.isFile) return this.grepFile(root, needle);

    const lines: string[] = [];
    for (const entry of await this.fs.readdirWithFileTypes(root)) {
      const child = resolvePath(root, entry.name);
      if (entry.isDirectory) {
        const nested = await this.grepRecursive(child, needle);
        if (nested) lines.push(nested.replace(/\n$/g, ""));
      } else if (entry.isFile) {
        const match = await this.grepFile(child, needle);
        if (match) lines.push(match.replace(/\n$/g, ""));
      }
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  private async grepFile(filePath: string, needle: string): Promise<string> {
    const text = await this.fs.readFile(filePath);
    return text
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes(needle))
      .map(({ line, index }) => `${filePath}:${index + 1}:${line}`)
      .join("\n")
      .replace(/(.+)/, "$1\n");
  }
}

function ok(stdout = ""): AcceleratedJustBashExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function normalize(input: string): string {
  return input.startsWith("/") ? path.posix.normalize(input) : path.posix.normalize(`/${input}`);
}

function resolvePath(cwd: string, target: string): string {
  const cleaned = unquote(target);
  return normalize(cleaned.startsWith("/") ? cleaned : path.posix.resolve(cwd, cleaned));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

import { isAbsolute, relative, resolve } from "node:path";
import { redact } from "./redact.js";
import { truncate } from "./tool-calls.js";
import type { Role, ToolCallRecord } from "./types.js";

/** Arg keys that name a filesystem location in the SDK's built-in tools. */
const PATH_KEYS = [
  "path",
  "targetDirectory",
  "target_directory",
  "filePath",
  "file_path",
  "directory",
];

/** Paths a tool call touched, as reported in its args (unstable SDK shape, read defensively). */
export function extractToolPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const a = args as Record<string, unknown>;
  const out = PATH_KEYS.map((k) => a[k]).filter((v): v is string => typeof v === "string" && !!v);
  return [...new Set(out)];
}

export function isInsideWorkspace(path: string, workspace: string): boolean {
  const root = resolve(workspace);
  const rel = relative(root, isAbsolute(path) ? resolve(path) : resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface RoleCalls {
  role: Role;
  label: string;
  calls: ToolCallRecord[];
}

/**
 * Deterministic check: every path a coder tool call touched (read, edit, grep, glob, ls, or
 * any other tool that reports a path) must be inside the workspace. One message per offence.
 */
export function coderPathViolations(runs: RoleCalls[], workspace: string): string[] {
  const out: string[] = [];
  for (const run of runs.filter((r) => r.role === "coder")) {
    for (const call of run.calls) {
      for (const p of call.paths ?? []) {
        if (!isInsideWorkspace(p, workspace)) {
          out.push(`${run.label} ${call.name} touched a path outside the workspace: ${redact(p)}`);
        }
      }
    }
  }
  return out;
}

/** Redacted, trimmed list of every coder tool call, for the reviewer prompt. */
export function coderToolCallsSummary(runs: RoleCalls[], maxLines = 60): string {
  const lines = runs
    .filter((r) => r.role === "coder")
    .flatMap((r) =>
      r.calls.map((c, i) => {
        const detail = c.detail ? ` ${JSON.stringify(truncate(redact(c.detail)))}` : "";
        return `${r.label} ${i + 1}. ${c.name}${c.status === "error" ? " (error)" : ""}${detail}`;
      }),
    );
  if (lines.length === 0) return "(no coder tool calls)";
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more calls omitted`].join(
    "\n",
  );
}

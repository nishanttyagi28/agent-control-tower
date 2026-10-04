import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plan } from "./types.js";

export interface WorkspaceChange {
  /** Path relative to the workspace root, forward slashes. */
  path: string;
  /** Two-letter porcelain status, e.g. " M", "??", "R ". */
  status: string;
}

export interface WorkspaceSnapshot {
  changes: WorkspaceChange[];
  /** `git status --porcelain` style text, workspace-relative. */
  statusText: string;
  /** `git diff` for tracked files plus a /dev/null diff for each untracked file. */
  diff: string;
}

export type WorkspaceInspector = (workspace: string) => Promise<WorkspaceSnapshot>;

/**
 * Parse `git status --porcelain=v1 -z` output. Paths come back relative to the repo root,
 * so `prefix` (from `git rev-parse --show-prefix`) is stripped to make them
 * workspace-relative. For renames and copies the new path is kept.
 */
export function parsePorcelainZ(raw: string, prefix: string): WorkspaceChange[] {
  const fields = raw.split("\0");
  const out: WorkspaceChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) i++; // skip the original path
    out.push({ status, path: path.startsWith(prefix) ? path.slice(prefix.length) : path });
  }
  return out;
}

/** Normalise a planner-declared path to workspace-relative form. */
export function normalizeDeclaredPath(p: string, workspace: string): string {
  const unix = p.trim().replace(/\\/g, "/");
  const rel = isAbsolute(unix) ? relative(resolve(workspace), unix) : unix;
  return rel.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * Deterministic scope gate: every changed file must be one the plan declared. Returns one
 * human-readable violation per offending file; empty means in scope.
 */
export function scopeViolations(
  changes: WorkspaceChange[],
  plan: Plan,
  workspace: string,
): string[] {
  const declared = new Set(
    plan.tasks.flatMap((t) => t.files).map((f) => normalizeDeclaredPath(f, workspace)),
  );
  return changes
    .filter((c) => !declared.has(c.path))
    .map((c) => `changed file ${c.path} (${c.status.trim()}) is not declared in the plan`);
}

export const gitWorkspaceInspector: WorkspaceInspector = async (workspace) => {
  const prefix = (await git(workspace, ["rev-parse", "--show-prefix"])).stdout.trim();
  const status = await git(workspace, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  const changes = parsePorcelainZ(status.stdout, prefix);
  const tracked = (await git(workspace, ["diff", "--", "."])).stdout;
  const untracked: string[] = [];
  for (const c of changes.filter((c) => c.status === "??")) {
    // --no-index exits 1 when files differ; that is the normal case here.
    untracked.push(
      (await git(workspace, ["diff", "--no-index", "--", "/dev/null", c.path])).stdout,
    );
  }
  return {
    changes,
    statusText: changes.map((c) => `${c.status} ${c.path}`).join("\n"),
    diff: [tracked, ...untracked].filter(Boolean).join("\n"),
  };
};

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done, fail) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0 && !(code === 1 && args.includes("--no-index"))) {
        fail(new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
      } else done({ code: code ?? 0, stdout });
    });
  });
}

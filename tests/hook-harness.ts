import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Permission = "allow" | "deny" | "ask";
export type HookEvent = "beforeShellExecution" | "beforeReadFile";

interface HookDef {
  command: string;
  matcher?: string;
  failClosed?: boolean;
  timeout?: number;
}

/**
 * Evaluates a workspace's permission hooks the way Cursor documents it
 * (https://cursor.com/docs/agent/hooks): each matching hook gets JSON on stdin and runs
 * from the project root; exit 2 denies; exit 0 must print a valid response or the action is
 * blocked; other failures pass unless failClosed. deny > ask > allow. With no hooks a
 * headless SDK agent proceeds without approval, so the default is "allow".
 *
 * Matchers: beforeShellExecution matches the command string; beforeReadFile matches "Read".
 */
export function evaluateHooks(
  projectRoot: string,
  event: HookEvent,
  input: Record<string, unknown>,
): Permission {
  const configPath = join(projectRoot, ".cursor", "hooks.json");
  if (!existsSync(configPath)) return "allow";
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    hooks?: Partial<Record<HookEvent, HookDef[]>>;
  };
  const matchValue = event === "beforeReadFile" ? "Read" : String(input["command"] ?? "");
  const decisions: Permission[] = [];
  for (const hook of config.hooks?.[event] ?? []) {
    if (hook.matcher && hook.matcher !== "*" && !new RegExp(hook.matcher).test(matchValue))
      continue;
    decisions.push(runHook(projectRoot, hook, input));
  }
  if (decisions.includes("deny")) return "deny";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}

export function evaluateShellHooks(projectRoot: string, command: string): Permission {
  return evaluateHooks(projectRoot, "beforeShellExecution", {
    command,
    cwd: projectRoot,
    sandbox: false,
  });
}

export function evaluateReadHooks(projectRoot: string, filePath: string): Permission {
  return evaluateHooks(projectRoot, "beforeReadFile", {
    file_path: filePath,
    content: "",
    attachments: [],
  });
}

function runHook(projectRoot: string, hook: HookDef, input: Record<string, unknown>): Permission {
  const res = spawnSync(hook.command, {
    cwd: projectRoot,
    shell: true,
    input: JSON.stringify(input),
    timeout: (hook.timeout ?? 30) * 1000,
    encoding: "utf8",
  });
  if (res.status === 2) return "deny";
  if (res.status !== 0) return hook.failClosed ? "deny" : "allow";
  try {
    const out = JSON.parse(res.stdout) as { permission?: unknown };
    if (out.permission === "allow" || out.permission === "deny" || out.permission === "ask") {
      return out.permission;
    }
  } catch {
    // invalid JSON from a permission hook blocks the action
  }
  return "deny";
}

/** Runs one policy script directly and returns its parsed response. */
export function runPolicyScript(
  projectRoot: string,
  stdin: string,
  script = "shell_policy.py",
): { permission: string; agent_message?: string; user_message?: string } {
  const res = spawnSync("python3", [join(projectRoot, ".cursor/hooks", script)], {
    input: stdin,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`policy script exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout) as {
    permission: string;
    agent_message?: string;
    user_message?: string;
  };
}

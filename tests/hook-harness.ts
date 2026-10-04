import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Permission = "allow" | "deny" | "ask";

interface HookDef {
  command: string;
  matcher?: string;
  failClosed?: boolean;
  timeout?: number;
}

/**
 * Evaluates a workspace's beforeShellExecution hooks the way Cursor documents it
 * (https://cursor.com/docs/agent/hooks): each matching hook gets JSON on stdin and runs
 * from the project root; exit 2 denies; exit 0 must print a valid response or the action is
 * blocked; other failures pass unless failClosed. deny > ask > allow. With no hooks a
 * headless SDK agent runs the command without approval, so the default is "allow".
 */
export function evaluateShellHooks(projectRoot: string, command: string): Permission {
  const configPath = join(projectRoot, ".cursor", "hooks.json");
  if (!existsSync(configPath)) return "allow";
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    hooks?: { beforeShellExecution?: HookDef[] };
  };
  const decisions: Permission[] = [];
  for (const hook of config.hooks?.beforeShellExecution ?? []) {
    if (hook.matcher && hook.matcher !== "*" && !new RegExp(hook.matcher).test(command)) continue;
    decisions.push(runHook(projectRoot, hook, command));
  }
  if (decisions.includes("deny")) return "deny";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}

function runHook(projectRoot: string, hook: HookDef, command: string): Permission {
  const res = spawnSync(hook.command, {
    cwd: projectRoot,
    shell: true,
    input: JSON.stringify({ command, cwd: projectRoot, sandbox: false }),
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

/** Runs the policy script directly and returns its parsed response. */
export function runPolicyScript(
  projectRoot: string,
  stdin: string,
): { permission: string; agent_message?: string } {
  const res = spawnSync("python3", [join(projectRoot, ".cursor/hooks/shell_policy.py")], {
    input: stdin,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`policy script exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout) as { permission: string; agent_message?: string };
}

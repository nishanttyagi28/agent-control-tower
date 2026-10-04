import { redact } from "./redact.js";
import type { ToolPolicy } from "./roles.js";
import { truncate } from "./tool-calls.js";
import type { Role, ToolCallRecord } from "./types.js";

export const GATE_SHELL_TOOL = { id: "CG-GATE-001", name: "SHELL_TOOL_NOT_ALLOWED" };
export const GATE_SHELL_CALL = { id: "CG-GATE-002", name: "SHELL_CALL_RECORDED" };

const SHELL_PATTERN = /shell|terminal|bash|exec/i;
const RULE_ID_PATTERN = /\bCG-[A-Z]+-\d{3}\b/g;

export function isShellTool(name: string): boolean {
  return name === "shell" || SHELL_PATTERN.test(name);
}

export function validateRoleToolList(
  role: Role,
  tools: readonly string[],
  commandAllowlist: readonly string[] = [],
): string[] {
  if (commandAllowlist.length > 0) return [];
  const messages: string[] = [];
  for (const tool of tools) {
    if (isShellTool(tool)) {
      messages.push(
        `${GATE_SHELL_TOOL.id} ${GATE_SHELL_TOOL.name}: role ${role} is configured with tool ${tool}; no orchestrator command allowlist was provided. See AGENTS.md section 4.`,
      );
    }
  }
  return messages;
}

export function validateRoleTools(
  roleTools: Record<Role, ToolPolicy>,
  commandAllowlist: readonly string[] = [],
): string[] {
  const messages: string[] = [];
  for (const role of Object.keys(roleTools) as Role[]) {
    messages.push(...validateRoleToolList(role, roleTools[role].tools, commandAllowlist));
  }
  return messages;
}

export function extractRuleIds(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of text.matchAll(RULE_ID_PATTERN)) {
    const id = match[0];
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function ruleIdsFromResult(
  name: string,
  status: "completed" | "error",
  result: unknown,
): string[] {
  if (status !== "error" && !isShellTool(name)) return [];
  return extractRuleIds(stringifyResult(result));
}

export interface PolicyEvent {
  label: string;
  role: Role;
  tool: string;
  ruleId: string;
  detail?: string;
}

function eventDetail(detail?: string): string | undefined {
  return detail !== undefined ? truncate(redact(detail)) : undefined;
}

export function policyEvents(
  runs: Array<{ role: Role; label: string; calls: ToolCallRecord[] }>,
): PolicyEvent[] {
  const events: PolicyEvent[] = [];
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.ruleIds) {
        for (const ruleId of call.ruleIds) {
          events.push({
            label: run.label,
            role: run.role,
            tool: call.name,
            ruleId,
            detail: eventDetail(call.detail),
          });
        }
      }
      if (isShellTool(call.name)) {
        events.push({
          label: run.label,
          role: run.role,
          tool: call.name,
          ruleId: GATE_SHELL_CALL.id,
          detail: eventDetail(call.detail),
        });
      }
    }
  }
  return events;
}

import type { ToolName } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { ROLE_TOOLS } from "../src/roles.js";
import {
  extractRuleIds,
  GATE_SHELL_CALL,
  isShellTool,
  policyEvents,
  ruleIdsFromResult,
  validateRoleTools,
} from "../src/tool-gate.js";
import type { ToolCallRecord } from "../src/types.js";

const FAKE_GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";

describe("validateRoleTools", () => {
  it("rejects a role config with shell when no command allowlist", () => {
    const bad = {
      ...ROLE_TOOLS,
      coder: { tools: ["read", "edit", "shell"] as ToolName[] },
    };
    const messages = validateRoleTools(bad);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^CG-GATE-001 SHELL_TOOL_NOT_ALLOWED: role coder/);
  });

  it("accepts the real ROLE_TOOLS", () => {
    expect(validateRoleTools(ROLE_TOOLS)).toEqual([]);
  });

  it("accepts shell when commandAllowlist is non-empty", () => {
    const bad = {
      ...ROLE_TOOLS,
      coder: { tools: ["read", "edit", "shell"] as ToolName[] },
    };
    expect(validateRoleTools(bad, ["python3 -m pytest"])).toEqual([]);
  });
});

describe("isShellTool", () => {
  it("matches shell and shell-like tool names", () => {
    expect(isShellTool("shell")).toBe(true);
    expect(isShellTool("run_terminal_cmd")).toBe(true);
    expect(isShellTool("bash_exec")).toBe(true);
    expect(isShellTool("read")).toBe(false);
    expect(isShellTool("edit")).toBe(false);
  });
});

describe("extractRuleIds", () => {
  it("returns unique rule IDs in order and ignores near-misses", () => {
    const text =
      "CG-SHELL-001 DENY: blocked; CG-SHELL-001 again; cg-shell-001 lowercase; CG-SHELL-01 short; CG-READ-000 ok";
    expect(extractRuleIds(text)).toEqual(["CG-SHELL-001", "CG-READ-000"]);
  });
});

describe("ruleIdsFromResult", () => {
  it("returns [] for a completed read even when the result mentions rule IDs", () => {
    expect(ruleIdsFromResult("read", "completed", "see CG-SHELL-001 in AGENTS.md")).toEqual([]);
  });

  it("extracts rule IDs from an error read result", () => {
    expect(
      ruleIdsFromResult("read", "error", "CG-READ-001 OUTSIDE_WORKSPACE: path not allowed"),
    ).toEqual(["CG-READ-001"]);
  });

  it("extracts rule IDs from a completed shell tool with an object result", () => {
    expect(ruleIdsFromResult("shell", "completed", { message: "CG-SHELL-002 DENY" })).toEqual([
      "CG-SHELL-002",
    ]);
  });

  it("does not throw on a non-serialisable circular result", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => ruleIdsFromResult("read", "error", circular)).not.toThrow();
    expect(ruleIdsFromResult("read", "error", circular)).toEqual([]);
  });
});

describe("policyEvents", () => {
  it("emits hook rule IDs and CG-GATE-002 for shell calls with redacted detail", () => {
    const detail = `denied token ${FAKE_GH}`;
    const calls: ToolCallRecord[] = [
      {
        name: "shell",
        status: "error",
        detail,
        ruleIds: ["CG-SHELL-001"],
      },
    ];
    const events = policyEvents([{ role: "coder", label: "coder:T1", calls }]);
    expect(events.map((e) => e.ruleId)).toEqual(["CG-SHELL-001", GATE_SHELL_CALL.id]);
    expect(events.every((e) => !e.detail?.includes(FAKE_GH))).toBe(true);
    expect(events[0]?.detail).toContain("[REDACTED]");
  });
});

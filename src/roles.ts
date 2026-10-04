import type { ToolName } from "@cursor/sdk";
import type { Role } from "./types.js";

export interface ToolPolicy {
  /** Allowlist. When set, only these built-in tools are offered. */
  tools?: ToolName[];
  /** Denylist. Deny wins over allow. */
  disallowedTools?: ToolName[];
}

const READ_ONLY: ToolName[] = ["read", "grep", "glob", "ls"];

/**
 * Least privilege per role. Planner and reviewer cannot edit or run commands; the
 * orchestrator runs the tests and hands the output to the reviewer. The coder keeps
 * edit and shell (to run tests) but loses network, MCP, subagents, and delete.
 */
export const ROLE_TOOLS: Record<Role, ToolPolicy> = {
  planner: { tools: READ_ONLY },
  reviewer: { tools: READ_ONLY },
  coder: {
    disallowedTools: [
      "webSearch",
      "webFetch",
      "mcp",
      "task",
      "delete",
      "generateImage",
      "askQuestion",
    ],
  },
};

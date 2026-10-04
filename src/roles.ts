import type { ToolName } from "@cursor/sdk";
import type { Role } from "./types.js";

export interface ToolPolicy {
  /** Allowlist. Only these built-in tools are offered to the model. */
  tools: ToolName[];
}

const READ_ONLY: ToolName[] = ["read", "grep", "glob", "ls"];

/**
 * Least privilege per role, as allowlists so new SDK tools are not granted by default.
 * No role gets a shell: the orchestrator runs the tests (with the workspace venv) and
 * hands the output to the reviewer and, on a retry, to the coder.
 */
export const ROLE_TOOLS: Record<Role, ToolPolicy> = {
  planner: { tools: READ_ONLY },
  coder: { tools: [...READ_ONLY, "edit"] },
  reviewer: { tools: READ_ONLY },
};

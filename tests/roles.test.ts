import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_TOOLS } from "../src/roles.js";

const SHELL_LIKE = ["shell", "task", "mcp", "webFetch", "webSearch", "delete"];

describe("ROLE_TOOLS", () => {
  it("gives no role a shell or any way to reach one", () => {
    for (const [role, policy] of Object.entries(ROLE_TOOLS)) {
      for (const tool of SHELL_LIKE) {
        expect(policy.tools, `${role} must not get ${tool}`).not.toContain(tool);
      }
    }
  });

  it("lets only the coder edit", () => {
    expect(ROLE_TOOLS.coder.tools).toEqual(["read", "grep", "glob", "ls", "edit"]);
    expect(ROLE_TOOLS.planner.tools).not.toContain("edit");
    expect(ROLE_TOOLS.reviewer.tools).not.toContain("edit");
  });

  it("does not ask the coder to run commands it cannot run", () => {
    const prompt = readFileSync("prompts/coder.md", "utf8");
    expect(prompt).not.toMatch(/\brun `/);
    expect(prompt).toMatch(/cannot run commands/);
  });
});

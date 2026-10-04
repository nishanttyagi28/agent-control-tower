import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReadHooks, runPolicyScript } from "./hook-harness.js";

const WORKSPACES = [resolve("examples/target"), resolve("examples/target-hidden-spec")];
const HIDDEN_TESTS = resolve("examples/acceptance/target-hidden-spec/test_acceptance.py");

describe.each(WORKSPACES)("read policy hook in %s", (ws) => {
  const decide = (file_path: unknown) =>
    runPolicyScript(
      ws,
      JSON.stringify({ file_path, content: "", attachments: [] }),
      "read_policy.py",
    );

  it.each([join(ws, "AGENTS.md"), join(ws, "tests", "anything.py"), "GOAL.md", ws])(
    "allows %s",
    (p) => {
      expect(decide(p).permission).toBe("allow");
    },
  );

  it.each([
    HIDDEN_TESTS,
    resolve("AGENTS.md"),
    "/etc/passwd",
    join(ws, "..", "acceptance", "target-hidden-spec", "test_acceptance.py"),
    "../../AGENTS.md",
    `${ws}-evil/secret.txt`,
    "",
  ])("denies %s", (p) => {
    const out = decide(p);
    expect(out.permission).toBe("deny");
    expect(out.user_message).toMatch(/^Blocked by read_policy hook/);
  });

  it("denies malformed input (fail closed)", () => {
    expect(runPolicyScript(ws, "not json", "read_policy.py").permission).toBe("deny");
    expect(runPolicyScript(ws, "{}", "read_policy.py").permission).toBe("deny");
    expect(decide(42).permission).toBe("deny");
  });

  it("only emits documented output fields", () => {
    expect(Object.keys(decide(join(ws, "GOAL.md")))).toEqual(["permission"]);
    expect(Object.keys(decide("/etc/passwd")).sort()).toEqual(["permission", "user_message"]);
  });

  it("is registered fail-closed for beforeReadFile", () => {
    const config = JSON.parse(readFileSync(join(ws, ".cursor/hooks.json"), "utf8"));
    expect(config.hooks.beforeReadFile).toEqual([
      expect.objectContaining({
        command: "python3 .cursor/hooks/read_policy.py",
        failClosed: true,
      }),
    ]);
  });

  // Red if hooks.json loses beforeReadFile, is deleted, or the script starts allowing it.
  it("blocks reading the hidden acceptance tests only because of the hook", () => {
    const noHooks = mkdtempSync(join(tmpdir(), "no-hooks-"));
    expect(evaluateReadHooks(noHooks, HIDDEN_TESTS)).toBe("allow");
    expect(evaluateReadHooks(ws, HIDDEN_TESTS)).toBe("deny");
    expect(evaluateReadHooks(ws, join(ws, "AGENTS.md"))).toBe("allow");
  });
});

describe("read policy and symlinks", () => {
  it("denies a link inside the workspace that points outside it", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(ws, ".cursor", "hooks"), { recursive: true });
    copyFileSync(
      resolve("examples/target/.cursor/hooks/read_policy.py"),
      join(ws, ".cursor/hooks/read_policy.py"),
    );
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.txt"), "s");
    symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
    writeFileSync(join(ws, "ok.txt"), "ok");

    const decide = (p: string) =>
      runPolicyScript(ws, JSON.stringify({ file_path: p }), "read_policy.py").permission;
    expect(decide(join(ws, "ok.txt"))).toBe("allow");
    expect(decide(join(ws, "link.txt"))).toBe("deny");
  });
});

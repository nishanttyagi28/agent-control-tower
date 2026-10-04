import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan } from "../src/types.js";
import {
  gitWorkspaceInspector,
  normalizeDeclaredPath,
  parsePorcelainZ,
  scopeViolations,
} from "../src/workspace.js";

const plan = (files: string[]): Plan => ({
  summary: "",
  tasks: [{ id: "T1", title: "t", instructions: "i", files }],
});

describe("parsePorcelainZ", () => {
  it("strips the repo prefix and keeps the new path for renames", () => {
    const raw = [
      " M examples/t/a.py",
      "?? examples/t/tests/test_a.py",
      "R  examples/t/new.py",
      "examples/t/old.py",
      "",
    ].join("\0");
    expect(parsePorcelainZ(raw, "examples/t/")).toEqual([
      { status: " M", path: "a.py" },
      { status: "??", path: "tests/test_a.py" },
      { status: "R ", path: "new.py" },
    ]);
  });
});

describe("normalizeDeclaredPath", () => {
  it("accepts ./relative, absolute-inside-workspace and backslash forms", () => {
    expect(normalizeDeclaredPath("./tests/test_a.py", "/w/t")).toBe("tests/test_a.py");
    expect(normalizeDeclaredPath("/w/t/a.py", "/w/t")).toBe("a.py");
    expect(normalizeDeclaredPath("tests\\test_a.py", "/w/t")).toBe("tests/test_a.py");
  });
});

describe("scopeViolations", () => {
  it("is empty when every change was declared", () => {
    const changes = [
      { status: "??", path: "a.py" },
      { status: " M", path: "tests/test_a.py" },
    ];
    expect(scopeViolations(changes, plan(["./a.py", "/w/t/tests/test_a.py"]), "/w/t")).toEqual([]);
  });

  it("reports each undeclared change, including edits to governance files", () => {
    const changes = [
      { status: "??", path: "a.py" },
      { status: " M", path: "AGENTS.md" },
      { status: "??", path: "tests/conftest.py" },
    ];
    expect(scopeViolations(changes, plan(["a.py"]), "/w/t")).toEqual([
      "changed file AGENTS.md (M) is not declared in the plan",
      "changed file tests/conftest.py (??) is not declared in the plan",
    ]);
  });
});

describe("gitWorkspaceInspector (real git, temp repo)", () => {
  it("reports workspace-relative changes and diffs, ignoring files outside the workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ws-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
    git("init", "-q");
    const ws = join(repo, "examples", "t");
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "a.py"), "x = 1\n");
    writeFileSync(join(repo, "outside.txt"), "o\n");
    git("add", ".");
    git("commit", "-qm", "init");

    writeFileSync(join(ws, "a.py"), "x = 2\n");
    writeFileSync(join(ws, "tests", "test_a.py"), "def test_a():\n    pass\n");
    writeFileSync(join(repo, "outside.txt"), "changed\n");

    const snap = await gitWorkspaceInspector(ws);
    expect(snap.changes).toEqual([
      { status: " M", path: "a.py" },
      { status: "??", path: "tests/test_a.py" },
    ]);
    expect(snap.diff).toContain("-x = 1");
    expect(snap.diff).toContain("+x = 2");
    expect(snap.diff).toContain("+def test_a():");
    expect(snap.diff).not.toContain("outside.txt");
  });
});

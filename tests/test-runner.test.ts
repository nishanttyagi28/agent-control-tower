import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureVenv, pytestCommand, venvPythonPath, type Exec } from "../src/test-runner.js";

function recordingExec(results: Record<string, number>) {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(results).find((k) => line.includes(k));
    return { code: key ? (results[key] ?? 0) : 0, output: "" };
  };
  return { calls, exec };
}

describe("venvPythonPath", () => {
  it("resolves a relative workspace to an absolute interpreter path", () => {
    const p = venvPythonPath("examples/target", "linux");
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith("/examples/target/.venv/bin/python")).toBe(true);
  });

  it("uses Scripts/python.exe on Windows", () => {
    expect(venvPythonPath("C:\\w\\target", "win32")).toBe(
      "C:\\w\\target\\.venv\\Scripts\\python.exe",
    );
  });
});

describe("pytestCommand", () => {
  it("never relies on PATH: the interpreter is the absolute path given", () => {
    expect(pytestCommand("/w/t/.venv/bin/python")).toBe("/w/t/.venv/bin/python -m pytest -q");
  });

  it("quotes paths with spaces so the shell sees one token", () => {
    expect(pytestCommand("/my repo/.venv/bin/python", ["-q", "tests"])).toBe(
      "'/my repo/.venv/bin/python' -m pytest -q tests",
    );
  });
});

describe("ensureVenv", () => {
  it("creates the venv and installs pytest when neither exists", async () => {
    const { calls, exec } = recordingExec({ "import pytest": 1 });
    const py = await ensureVenv("/w/t", { exec, exists: () => false, basePython: "python3" });

    expect(py).toBe("/w/t/.venv/bin/python");
    expect(calls).toEqual([
      "python3 -m venv /w/t/.venv",
      "/w/t/.venv/bin/python -c import pytest",
      "/w/t/.venv/bin/python -m pip install --quiet pytest==9.1.1",
    ]);
  });

  it("reuses an existing venv that already has pytest", async () => {
    const { calls, exec } = recordingExec({});
    await ensureVenv("/w/t", { exec, exists: () => true });
    expect(calls).toEqual(["/w/t/.venv/bin/python -c import pytest"]);
  });

  it("fails loudly when the venv cannot be created", async () => {
    const { exec } = recordingExec({ "-m venv": 1 });
    await expect(ensureVenv("/w/t", { exec, exists: () => false })).rejects.toThrow(/-m venv/);
  });
});

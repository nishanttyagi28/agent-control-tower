import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { BASE_PYTHON, LOG_TEXT_LIMIT, PYTEST_SPEC, TEST_TIMEOUT_MS } from "./config.js";
import { tail } from "./text.js";
import type { TestRunner } from "./types.js";

/**
 * Runs the target's test command through the shell. The orchestrator runs tests itself
 * so the PASS/FAIL gate does not depend on the reviewer agent having shell access.
 */
export function shellTestRunner(command: string, timeoutMs = TEST_TIMEOUT_MS): TestRunner {
  return (cwd) =>
    new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, timeout: timeoutMs });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      child.on("error", (err) => resolve({ exitCode: 127, output: String(err) }));
      child.on("close", (code, signal) =>
        resolve({
          exitCode: code ?? 124,
          output: tail(signal ? `${output}\n[killed by ${signal}]` : output, LOG_TEXT_LIMIT),
        }),
      );
    });
}

export interface ExecResult {
  code: number;
  output: string;
}

export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

/** Absolute path of the workspace venv interpreter. Never relies on PATH lookup. */
export function venvPythonPath(workspace: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
    ? win32.resolve(workspace, ".venv", "Scripts", "python.exe")
    : resolve(workspace, ".venv", "bin", "python");
}

/** POSIX single-quote a token only when it needs it. */
export function shellQuote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

export function pytestCommand(python: string, args: string[] = ["-q"]): string {
  return [python, "-m", "pytest", ...args].map(shellQuote).join(" ");
}

export interface EnsureVenvOptions {
  basePython?: string;
  pytestSpec?: string;
  exec?: Exec;
  exists?: (path: string) => boolean;
}

/**
 * Create `<workspace>/.venv` if missing and make sure pytest is importable in it. The
 * orchestrator owns the environment; agents never install anything.
 */
export async function ensureVenv(workspace: string, opts: EnsureVenvOptions = {}): Promise<string> {
  const exec = opts.exec ?? spawnExec;
  const exists = opts.exists ?? existsSync;
  const python = venvPythonPath(workspace);

  if (!exists(python)) {
    await mustSucceed(exec, opts.basePython ?? BASE_PYTHON, [
      "-m",
      "venv",
      join(workspace, ".venv"),
    ]);
  }
  const probe = await exec(python, ["-c", "import pytest"]);
  if (probe.code !== 0) {
    await mustSucceed(exec, python, [
      "-m",
      "pip",
      "install",
      "--quiet",
      opts.pytestSpec ?? PYTEST_SPEC,
    ]);
  }
  return python;
}

async function mustSucceed(exec: Exec, file: string, args: string[]): Promise<void> {
  const res = await exec(file, args);
  if (res.code !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} failed (exit ${res.code}): ${res.output.slice(-500)}`,
    );
  }
}

const spawnExec: Exec = (file, args) =>
  new Promise((done) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => done({ code: 127, output: String(err) }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });

/** Hidden acceptance tests sit outside the workspace, so pin rootdir and config explicitly. */
export function pytestArgs(workspace: string, acceptance?: string): string[] {
  if (!acceptance) return ["-q"];
  return [
    "-q",
    "--tb=short",
    "--rootdir",
    workspace,
    "-c",
    join(workspace, "pyproject.toml"),
    "tests",
    resolve(acceptance),
  ];
}

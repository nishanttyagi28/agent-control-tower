import { spawn } from "node:child_process";
import { LOG_TEXT_LIMIT, TEST_TIMEOUT_MS } from "./config.js";
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

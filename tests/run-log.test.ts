import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../src/config.js";
import type { PipelineReport } from "../src/pipeline.js";
import { redact } from "../src/redact.js";
import { FileRunSink, formatToolCalls } from "../src/run-log.js";
import { ZERO_USAGE } from "../src/usage.js";
import { describeToolArgs } from "../src/tool-calls.js";
import type { ToolCallRecord } from "../src/types.js";

// Built at runtime so no token-shaped literal sits in the repo for scanners to flag.
const FAKE_GH = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_CURSOR = "crsr_" + "0123456789abcdef0123456789abcdef";
const ENV_SECRET = "s3cr3t-value-from-env-" + "x".repeat(12);

describe("redact", () => {
  it("replaces exact values of secret env vars regardless of shape", () => {
    const env = { CURSOR_API_KEY: ENV_SECRET };
    expect(redact(`key is ${ENV_SECRET}!`, env)).toBe("key is [REDACTED]!");
  });

  it("catches common token shapes and key=value assignments", () => {
    const out = redact(
      `curl -H "Authorization: Bearer abcdefgh12345678" ${FAKE_GH} ${FAKE_CURSOR} api_key=hunter22 TOKEN: zzzz9999`,
      {},
    );
    expect(out).not.toMatch(/abcdefgh12345678|ghp_A1b2|crsr_0123|hunter22|zzzz9999/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("leaves ordinary commands alone", () => {
    const cmd = "/w/t/.venv/bin/python -m pytest -q tests/test_x.py::test_tokenize";
    expect(redact(cmd, {})).toBe(cmd);
  });
});

describe("tool call logging", () => {
  it("reads command, path, or falls back to JSON", () => {
    expect(describeToolArgs({ command: "ls", timeout: 1 })).toBe("ls");
    expect(describeToolArgs({ path: "/w/a.py" })).toBe("/w/a.py");
    expect(describeToolArgs({ q: 1 })).toBe('{"q":1}');
  });

  it("logs the grep/glob pattern, not just the folder", () => {
    expect(describeToolArgs({ pattern: "def parse", path: "/w/t", glob: "*.py", offset: 0 })).toBe(
      '"def parse" in /w/t (glob *.py)',
    );
    expect(describeToolArgs({ globPattern: "**/*acceptance*", targetDirectory: "/w/t" })).toBe(
      '"**/*acceptance*" in /w/t',
    );
    expect(describeToolArgs({ pattern: "TODO" })).toBe('"TODO"');
    expect(describeToolArgs(undefined)).toBeUndefined();
  });

  it("truncates long args to 200 chars", () => {
    const line = formatToolCalls([{ name: "shell", status: "completed", detail: "x".repeat(500) }]);
    expect(line).toContain("x".repeat(200) + "... [+300 chars]");
    expect(line).not.toContain("x".repeat(201));
  });

  it("appends rule IDs to a tool call line and writes policyEvents to summary.json", async () => {
    const line = formatToolCalls([
      { name: "shell", status: "error", detail: "pytest", ruleIds: ["CG-SHELL-001"] },
    ]);
    expect(line).toContain(" [CG-SHELL-001]");

    const dir = mkdtempSync(join(tmpdir(), "runlog-policy-"));
    const sink = new FileRunSink(dir);
    const report: PipelineReport = {
      outcome: "PASS",
      message: "ok",
      reviews: [],
      runs: [],
      checkpointRefs: [],
      usage: ZERO_USAGE,
      estCostUsd: 0,
      unpricedModels: [],
      policyEvents: [
        {
          label: "coder:T1",
          role: "coder",
          tool: "shell",
          ruleId: "CG-SHELL-001",
          detail: "pytest",
        },
      ],
    };
    await sink.summary(report);
    const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    expect(summary.policyEvents).toEqual(report.policyEvents);
  });

  it("redacts secrets in logged commands before truncating them", async () => {
    const previous = process.env["GH_TOKEN"];
    process.env["GH_TOKEN"] = ENV_SECRET;
    try {
      const calls: ToolCallRecord[] = [
        {
          name: "shell",
          status: "completed",
          detail: `git push https://x:${ENV_SECRET}@github.com/o/r`,
        },
        // The secret straddles the 200-char cut; it must still not leak in part.
        { name: "shell", status: "error", detail: "y".repeat(190) + ` ${FAKE_GH}` },
        { name: "shell", status: "completed", detail: `CURSOR_API_KEY=${FAKE_CURSOR} node x.js` },
      ];
      const dir = mkdtempSync(join(tmpdir(), "runlog-"));
      const sink = new FileRunSink(dir);
      await sink.init({});
      await sink.record(
        {
          index: 1,
          role: "coder",
          label: "coder:T1",
          model: "composer-2.5",
          result: { status: "finished", text: "ok", toolCalls: calls },
        },
        {
          role: "coder",
          label: "coder:T1",
          prompt: `use ${ENV_SECRET}`,
          cwd: "/w",
          model: DEFAULT_MODEL,
        },
      );
      const file = readdirSync(dir).find((f) => f.startsWith("01-"));
      const log = readFileSync(join(dir, file ?? ""), "utf8");

      expect(log).not.toContain(ENV_SECRET);
      expect(log).not.toContain(ENV_SECRET.slice(0, 12));
      expect(log).not.toMatch(/ghp_A1b2|crsr_0123/);
      expect(log).toContain("## Tool calls");
      expect(log).toContain("- model: composer-2.5 fast=false");
      expect(log).toMatch(/1\. shell "git push https:\/\/x:\[REDACTED\]@github.com\/o\/r"/);
      expect(log).toMatch(/2\. shell \(error\)/);
    } finally {
      if (previous === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = previous;
    }
  });
});

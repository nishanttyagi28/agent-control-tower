import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG_TEXT_LIMIT } from "./config.js";
import type { PipelineReport, RunRecord, RunSink } from "./pipeline.js";
import { redact } from "./redact.js";
import { tail } from "./text.js";
import { toolNames, truncate } from "./tool-calls.js";
import type { RoleRunRequest, ToolCallRecord } from "./types.js";

/**
 * Writes one markdown file per agent run plus a summary. Logs hold the prompt, each tool
 * call (name + truncated args), and the final text; per-token stream events are not kept.
 * Everything written passes through redact() first.
 */
export class FileRunSink implements RunSink {
  constructor(readonly dir: string) {}

  async init(meta: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  }

  async record(entry: RunRecord, request: RoleRunRequest): Promise<void> {
    const r = entry.result;
    const name = `${String(entry.index).padStart(2, "0")}-${entry.label.replace(/[^\w-]+/g, "_")}.md`;
    const body = [
      `# Run ${entry.index}: ${entry.label}`,
      "",
      `- status: ${r.status}`,
      `- duration_ms: ${r.durationMs ?? "n/a"}`,
      `- usage: ${r.usage ? JSON.stringify(r.usage) : "n/a"}`,
      `- tool_calls (${r.toolCalls.length}): ${summarizeTools(toolNames(r.toolCalls))}`,
      r.error ? `- error: ${redact(r.error)}` : "",
      "",
      "## Tool calls",
      "",
      formatToolCalls(r.toolCalls),
      "",
      "## Prompt",
      "",
      fence(tail(redact(request.prompt), LOG_TEXT_LIMIT)),
      "",
      "## Final response",
      "",
      fence(tail(redact(r.text) || "(empty)", LOG_TEXT_LIMIT)),
      "",
    ];
    await writeFile(join(this.dir, name), body.join("\n"));
  }

  async summary(report: PipelineReport): Promise<void> {
    const json = {
      outcome: report.outcome,
      message: redact(report.message),
      runs: report.runs.map((r) => ({
        index: r.index,
        label: r.label,
        status: r.result.status,
        durationMs: r.result.durationMs,
        usage: r.result.usage,
        toolCalls: r.result.toolCalls.length,
      })),
      reviews: report.reviews,
      plan: report.plan,
      tests: report.lastTests ? { exitCode: report.lastTests.exitCode } : undefined,
      usage: report.usage,
      estCostUsd: Number(report.estCostUsd.toFixed(4)),
    };
    await writeFile(join(this.dir, "summary.json"), JSON.stringify(json, null, 2) + "\n");
    if (report.lastTests) {
      await writeFile(join(this.dir, "tests.txt"), redact(report.lastTests.output));
    }
  }
}

/** "read x3, edit x2" in first-use order. */
export function summarizeTools(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} x${c}` : n)).join(", ") || "none";
}

/** One line per call; args are redacted before truncation so a cut cannot expose a secret. */
export function formatToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "(none)";
  return calls
    .map((c, i) => {
      const detail = c.detail ? ` ${JSON.stringify(truncate(redact(c.detail)))}` : "";
      return `${i + 1}. ${c.name}${c.status === "error" ? " (error)" : ""}${detail}`;
    })
    .join("\n");
}

function fence(text: string): string {
  return "````text\n" + text + "\n````";
}

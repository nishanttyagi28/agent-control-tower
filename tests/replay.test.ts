import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_MODELS } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import {
  loadRecording,
  parseRunLog,
  replayInspector,
  replayTestRunner,
  ReplayRunner,
} from "../src/replay.js";
import { PROMPTS } from "./fakes.js";

const RUN2 = "runs/2026-10-04T02-09-42Z";

async function replay(checkPaths: boolean) {
  const rec = await loadRecording(RUN2);
  const runner = new ReplayRunner(rec, { checkPaths });
  const report = await runPipeline({
    goal: rec.goal,
    workspace: rec.workspace,
    testCommand: rec.testCommand,
    runner,
    runTests: replayTestRunner(rec),
    inspectWorkspace: replayInspector(rec, runner),
    prompts: PROMPTS,
    budget: rec.budget,
  });
  return { rec, runner, report };
}

describe("replay of run 2", () => {
  it("parses a run log header, usage, tool calls and final text", () => {
    const run = parseRunLog(
      [
        "# Run 2: coder:T1",
        "",
        "- status: finished",
        "- duration_ms: 1500",
        '- usage: {"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":0,"totalTokens":6}',
        "",
        "## Tool calls",
        "",
        '1. read "/ws/a.py"',
        "2. edit (error)",
        "",
        "## Final response",
        "",
        "````text",
        "done",
        "````",
      ].join("\n"),
    );
    expect(run).toMatchObject({ index: 2, label: "coder:T1", durationMs: 1500, text: "done" });
    expect(run.usage?.totalTokens).toBe(6);
    expect(run.toolCalls).toEqual([
      { name: "read", status: "completed", detail: "/ws/a.py" },
      { name: "edit", status: "error" },
    ]);
  });

  it("reproduces the recorded FAIL, retry, PASS through the real pipeline and gate", async () => {
    const { rec, runner, report } = await replay(false);
    expect(report.outcome).toBe("PASS");
    expect(report.runs.map((r) => r.label)).toEqual(rec.runs.map((r) => r.label));
    expect(report.reviews.map((r) => r.verdict)).toEqual(["FAIL", "PASS"]);
    expect(report.reviews[0]?.reasons.at(-1)).toBe("test command exited with code 1");
    expect(report.usage.totalTokens).toBe(727_269);
    expect(runner.unreplayed).toEqual([]);
    expect(report.runs.every((r) => r.model === DEFAULT_ROLE_MODELS.coder.id)).toBe(true);
  });

  it("with logged paths, the current coder path check stops it before reviewer#2", async () => {
    const { runner, report } = await replay(true);
    expect(report.outcome).toBe("FAIL");
    expect(report.message).toContain("coder:fix1 grep touched a path outside the workspace");
    expect(runner.unreplayed.map((r) => r.label)).toEqual(["reviewer#2"]);
  });
});

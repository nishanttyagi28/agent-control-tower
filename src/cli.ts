import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BUDGET, DEFAULT_MODEL, type Budget } from "./config.js";
import { CursorAgentRunner } from "./cursor-runner.js";
import { runPipeline, type PipelineReport } from "./pipeline.js";
import { loadPrompts } from "./prompts.js";
import { ensureVenv, pytestCommand, shellTestRunner } from "./test-runner.js";
import { FileRunSink, summarizeTools } from "./run-log.js";
import { toolNames } from "./tool-calls.js";
import { gitWorkspaceInspector } from "./workspace.js";

const ROOT = resolve(import.meta.dirname, "..");

const USAGE = `usage: npm run pipeline -- [--workspace DIR] [--goal-file FILE] [--max-runs N]
                             [--timeout-min N] [--model ID]

Env: CURSOR_API_KEY (required), TARGET_TEST_CMD (default: <workspace>/.venv/bin/python -m pytest -q,
     venv created and pytest installed by the orchestrator)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string", default: "examples/target" },
      "goal-file": { type: "string" },
      "max-runs": { type: "string" },
      "timeout-min": { type: "string" },
      model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const apiKey = process.env["CURSOR_API_KEY"];
  if (!apiKey) {
    console.error("CURSOR_API_KEY is not set\n" + USAGE);
    return 2;
  }

  const workspace = resolve(values.workspace);
  const goal = (await readFile(values["goal-file"] ?? join(workspace, "GOAL.md"), "utf8")).trim();
  const budget: Budget = {
    ...DEFAULT_BUDGET,
    ...(values["max-runs"] ? { maxRuns: Number(values["max-runs"]) } : {}),
    ...(values["timeout-min"] ? { runTimeoutMs: Number(values["timeout-min"]) * 60_000 } : {}),
  };
  const model = values.model ? { ...DEFAULT_MODEL, id: values.model } : DEFAULT_MODEL;
  const testCommand = process.env["TARGET_TEST_CMD"] ?? pytestCommand(await ensureVenv(workspace));
  process.env["TARGET_TEST_CMD"] = testCommand;

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  const sink = new FileRunSink(join(ROOT, "runs", stamp));
  await sink.init({
    startedAt: new Date().toISOString(),
    goal,
    workspace,
    model,
    budget,
    testCommand,
  });
  console.log(`pipeline: model=${model.id} maxRuns=${budget.maxRuns} logs=${sink.dir}`);

  const report = await runPipeline({
    goal,
    workspace,
    testCommand,
    budget,
    prompts: await loadPrompts(join(ROOT, "prompts")),
    runner: new CursorAgentRunner({
      apiKey,
      model,
      runTimeoutMs: budget.runTimeoutMs,
      stateDir: join(ROOT, "state"),
    }),
    runTests: shellTestRunner(testCommand),
    inspectWorkspace: gitWorkspaceInspector,
    sink: {
      async record(entry, request) {
        const r = entry.result;
        console.log(
          `  [${entry.index}] ${entry.label.padEnd(12)} ${r.status.padEnd(9)} ` +
            `${String(r.usage?.totalTokens ?? "-").padStart(7)} tok  ` +
            `${((r.durationMs ?? 0) / 1000).toFixed(1)}s  ${summarizeTools(toolNames(r.toolCalls))}`,
        );
        await sink.record(entry, request);
      },
    },
  });
  await sink.summary(report);
  printReport(report);
  return report.outcome === "PASS" ? 0 : report.outcome === "FAIL" ? 1 : 2;
}

function printReport(r: PipelineReport): void {
  const u = r.usage;
  console.log(`\noutcome: ${r.outcome} (${r.message})`);
  console.log(`runs: ${r.runs.length}`);
  console.log(
    `tokens: total=${u.totalTokens} input=${u.inputTokens} output=${u.outputTokens} ` +
      `cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`,
  );
  console.log(`est. cost at list price: $${r.estCostUsd.toFixed(4)}`);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BUDGET, resolveRoleModels, type Budget } from "./config.js";
import { CursorAgentRunner } from "./cursor-runner.js";
import { runPipeline, type PipelineReport } from "./pipeline.js";
import { loadPrompts } from "./prompts.js";
import { ensureVenv, pytestArgs, pytestCommand, shellTestRunner } from "./test-runner.js";
import { FileRunSink, summarizeTools } from "./run-log.js";
import { toolNames } from "./tool-calls.js";
import { gitWorkspaceInspector } from "./workspace.js";
import { gitCheckpointer } from "./checkpoint.js";
import { promptApprover } from "./approve.js";
import { parseRetryPolicy, resolveRetryPolicy } from "./policy.js";

const ROOT = resolve(import.meta.dirname, "..");

const USAGE = `usage: npm run pipeline -- [--workspace DIR] [--goal-file FILE] [--acceptance DIR]
                             [--max-runs N] [--max-retries N] [--timeout-min N] [--model SPEC]
                             [--planner-model SPEC] [--coder-model SPEC] [--reviewer-model SPEC]

--max-retries N   coder retries after a FAIL (default 1). maxRuns must cover the worst case
                  1 + maxTasks + 1 + 2*maxRetries, e.g. --max-retries 2 needs --max-runs 8.

--acceptance DIR  extra pytest tests kept outside the workspace. Planner and coder are not
                  told where they are; failures reach the coder through the test output.

--interactive          ask y/n on stdin before the run that crosses the budget threshold and
                       before each retry after a FAIL (anything but y, incl. EOF, stops)
--confirm-threshold F  fraction of --max-runs that triggers the prompt (default 0.8)
--duplicate-overlap F  abort a retry loop when >= F of a FAIL's reasons repeat (default 0.8)
--no-duplicate-check   disable the duplicate-failure abort

Retry defaults (maxRetries, duplicate check, confirm threshold) come from the
"json retry-policy" block in AGENTS.md; the flags above override it.

SPEC is "id" or "id:param=value,...". Default for every role: composer-2.5 (fast=false).
Precedence per role: --<role>-model > <ROLE>_MODEL env > --model > default.

Env: CURSOR_API_KEY (required); PLANNER_MODEL, CODER_MODEL, REVIEWER_MODEL;
     TARGET_TEST_CMD (default: <workspace>/.venv/bin/python -m pytest -q, venv created and
     pytest installed by the orchestrator)`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      workspace: { type: "string", default: "examples/target" },
      "goal-file": { type: "string" },
      acceptance: { type: "string" },
      "max-runs": { type: "string" },
      "max-retries": { type: "string" },
      "timeout-min": { type: "string" },
      model: { type: "string" },
      "planner-model": { type: "string" },
      "coder-model": { type: "string" },
      "reviewer-model": { type: "string" },
      interactive: { type: "boolean", default: false },
      "confirm-threshold": { type: "string" },
      "duplicate-overlap": { type: "string" },
      "no-duplicate-check": { type: "boolean", default: false },
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
  // Retry policy: built-in defaults < AGENTS.md "json retry-policy" block < CLI flags.
  const policy = resolveRetryPolicy(
    parseRetryPolicy(await readFile(join(ROOT, "AGENTS.md"), "utf8")),
    {
      maxRetries: values["max-retries"],
      confirmThreshold: values["confirm-threshold"],
      duplicateOverlap: values["duplicate-overlap"],
      noDuplicateCheck: values["no-duplicate-check"],
    },
  );
  const budget: Budget = {
    ...DEFAULT_BUDGET,
    ...(values["max-runs"] ? { maxRuns: Number(values["max-runs"]) } : {}),
    maxRetries: policy.maxRetries,
    ...(values["timeout-min"] ? { runTimeoutMs: Number(values["timeout-min"]) * 60_000 } : {}),
  };
  const models = resolveRoleModels({
    all: values.model,
    flags: {
      planner: values["planner-model"],
      coder: values["coder-model"],
      reviewer: values["reviewer-model"],
    },
    env: process.env,
  });
  const testCommand =
    process.env["TARGET_TEST_CMD"] ??
    pytestCommand(await ensureVenv(workspace), pytestArgs(workspace, values.acceptance));
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
    models,
    budget,
    policy,
    testCommand,
  });
  console.log(
    `pipeline: models planner=${models.planner.id} coder=${models.coder.id} ` +
      `reviewer=${models.reviewer.id} maxRuns=${budget.maxRuns} logs=${sink.dir}`,
  );

  const report = await runPipeline({
    goal,
    workspace,
    testCommand,
    budget,
    models,
    prompts: await loadPrompts(join(ROOT, "prompts")),
    runner: new CursorAgentRunner({
      apiKey,
      runTimeoutMs: budget.runTimeoutMs,
      stateDir: join(ROOT, "state"),
    }),
    runTests: shellTestRunner(testCommand),
    inspectWorkspace: gitWorkspaceInspector,
    // Local refs only (refs/codegovernor/...); branches, index and HEAD are never touched.
    checkpoints: gitCheckpointer(workspace, `refs/codegovernor/${stamp}`),
    ...(values.interactive ? { approve: promptApprover(process.stdin, process.stdout) } : {}),
    confirmThreshold: policy.confirmThreshold,
    duplicateFailure: policy.duplicateFailure,
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
  if (r.unpricedModels.length) {
    console.log(`  (not included, no verified list price: ${r.unpricedModels.join(", ")})`);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);

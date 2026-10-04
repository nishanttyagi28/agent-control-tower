import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { worstCaseRuns } from "./config.js";
import { parsePlan, parseReview } from "./parse.js";
import { gateReview, runPipeline, type RunRecord } from "./pipeline.js";
import { loadPrompts } from "./prompts.js";
import { redact } from "./redact.js";
import {
  loadRecording,
  replayInspector,
  replayTestRunner,
  ReplayRunner,
  type Recording,
} from "./replay.js";
import { summarizeTools } from "./run-log.js";
import { coderPathViolations } from "./tool-scope.js";
import { toolNames, truncate } from "./tool-calls.js";
import type { Plan, TestRunResult } from "./types.js";
import { scopeViolations, type WorkspaceSnapshot } from "./workspace.js";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_RUN = "runs/2026-10-04T02-09-42Z";

const USAGE = `Usage: npm run demo:replay -- [options]

Replays a committed run through the real pipeline, budget check and gate, with a fake agent
that answers from the run logs. No model calls, no API key, no workspace changes.

--run DIR        recorded run directory (default ${DEFAULT_RUN})
--speed N        replay agent time N times faster (default 8; 0 = no waiting)
--pause-ms N     extra pause after each step, for reading (default 700)
--check-paths    give tool calls the paths from their logged args, so the current coder
                 path check sees them (the recorded orchestrator did not capture paths)
--max-calls N    tool calls shown per run (default 4)`;

const color = !process.env["NO_COLOR"];
const sgr = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: sgr("1"),
  dim: sgr("2"),
  red: sgr("1;31"),
  green: sgr("1;32"),
  yellow: sgr("33"),
  cyan: sgr("36"),
  magenta: sgr("1;35"),
  inverse: sgr("1;7"),
};
const out = (s = "") => process.stdout.write(s + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = (x: number) => x.toLocaleString("en-US");
const secs = (ms?: number) => `${((ms ?? 0) / 1000).toFixed(1)}s`;

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      run: { type: "string", default: DEFAULT_RUN },
      speed: { type: "string", default: "8" },
      "pause-ms": { type: "string", default: "700" },
      "check-paths": { type: "boolean", default: false },
      "max-calls": { type: "string", default: "4" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const rec = await loadRecording(resolve(ROOT, values.run));
  const pause = Number(values["pause-ms"]);
  const maxCalls = Number(values["max-calls"]);
  const checkPaths = values["check-paths"];
  const repoRoot = rec.workspace.includes("/examples/")
    ? rec.workspace.slice(0, rec.workspace.indexOf("/examples/"))
    : rec.workspace;
  const short = (s: string) =>
    s
      .split(repoRoot + "/")
      .join("")
      .split(repoRoot)
      .join("<repo root>");

  out(c.inverse(" CodeGovernor ") + " " + c.magenta("Replay of a recorded run (no model calls)"));
  out(c.dim(`recording  ${relative(ROOT, rec.dir)}`));
  out(
    c.dim(
      `workspace  ${short(rec.workspace)}   model ${rec.model.id}` +
        rec.model.params.map((p) => ` ${p.id}=${p.value}`).join(""),
    ),
  );
  out(c.dim(`goal       ${truncate(rec.goal, 80)}`));
  if (checkPaths)
    out(c.yellow("mode       --check-paths: logged paths are fed to the current coder path check"));
  out();
  const b = rec.budget;
  const worst = worstCaseRuns(b);
  out(c.bold("Budget pre-flight"));
  out(
    `  worst case = 1 planner + ${b.maxTasks} coder + 1 reviewer + 2 x ${b.maxRetries} retry = ${worst} runs`,
  );
  out(
    `  maxRuns = ${b.maxRuns}   ${worst <= b.maxRuns ? c.green("OK, pipeline may start") : c.red("REJECTED")}`,
  );
  await sleep(pause * 2);

  let plan: Plan | undefined;
  let lastTests: TestRunResult | undefined;
  let lastSnap: WorkspaceSnapshot | undefined;
  const done: RunRecord[] = [];

  const runner = new ReplayRunner(rec, {
    checkPaths,
    speed: Number(values.speed),
    onStart(req) {
      const retry = req.label.startsWith("coder:fix");
      out();
      if (retry)
        out(
          c.yellow(
            `Retry ${req.label.slice(9)}/${b.maxRetries}: coder gets only the unresolved reasons and the test output`,
          ),
        );
      out(
        `${c.cyan(`[${done.length + 1}/${b.maxRuns}]`)} ${c.bold(req.label.padEnd(11))} ${c.dim(`${req.role} started, model ${req.model.id}`)}`,
      );
    },
  });
  const testRunner = replayTestRunner(rec);
  const inspector = replayInspector(rec, runner);

  const report = await runPipeline({
    goal: rec.goal,
    workspace: rec.workspace,
    testCommand: rec.testCommand,
    runner,
    budget: rec.budget,
    models: { planner: rec.model, coder: rec.model, reviewer: rec.model },
    prompts: await loadPrompts(resolve(ROOT, "prompts")),
    async runTests(cwd) {
      const t = await testRunner(cwd);
      lastTests = t;
      const v = coderPathViolations(
        done.map((r) => ({ role: r.role, label: r.label, calls: r.result.toolCalls })),
        rec.workspace,
      );
      out();
      out(c.bold("Deterministic gate (TypeScript, not a model)"));
      out(
        `  coder paths   ${checkPaths ? (v.length ? c.red(`${v.length} outside the workspace`) : c.green("all inside the workspace")) : c.dim("not captured by the recorded run")}`,
      );
      out(
        `  tests         ${t.exitCode === 0 ? c.green("exit 0") : c.red(`exit ${t.exitCode}`)} ${c.dim("(replayed)")}`,
      );
      return t;
    },
    async inspectWorkspace(ws) {
      const s = await inspector(ws);
      lastSnap = s;
      if (s.changes.length > 0 && plan) {
        const v = scopeViolations(s.changes, plan, ws);
        out(
          `  plan scope    ${v.length ? c.red(v.join("; ")) : c.green(`${s.changes.length} changed files, all declared in the plan`)}`,
        );
      }
      return s;
    },
    sink: {
      async record(entry) {
        done.push(entry);
        const r = entry.result;
        const calls = r.toolCalls;
        out(`  ${c.dim("tool calls")} ${calls.length}: ${summarizeTools(toolNames(calls))}`);
        for (const [i, call] of calls.slice(0, maxCalls).entries()) {
          const detail = call.detail ? ` ${truncate(short(redact(call.detail)), 70)}` : "";
          out(c.dim(`    ${i + 1}. ${call.name}${detail}`));
        }
        if (calls.length > maxCalls)
          out(c.dim(`    ... ${calls.length - maxCalls} more (redacted, truncated)`));
        out(
          `  ${c.green("finished")} ${secs(r.durationMs)}  ${n(r.usage?.totalTokens ?? 0)} tokens`,
        );
        if (entry.role === "planner") {
          plan = parsePlan(r.text, rec.budget.maxTasks);
          for (const t of plan.tasks)
            out(`  plan ${c.bold(t.id)} ${t.title} ${c.dim(`[${t.files.join(", ")}]`)}`);
        }
        if (entry.role === "reviewer" && lastTests && lastSnap && plan) {
          const said = parseReview(r.text);
          const gated = gateReview(
            said,
            lastTests,
            scopeViolations(lastSnap.changes, plan, rec.workspace),
          );
          const tag = (v: string) => (v === "PASS" ? c.green(v) : c.red(v));
          out(`  reviewer said ${tag(said.verdict)}; after gate: ${tag(gated.verdict)}`);
          for (const reason of said.reasons.slice(0, 3)) {
            out(`    - ${wrap(short(reason), 88, "      ")}`);
          }
          if (said.reasons.length > 3)
            out(c.dim(`    ... ${said.reasons.length - 3} more from the reviewer`));
          const forced = gated.reasons.filter((x) => !said.reasons.includes(x));
          for (const f of forced) out(`    ${c.red("+ added by gate:")} ${f}`);
        }
        await sleep(pause);
      },
    },
  });

  out();
  out(c.bold("Summary"));
  out(
    c.dim(
      `  ${"#".padEnd(3)}${"run".padEnd(13)}${"status".padEnd(10)}${"time".padStart(7)}${"tokens".padStart(10)}${"calls".padStart(7)}`,
    ),
  );
  for (const r of report.runs) {
    out(
      `  ${String(r.index).padEnd(3)}${r.label.padEnd(13)}${r.result.status.padEnd(10)}${secs(r.result.durationMs).padStart(7)}${n(r.result.usage?.totalTokens ?? 0).padStart(10)}${String(r.result.toolCalls.length).padStart(7)}`,
    );
  }
  out(`  ${"".padEnd(26)}${c.bold("total")}${n(report.usage.totalTokens).padStart(16)}`);
  out();
  const tag = report.outcome === "PASS" ? c.green : c.red;
  out(
    `${c.bold("Outcome")} ${tag(report.outcome)}  ${wrap(short(report.message), 80, "         ")}`,
  );
  out(
    `runs ${report.runs.length}/${b.maxRuns}   tokens ${n(report.usage.totalTokens)}   est. cost at list price $${report.estCostUsd.toFixed(2)}`,
  );
  for (const u of runner.unreplayed)
    out(c.yellow(`not spent: recorded ${u.label} was never requested`));
  const same = report.outcome === rec.outcome && report.usage.totalTokens === rec.totalTokens;
  out(
    c.dim(
      `recorded: ${rec.outcome}, ${n(rec.totalTokens)} tokens, $${rec.estCostUsd.toFixed(2)}  ->  replay ${same ? "matches" : "differs"}`,
    ),
  );
  out(c.magenta("Replay of a recorded run: no model calls were made."));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);

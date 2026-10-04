import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Budget, ModelSelection } from "./config.js";
import type {
  AgentRunner,
  Review,
  RoleRunRequest,
  RoleRunResult,
  TestRunner,
  TestRunResult,
  TokenUsage,
  ToolCallRecord,
} from "./types.js";
import type { WorkspaceChange, WorkspaceInspector } from "./workspace.js";

/** One agent run as committed under runs/<ts>/NN-<label>.md. */
export interface RecordedRun {
  index: number;
  label: string;
  status: RoleRunResult["status"];
  durationMs?: number;
  usage?: TokenUsage;
  toolCalls: ToolCallRecord[];
  text: string;
}

export interface Recording {
  dir: string;
  goal: string;
  workspace: string;
  model: ModelSelection;
  budget: Budget;
  testCommand: string;
  runs: RecordedRun[];
  /** Gated reviews from summary.json, in order. */
  reviews: Review[];
  outcome: string;
  totalTokens: number;
  estCostUsd: number;
  /** tests.txt: output of the last test run only. */
  lastTestOutput: string;
}

/** Tools whose logged detail is a filesystem path in the run logs this replays. */
const PATH_TOOLS = new Set(["read", "edit", "grep", "ls"]);

/** Parse one run log written by FileRunSink. */
export function parseRunLog(md: string): RecordedRun {
  const head = /^# Run (\d+): (.+)$/m.exec(md);
  if (!head?.[1] || !head[2]) throw new Error("run log has no '# Run N: label' header");
  const field = (name: string) => new RegExp(`^- ${name}: (.*)$`, "m").exec(md)?.[1]?.trim();
  const usage = field("usage");
  const duration = Number(field("duration_ms"));
  const section = (title: string) => {
    const start = md.indexOf(`## ${title}\n`);
    if (start < 0) return "";
    const rest = md.slice(start + title.length + 4);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const toolCalls: ToolCallRecord[] = [];
  for (const line of section("Tool calls").split("\n")) {
    const m = /^\d+\. (\S+?)( \(error\))?(?: (".*"))?$/.exec(line.trim());
    if (!m?.[1]) continue;
    const detail = m[3] ? (JSON.parse(m[3]) as string) : undefined;
    toolCalls.push({
      name: m[1],
      status: m[2] ? "error" : "completed",
      ...(detail ? { detail } : {}),
    });
  }
  const fenced = /````text\n([\s\S]*?)\n````/.exec(section("Final response"));
  const text = fenced?.[1] ?? "";
  return {
    index: Number(head[1]),
    label: head[2].trim(),
    status: (field("status") as RoleRunResult["status"] | undefined) ?? "finished",
    ...(Number.isFinite(duration) ? { durationMs: duration } : {}),
    ...(usage && usage !== "n/a" ? { usage: JSON.parse(usage) as TokenUsage } : {}),
    toolCalls,
    text: text === "(empty)" ? "" : text,
  };
}

export async function loadRecording(dir: string): Promise<Recording> {
  const json = async (f: string) =>
    JSON.parse(await readFile(join(dir, f), "utf8")) as Record<string, unknown>;
  const meta = await json("meta.json");
  const summary = await json("summary.json");
  const files = (await readdir(dir)).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
  const runs = await Promise.all(
    files.map(async (f) => parseRunLog(await readFile(join(dir, f), "utf8"))),
  );
  const lastTestOutput = await readFile(join(dir, "tests.txt"), "utf8").catch(() => "");
  const usage = summary["usage"] as TokenUsage | undefined;
  return {
    dir,
    goal: String(meta["goal"]),
    workspace: String(meta["workspace"]),
    model: meta["model"] as ModelSelection,
    budget: meta["budget"] as Budget,
    testCommand: String(meta["testCommand"] ?? ""),
    runs,
    reviews: (summary["reviews"] as Review[] | undefined) ?? [],
    outcome: String(summary["outcome"]),
    totalTokens: usage?.totalTokens ?? 0,
    estCostUsd: Number(summary["estCostUsd"] ?? 0),
    lastTestOutput,
  };
}

export interface ReplayOptions {
  /**
   * Give each tool call the path from its logged detail, so the current coder path check
   * sees it. Off by default: the recorded orchestrator did not capture paths.
   */
  checkPaths?: boolean;
  /** Wait durationMs / speed before returning each run. 0 or Infinity: no waiting. */
  speed?: number;
  /** Called before each replayed run starts. */
  onStart?: (req: RoleRunRequest, recorded: RecordedRun) => void;
}

/**
 * An AgentRunner that answers from a recording instead of a model. It refuses to answer a
 * request whose label differs from the next recorded run, so a replay only succeeds when the
 * current pipeline asks for exactly the recorded sequence of runs.
 */
export class ReplayRunner implements AgentRunner {
  private next = 0;
  constructor(
    private readonly recording: Recording,
    private readonly opts: ReplayOptions = {},
  ) {}

  /** Recorded runs the pipeline never asked for. */
  get unreplayed(): RecordedRun[] {
    return this.recording.runs.slice(this.next);
  }

  async run(req: RoleRunRequest): Promise<RoleRunResult> {
    const rec = this.recording.runs[this.next];
    if (!rec) throw new Error(`recording exhausted at ${req.label}`);
    if (rec.label !== req.label) {
      throw new Error(`pipeline asked for ${req.label}, recording has ${rec.label} next`);
    }
    this.next++;
    this.opts.onStart?.(req, rec);
    const speed = this.opts.speed ?? 0;
    const wait = rec.durationMs ?? 0;
    if (speed > 0 && Number.isFinite(speed) && wait > 0) {
      await new Promise((r) => setTimeout(r, wait / speed));
    }
    const toolCalls = rec.toolCalls.map((c) =>
      this.opts.checkPaths && PATH_TOOLS.has(c.name) && c.detail && isAbsolute(c.detail)
        ? { ...c, paths: [c.detail] }
        : c,
    );
    return {
      status: rec.status,
      text: rec.text,
      toolCalls,
      ...(rec.usage ? { usage: rec.usage } : {}),
      ...(rec.durationMs !== undefined ? { durationMs: rec.durationMs } : {}),
    };
  }
}

const GATE_TEST_REASON = /^test command exited with code (\d+)$/;

/**
 * Test results for each review, in order. Exit codes come from the gate reason recorded in
 * summary.json ("test command exited with code N"; absent means 0). Only the last run's
 * output was recorded (tests.txt); earlier outputs say so instead of inventing one.
 */
export function replayTestRunner(recording: Recording): TestRunner {
  let i = 0;
  return async (): Promise<TestRunResult> => {
    const review = recording.reviews[i];
    const last = i === recording.reviews.length - 1;
    i++;
    const code = review?.reasons.map((r) => GATE_TEST_REASON.exec(r)?.[1]).find(Boolean);
    const exitCode = code ? Number(code) : 0;
    return {
      exitCode,
      output:
        last && recording.lastTestOutput
          ? recording.lastTestOutput
          : `(output not recorded; exit code ${exitCode} from the recorded gate reason)`,
    };
  };
}

/**
 * Workspace state for the replay: clean before the run, then every file a coder run edited so
 * far, taken from the recorded edit calls (the recorded run did not log git status).
 */
export function replayInspector(recording: Recording, runner: ReplayRunner): WorkspaceInspector {
  return async () => {
    const done = recording.runs.slice(0, recording.runs.length - runner.unreplayed.length);
    const prefix = recording.workspace.replace(/\/+$/, "") + "/";
    const paths = new Set<string>();
    for (const r of done.filter((x) => x.label.startsWith("coder"))) {
      for (const c of r.toolCalls) {
        if (c.name === "edit" && c.detail?.startsWith(prefix))
          paths.add(c.detail.slice(prefix.length));
      }
    }
    const changes: WorkspaceChange[] = [...paths].map((path) => ({ path, status: " M" }));
    return {
      changes,
      statusText: changes.map((c) => `${c.status} ${c.path}`).join("\n"),
      diff: changes.length ? "(diff not recorded in this run)" : "",
    };
  };
}

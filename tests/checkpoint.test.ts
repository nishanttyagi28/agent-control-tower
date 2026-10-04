import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitCheckpointer, type Checkpoint, type WorkspaceCheckpointer } from "../src/checkpoint.js";
import { DEFAULT_BUDGET } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import { FileRunSink } from "../src/run-log.js";
import {
  GREEN,
  IN_SCOPE,
  PROMPTS,
  ScriptedRunner,
  ok,
  planJson,
  review,
  scriptedTests,
  workspaceAfter,
} from "./fakes.js";

function tempRepo() {
  const repo = mkdtempSync(join(tmpdir(), "ckpt-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: repo,
    }).toString();
  git("init", "-q", "-b", "main");
  const ws = join(repo, "examples", "t");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".venv/\n");
  writeFileSync(join(ws, "a.py"), "x = 1\n");
  writeFileSync(join(repo, "outside.txt"), "o\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { repo, ws, git };
}

describe("gitCheckpointer (real git, temp repo)", () => {
  it("checkpoints without touching HEAD, branches or the index, and diffs between checkpoints", async () => {
    const { ws, git } = tempRepo();
    const head = git("rev-parse", "HEAD");
    const cp = gitCheckpointer(ws, "refs/cursor-demo/test");

    const base = await cp.checkpoint("base");
    writeFileSync(join(ws, "a.py"), "x = 2\n");
    writeFileSync(join(ws, "new.py"), "y = 1\n");
    const r1 = await cp.checkpoint("review-1");
    writeFileSync(join(ws, "a.py"), "x = 3\n");
    const r2 = await cp.checkpoint("review-2");

    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("branch", "--list")).toBe("* main\n");
    expect(git("diff", "--cached", "--name-only")).toBe(""); // real index untouched
    expect(git("for-each-ref", "--format=%(refname)", "refs/cursor-demo")).toBe(
      "refs/cursor-demo/test/base\nrefs/cursor-demo/test/review-1\nrefs/cursor-demo/test/review-2\n",
    );

    const sinceLast = await cp.diff(r1, r2);
    expect(sinceLast).toContain("-x = 2\n+x = 3");
    expect(sinceLast).not.toContain("new.py");
    const full = await cp.diff(base, r2);
    expect(full).toContain("+++ b/new.py");
    expect(full).toContain("+x = 3");
  });

  it("restores the pre-pipeline state, keeps ignored files and leaves outside files alone", async () => {
    const { repo, ws, git } = tempRepo();
    const cp = gitCheckpointer(ws, "refs/cursor-demo/test");
    const base = await cp.checkpoint("base");

    writeFileSync(join(ws, "a.py"), "broken\n");
    mkdirSync(join(ws, "tests"));
    writeFileSync(join(ws, "tests", "test_a.py"), "def test(): pass\n");
    mkdirSync(join(ws, ".venv"));
    writeFileSync(join(ws, ".venv", "keep"), "venv\n");
    writeFileSync(join(repo, "outside.txt"), "user edit\n");

    const touched = await cp.restore(base);

    expect(touched.sort()).toEqual(["a.py", "tests/test_a.py"]);
    expect(readFileSync(join(ws, "a.py"), "utf8")).toBe("x = 1\n");
    expect(existsSync(join(ws, "tests", "test_a.py"))).toBe(false);
    expect(existsSync(join(ws, ".venv", "keep"))).toBe(true);
    expect(readFileSync(join(repo, "outside.txt"), "utf8")).toBe("user edit\n");
    expect(git("status", "--porcelain", "--", "examples/t")).toBe("");
    expect(existsSync(join(ws, "tests"))).toBe(false); // emptied dirs are removed too
    expect(git("for-each-ref", "--format=%(refname)", "refs/cursor-demo")).toContain(
      "pre-restore-base",
    );
  });
});

/** In-memory checkpointer: records calls; diff/restore return canned values. */
function fakeCheckpointer() {
  const calls: string[] = [];
  const cp: WorkspaceCheckpointer = {
    async checkpoint(label) {
      calls.push(`checkpoint ${label}`);
      return { label, commit: label, ref: `refs/x/${label}` };
    },
    async diff(from: Checkpoint, to: Checkpoint) {
      calls.push(`diff ${from.label}..${to.label}`);
      return `diff ${from.label}..${to.label}`;
    },
    async restore(to) {
      calls.push(`restore ${to.label}`);
      return ["f1.py"];
    },
  };
  return { cp, calls };
}

describe("pipeline: checkpoints between retries", () => {
  const pipeline = (script: string[], cp: WorkspaceCheckpointer, tests = [GREEN, GREEN, GREEN]) => {
    const runner = new ScriptedRunner(script.map((t) => ok(t)));
    return runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests(tests),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      checkpoints: cp,
      prompts: PROMPTS,
      budget: { ...DEFAULT_BUDGET, maxTasks: 1 },
    }).then((report) => ({ report, runner }));
  };

  it("gives the second reviewer the diff since the first review, and does not restore on PASS", async () => {
    const { cp, calls } = fakeCheckpointer();
    const { report, runner } = await pipeline(
      [planJson(1), "c", review("FAIL", ["x missing"]), "fix", review("PASS")],
      cp,
    );
    expect(report.outcome).toBe("PASS");
    expect(runner.requests[2]?.prompt).toContain("since=(first review: same as the full diff)");
    expect(runner.requests[4]?.prompt).toContain("since=diff review-1..review-2");
    expect(calls).toEqual([
      "checkpoint base",
      "checkpoint review-1",
      "checkpoint review-2",
      "diff review-1..review-2",
    ]);
    expect(report.failure).toBeUndefined();
    expect(report.checkpointRefs).toEqual(["refs/x/base", "refs/x/review-1", "refs/x/review-2"]);
  });

  it("on final FAIL saves the failed diff and restores the pre-pipeline state", async () => {
    const { cp, calls } = fakeCheckpointer();
    const { report } = await pipeline(
      [planJson(1), "c", review("FAIL", ["x missing"]), "fix", review("FAIL", ["y wrong"])],
      cp,
    );
    expect(report.outcome).toBe("FAIL");
    expect(calls.slice(-3)).toEqual(["checkpoint failed", "diff base..failed", "restore base"]);
    expect(report.failure).toEqual({
      failedDiff: "diff base..failed",
      failedRef: "refs/x/failed",
      restored: ["f1.py"],
    });
    expect(report.message).toContain(
      "workspace restored, 1 path(s); failed state kept at refs/x/failed",
    );
  });

  it("restores after an agent error too, and writes failed.diff into the run directory", async () => {
    const { cp, calls } = fakeCheckpointer();
    const runner = new ScriptedRunner([
      ok(planJson(1)),
      { status: "error", text: "", toolCalls: [], error: "boom" },
    ]);
    const report = await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner,
      runTests: scriptedTests([]),
      inspectWorkspace: workspaceAfter(IN_SCOPE).inspect,
      checkpoints: cp,
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
    });
    expect(report.outcome).toBe("ERROR");
    expect(calls).toContain("restore base");

    const dir = mkdtempSync(join(tmpdir(), "sink-"));
    const sink = new FileRunSink(dir);
    await sink.init({});
    await sink.summary(report);
    expect(readdirSync(dir)).toContain("failed.diff");
    expect(readFileSync(join(dir, "failed.diff"), "utf8")).toBe("diff base..failed");
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).failure.failedRef).toBe(
      "refs/x/failed",
    );
  });

  it("does not checkpoint or restore when the workspace was dirty to begin with", async () => {
    const { cp, calls } = fakeCheckpointer();
    const report = await runPipeline({
      goal: "g",
      workspace: "/ws",
      testCommand: "pytest",
      runner: new ScriptedRunner([]),
      runTests: scriptedTests([]),
      inspectWorkspace: async () => ({
        changes: [{ status: " M", path: "a" }],
        statusText: " M a",
        diff: "",
      }),
      checkpoints: cp,
      prompts: PROMPTS,
      budget: DEFAULT_BUDGET,
    });
    expect(report.outcome).toBe("ERROR");
    expect(calls).toEqual([]);
  });
});

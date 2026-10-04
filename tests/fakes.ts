import type { PromptSet } from "../src/prompts.js";
import type {
  AgentRunner,
  RoleRunRequest,
  RoleRunResult,
  TestRunResult,
  TestRunner,
} from "../src/types.js";
import type { WorkspaceChange, WorkspaceInspector, WorkspaceSnapshot } from "../src/workspace.js";

export const PROMPTS: PromptSet = {
  planner: "plan {{goal}} max={{max_tasks}}",
  coder: "code {{task_id}} {{task_title}}: {{task_instructions}} files={{task_files}}",
  reviewer:
    "review exit={{test_exit_code}} {{test_output}} {{plan}} {{goal}} {{test_command}} " +
    "status={{git_status}} diff={{git_diff}}",
};

export function ok(text: string, totalTokens = 10): RoleRunResult {
  return {
    status: "finished",
    text,
    toolCalls: [{ name: "read", status: "completed", detail: "AGENTS.md" }],
    usage: {
      inputTokens: totalTokens / 2,
      outputTokens: totalTokens / 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
    },
  };
}

export const planJson = (n: number) =>
  "```json\n" +
  JSON.stringify({
    summary: "s",
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `T${i + 1}`,
      title: `task ${i + 1}`,
      instructions: "do it",
      files: [`f${i + 1}.py`, "tests/test_f.py"],
    })),
  }) +
  "\n```";

export const review = (verdict: "PASS" | "FAIL", reasons: string[] = []) =>
  JSON.stringify({ verdict, reasons });

/** Replays scripted results in order and records every request it received. */
export class ScriptedRunner implements AgentRunner {
  readonly requests: RoleRunRequest[] = [];
  constructor(private readonly script: RoleRunResult[]) {}

  async run(req: RoleRunRequest): Promise<RoleRunResult> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error(`script exhausted at ${req.label}`);
    return next;
  }
}

export function scriptedTests(results: TestRunResult[]): TestRunner {
  return async () => {
    const next = results.shift();
    if (!next) throw new Error("test script exhausted");
    return next;
  };
}

const snapshot = (changes: WorkspaceChange[]): WorkspaceSnapshot => ({
  changes,
  statusText: changes.map((c) => `${c.status} ${c.path}`).join("\n"),
  diff: changes.map((c) => `+++ b/${c.path}`).join("\n"),
});

/**
 * First call (the pre-run baseline) sees a clean workspace; every later call sees `after`.
 * Calls are counted so tests can assert when the workspace was inspected.
 */
export function workspaceAfter(after: WorkspaceChange[]) {
  let calls = 0;
  const inspect: WorkspaceInspector = async () => snapshot(calls++ === 0 ? [] : after);
  return { inspect, calls: () => calls };
}

export const IN_SCOPE: WorkspaceChange[] = [
  { status: "??", path: "f1.py" },
  { status: "??", path: "tests/test_f.py" },
];

export const GREEN: TestRunResult = { exitCode: 0, output: "3 passed" };
export const RED: TestRunResult = { exitCode: 1, output: "1 failed" };

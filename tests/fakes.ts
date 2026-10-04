import type { PromptSet } from "../src/prompts.js";
import type {
  AgentRunner,
  RoleRunRequest,
  RoleRunResult,
  TestRunResult,
  TestRunner,
} from "../src/types.js";

export const PROMPTS: PromptSet = {
  planner: "plan {{goal}} max={{max_tasks}}",
  coder: "code {{task_id}} {{task_title}}: {{task_instructions}}",
  reviewer: "review exit={{test_exit_code}} {{test_output}} {{plan}} {{goal}} {{test_command}}",
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

export const GREEN: TestRunResult = { exitCode: 0, output: "3 passed" };
export const RED: TestRunResult = { exitCode: 1, output: "1 failed" };

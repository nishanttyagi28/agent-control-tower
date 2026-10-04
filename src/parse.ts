import type { Plan, PlanTask, Review } from "./types.js";

export class ParseError extends Error {
  override name = "ParseError";
}

/**
 * Pull one JSON object out of model text. Prefers the last ```json fenced block,
 * falls back to the outermost {...} span. Models often add prose around the JSON.
 */
export function extractJson(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates: string[] = fenced.map((m) => m[1] ?? "").reverse();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  throw new ParseError("no parseable JSON object found in agent output");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ParseError(`${ctx}: "${key}" must be a non-empty string`);
  }
  return v.trim();
}

function requireFiles(obj: Record<string, unknown>, ctx: string): string[] {
  const v = obj["files"];
  if (!Array.isArray(v) || v.length === 0 || !v.every((f) => typeof f === "string" && f.trim())) {
    throw new ParseError(`${ctx}: "files" must be a non-empty array of paths`);
  }
  return v.map((f: string) => f.trim());
}

export function parsePlan(text: string, maxTasks: number): Plan {
  const raw = extractJson(text);
  if (!isRecord(raw)) throw new ParseError("plan: expected a JSON object");
  const tasksRaw = raw["tasks"];
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    throw new ParseError('plan: "tasks" must be a non-empty array');
  }
  const tasks: PlanTask[] = tasksRaw.slice(0, maxTasks).map((t, i) => {
    if (!isRecord(t)) throw new ParseError(`plan.tasks[${i}]: expected an object`);
    return {
      id: typeof t["id"] === "string" && t["id"] ? t["id"] : `T${i + 1}`,
      title: requireString(t, "title", `plan.tasks[${i}]`),
      instructions: requireString(t, "instructions", `plan.tasks[${i}]`),
      files: requireFiles(t, `plan.tasks[${i}]`),
    };
  });
  const summary = typeof raw["summary"] === "string" ? raw["summary"] : "";
  return { summary, tasks };
}

export function parseReview(text: string): Review {
  const raw = extractJson(text);
  if (!isRecord(raw)) throw new ParseError("review: expected a JSON object");
  const verdict = raw["verdict"];
  if (verdict !== "PASS" && verdict !== "FAIL") {
    throw new ParseError('review: "verdict" must be "PASS" or "FAIL"');
  }
  const reasonsRaw = raw["reasons"];
  const reasons = Array.isArray(reasonsRaw)
    ? reasonsRaw.filter((r): r is string => typeof r === "string")
    : [];
  return { verdict, reasons };
}

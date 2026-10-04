import type { ToolCallRecord } from "./types.js";

export const TOOL_DETAIL_LIMIT = 200;

/**
 * One-line description of a tool call's arguments. The SDK marks tool args as unstable
 * (`unknown`), so read the common fields defensively and fall back to JSON.
 */
export function describeToolArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== "object") return String(args);
  const a = args as Record<string, unknown>;
  for (const key of ["command", "path", "globPattern", "pattern"]) {
    const v = a[key];
    if (typeof v === "string" && v) return v;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return undefined;
  }
}

export function truncate(text: string, limit = TOOL_DETAIL_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}... [+${text.length - limit} chars]`;
}

export function toolNames(calls: ToolCallRecord[]): string[] {
  return calls.map((c) => (c.status === "error" ? `${c.name}(error)` : c.name));
}

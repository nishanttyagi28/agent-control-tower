import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./types.js";

export type PromptSet = Record<Role, string>;

export async function loadPrompts(dir: string): Promise<PromptSet> {
  const read = (role: Role) => readFile(join(dir, `${role}.md`), "utf8");
  const [planner, coder, reviewer] = await Promise.all([
    read("planner"),
    read("coder"),
    read("reviewer"),
  ]);
  return { planner, coder, reviewer };
}

/**
 * Replace {{name}} placeholders. Unknown placeholders are an error so a typo in a
 * prompt file fails loudly instead of sending a literal "{{goal}}" to the model.
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`prompt placeholder {{${key}}} has no value`);
    return v;
  });
}

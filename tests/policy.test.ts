import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_POLICY,
  parseRetryPolicy,
  PolicyError,
  resolveRetryPolicy,
} from "../src/policy.js";

const block = (json: string) =>
  `# AGENTS.md\n\n## 6. Retry policy\n\n\`\`\`json retry-policy\n${json}\n\`\`\`\n`;

describe("parseRetryPolicy", () => {
  it("reads the block in the repo's AGENTS.md and it matches the built-in defaults", () => {
    const fromRepo = parseRetryPolicy(readFileSync("AGENTS.md", "utf8"));
    expect(fromRepo).toEqual({
      maxRetries: 1,
      duplicateFailure: { enabled: true, overlapThreshold: 0.8 },
      confirmThreshold: 0.8,
    });
    expect(resolveRetryPolicy(fromRepo)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("returns no overrides when there is no block, and ignores other json fences", () => {
    expect(parseRetryPolicy('# nothing here\n```json\n{"maxRetries": 3}\n```\n')).toEqual({});
  });

  it("accepts partial blocks", () => {
    expect(parseRetryPolicy(block('{ "duplicateFailure": { "enabled": false } }'))).toEqual({
      duplicateFailure: { enabled: false },
    });
  });

  it.each([
    ['{ "maxRetries": 1, "maxRuns": 9 }', /unknown key\(s\) maxRuns/],
    ['{ "maxRetries": -1 }', /maxRetries must be an integer/],
    ['{ "maxRetries": 1.5 }', /maxRetries must be an integer/],
    ['{ "maxRetries": "2" }', /maxRetries must be an integer/],
    ['{ "confirmThreshold": 0 }', /confirmThreshold must be a number in \(0, 1\]/],
    ['{ "duplicateFailure": { "overlapThreshold": 1.2 } }', /overlapThreshold/],
    ['{ "duplicateFailure": { "enabled": "yes" } }', /enabled must be a boolean/],
    ['{ "duplicateFailure": { "typo": 1 } }', /unknown key\(s\) typo/],
    ["[1, 2]", /must be a JSON object/],
    ["{ maxRetries: 1 }", /not valid JSON/],
  ])("rejects %s", (json, message) => {
    expect(() => parseRetryPolicy(block(json))).toThrow(PolicyError);
    expect(() => parseRetryPolicy(block(json))).toThrow(message);
  });

  it("rejects two policy blocks", () => {
    expect(() => parseRetryPolicy(block("{}") + block("{}"))).toThrow(/more than one/);
  });
});

describe("resolveRetryPolicy precedence: flag > AGENTS.md > default", () => {
  const fromAgents = parseRetryPolicy(
    block(
      '{ "maxRetries": 2, "duplicateFailure": { "overlapThreshold": 0.6 }, "confirmThreshold": 0.5 }',
    ),
  );

  it("uses AGENTS.md over defaults", () => {
    expect(resolveRetryPolicy(fromAgents)).toEqual({
      maxRetries: 2,
      confirmThreshold: 0.5,
      duplicateFailure: { enabled: true, overlapThreshold: 0.6 },
    });
  });

  it("uses flags over AGENTS.md, field by field", () => {
    expect(
      resolveRetryPolicy(fromAgents, {
        maxRetries: "0",
        duplicateOverlap: "0.9",
        noDuplicateCheck: true,
      }),
    ).toEqual({
      maxRetries: 0,
      confirmThreshold: 0.5,
      duplicateFailure: { enabled: false, overlapThreshold: 0.9 },
    });
  });

  it("falls back to defaults with neither", () => {
    expect(resolveRetryPolicy({})).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("validates flag values too", () => {
    expect(() => resolveRetryPolicy({}, { maxRetries: "two" })).toThrow(/--max-retries/);
    expect(() => resolveRetryPolicy({}, { confirmThreshold: "1.5" })).toThrow(
      /--confirm-threshold/,
    );
  });
});

/** Environment variables whose values must never reach a log file. */
export const SECRET_ENV_VARS = [
  "CURSOR_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

const MARK = "[REDACTED]";

// Token shapes worth catching even when they did not come from our own environment.
const PATTERNS: Array<[RegExp, string]> = [
  [/\bcrsr_[A-Za-z0-9]{16,}/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MARK],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MARK}`],
  [
    /\b((?:api[_-]?key|token|secret|password|passwd)["']?\s*[=:]\s*)(["']?)[^\s"']{4,}\2/gi,
    `$1${MARK}`,
  ],
];

/**
 * Remove secrets from text before it is written anywhere. Exact values of known secret env
 * vars are replaced first (any shape), then common token patterns. Run this before
 * truncating, so a cut never leaves a partial secret that no longer matches.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (value && value.length >= 8) out = out.split(value).join(MARK);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

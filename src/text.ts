/** Keep the tail of long text (test output and model text are most useful at the end). */
export function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `[... ${text.length - limit} chars trimmed ...]\n` + text.slice(-limit);
}

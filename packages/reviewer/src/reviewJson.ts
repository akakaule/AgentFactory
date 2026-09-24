/** A closing Markdown fence must occupy its own line; findings may contain backticks. */
export function parseReviewJson(body: string): unknown {
  const fenced = body.trimStart().startsWith('{') ? body.trim() : body.match(/^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/im)?.[1]
    ?? body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error('Reviewer produced no review JSON');
  try { return JSON.parse(candidate); }
  catch { throw new Error('Reviewer produced malformed or truncated review JSON; no verdict was recorded.'); }
}

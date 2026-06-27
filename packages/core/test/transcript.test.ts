import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/transcript.js';
import type { TranscriptBlock } from '../src/types.js';

// A small JSONL transcript shaped like a real Claude Code session file (CLI 2.1.x):
// metadata lines without a `message`, a user line whose `content` is a bare string, an
// assistant line whose `content` is a block array (thinking/text/tool_use), and the matching
// `tool_result` riding a later user line with a richer top-level `toolUseResult` sidecar.
const T = '2026-06-27T00:00:00.000Z';
const lines: unknown[] = [
  { type: 'mode', mode: 'normal', sessionId: 's' },
  { type: 'ai-title', aiTitle: 'X', sessionId: 's' },
  // an injected-context attachment line (deferred tools / skill listing) — pure noise, must be skipped
  { type: 'attachment', attachment: { type: 'skill_listing', content: 'NOISE' }, uuid: 'att1', timestamp: T },
  { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'hello world' }, uuid: 'u1', timestamp: T },
  { isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'let me think' }] }, uuid: 'a1', timestamp: T },
  { isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running a command' }] }, uuid: 'a2', timestamp: T },
  { isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'echo hi && curl -H "Authorization: Bearer sk-ant-SECRETSECRETSECRETSECRET" x', description: 'say hi' } }] }, uuid: 'a3', timestamp: T },
  { isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'hi\n', is_error: false }] }, toolUseResult: { stdout: 'hi\n', stderr: '', exitCode: 0 }, uuid: 'u2', timestamp: T },
  { isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/x' } }] }, uuid: 'a4', timestamp: T },
  { isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: 'file contents', is_error: false }] }, uuid: 'u3', timestamp: T },
  { isSidechain: true, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent work' }] }, uuid: 'a5', timestamp: T },
];
// trailing half-written line — a live file caught mid-append must not break parsing
const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n{ broken json line';

const byKind = (blocks: TranscriptBlock[], kind: TranscriptBlock['kind']) => blocks.filter((b) => b.kind === kind);

describe('parseTranscript (claude)', () => {
  it('never throws and tolerates a half-written trailing line', () => {
    expect(() => parseTranscript(raw)).not.toThrow();
    expect(() => parseTranscript('')).not.toThrow();
    expect(() => parseTranscript('not json at all')).not.toThrow();
  });

  it('skips metadata + injected-attachment lines (no content from them)', () => {
    const blocks = parseTranscript(raw);
    expect(blocks.some((b) => JSON.stringify(b).includes('NOISE'))).toBe(false);
  });

  it('renders a bare-string user message as a text block', () => {
    const blocks = parseTranscript(raw);
    const first = blocks[0]!;
    expect(first).toMatchObject({ kind: 'text', role: 'user', text: 'hello world', id: 'u1:0', sidechain: false });
  });

  it('keeps non-empty thinking and drops empty thinking', () => {
    const thinking = byKind(parseTranscript(raw), 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ kind: 'thinking', text: 'let me think', role: 'assistant' });
  });

  it('folds a Bash tool_use + its tool_result into one bash block (no standalone result block)', () => {
    const bash = byKind(parseTranscript(raw), 'bash');
    expect(bash).toHaveLength(1);
    expect(bash[0]).toMatchObject({ kind: 'bash', description: 'say hi', stdout: 'hi\n', exitCode: 0, isError: false });
    expect(bash[0]!.kind === 'bash' && bash[0]!.command.startsWith('echo hi')).toBe(true);
  });

  it('redacts secrets in tool input before they ever leave the parser', () => {
    const bash = byKind(parseTranscript(raw), 'bash')[0]!;
    expect(bash.kind === 'bash' && bash.command.includes('SECRETSECRET')).toBe(false);
    expect(bash.kind === 'bash' && /redacted/i.test(bash.command)).toBe(true);
  });

  it('folds a non-Bash tool_use + result into a tool block carrying the tool name', () => {
    const tools = byKind(parseTranscript(raw), 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'Read', result: 'file contents' });
  });

  it('marks sidechain (subagent) blocks', () => {
    const sub = parseTranscript(raw).find((b) => b.kind === 'text' && b.text === 'subagent work');
    expect(sub).toBeDefined();
    expect(sub!.sidechain).toBe(true);
  });

  it('gives every block a unique <uuid>:<index> id', () => {
    const ids = parseTranscript(raw).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /:\d+$/.test(id))).toBe(true);
  });
});

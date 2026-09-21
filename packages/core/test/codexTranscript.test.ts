import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/transcript.js';

describe('Codex exec transcript', () => {
  it('renders completed messages, commands and MCP calls while replacing live item updates', () => {
    const raw = [
      { type: 'item.started', item: { id: '1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'npm test', aggregated_output: 'passed', exit_code: 0 } },
      { type: 'item.completed', item: { id: '2', type: 'mcp_tool_call', server: 'agentfactory', tool: 'submit_result', arguments: { summary: 'done' }, result: { content: [] } } },
      { type: 'item.completed', item: { id: '3', type: 'agent_message', text: 'Implemented' } },
    ].map(e => JSON.stringify(e)).join('\n') + '\n{partial';
    const blocks = parseTranscript(raw, 'codex');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'bash', command: 'npm test', stdout: 'passed', exitCode: 0 });
    expect(blocks[1]).toMatchObject({ kind: 'tool', name: 'agentfactory.submit_result' });
    expect(blocks[2]).toMatchObject({ kind: 'text', text: 'Implemented' });
  });
});

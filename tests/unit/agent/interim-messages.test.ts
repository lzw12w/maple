import { describe, expect, it } from 'vitest';
import { translateEventWithStageMessages } from '../../../src/agent/claude/stream-json.js';
import { CodexJsonlTranslator } from '../../../src/agent/codex/jsonl.js';
import {
  ClaudeStructuralInterim,
  InterimBudget,
  STRUCTURAL_INTERIM_PROMPT,
} from '../../../src/agent/interim-messages.js';
import { buildBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt.js';
import { CLAUDE_STAGE_MESSAGE_PROMPT, StageMessageParser } from '../../../src/agent/stage-message.js';
import { getInterimMessagesMode } from '../../../src/config/schema.js';
import type { AppConfig } from '../../../src/config/schema.js';
import type { AgentEvent } from '../../../src/agent/types.js';

/**
 * Realistic `claude -p --output-format stream-json --verbose` lines: without
 * --include-partial-messages Claude Code emits one `assistant` event per
 * completed content block, and blocks of one API message share `message.id`.
 */
const claudeTurn = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/repo', model: 'claude-sonnet-4-5' },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'sess-1',
    message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: '我先看一下配置文件。' }] },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 'sess-1',
    message: {
      id: 'msg_01',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.ts' } }],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;' }] },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_02', role: 'assistant', content: [{ type: 'thinking', thinking: 'need tests too' }] },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_02', role: 'assistant', content: [{ type: 'text', text: '找到了，再跑一下测试。' }] },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: 'msg_02',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pnpm test' } }],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_03', role: 'assistant', content: [{ type: 'text', text: '结论：配置正确，测试全部通过。' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '结论：配置正确，测试全部通过。',
    session_id: 'sess-1',
    usage: { input_tokens: 10, output_tokens: 5 },
  },
];

function runClaude(lines: unknown[], structural = new ClaudeStructuralInterim()): AgentEvent[] {
  const parser = new StageMessageParser();
  const out: AgentEvent[] = [];
  for (const line of lines) out.push(...translateEventWithStageMessages(line, parser, structural));
  out.push(...parser.finish(), ...structural.finish());
  return out;
}

const pick = (events: AgentEvent[]) =>
  events.filter((e) => ['stage_message', 'final_text', 'text', 'tool_use'].includes(e.type));

describe('Claude structural interim messages', () => {
  it('sends pre-tool text as interim messages and the last text as final_text', () => {
    expect(pick(runClaude(claudeTurn))).toEqual([
      { type: 'stage_message', content: '我先看一下配置文件。' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'stage_message', content: '找到了，再跑一下测试。' },
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'final_text', content: '结论：配置正确，测试全部通过。' },
    ]);
  });

  it('flushes interim before final, and final before done', () => {
    const types = runClaude(claudeTurn).map((e) => e.type);
    expect(types.lastIndexOf('stage_message')).toBeLessThan(types.indexOf('final_text'));
    expect(types.indexOf('final_text')).toBeLessThan(types.indexOf('done'));
  });

  it('answers a tool-free turn with only final_text', () => {
    const events = runClaude([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '你好！' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    expect(pick(events)).toEqual([{ type: 'final_text', content: '你好！' }]);
  });

  it('treats text followed by a new assistant message (no tool) as interim', () => {
    const events = runClaude([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '第一段' }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '第二段' }] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(pick(events)).toEqual([
      { type: 'stage_message', content: '第一段' },
      { type: 'final_text', content: '第二段' },
    ]);
  });

  it('dedupes a final answer identical to a delivered interim message', () => {
    const events = runClaude([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '处理完成。' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: ' 处理完成。\n' }] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(events.filter((e) => e.type === 'final_text')).toEqual([]);
    expect(events.filter((e) => e.type === 'stage_message')).toHaveLength(1);
  });

  it('caps interim messages per turn and keeps the overflow as normal text', () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'text', text: `step ${i}` }] } });
      lines.push({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] } });
    }
    lines.push({ type: 'result', subtype: 'success' });
    const events = runClaude(lines, new ClaudeStructuralInterim(new InterimBudget(2)));
    expect(events.filter((e) => e.type === 'stage_message').map((e) => (e as { content: string }).content)).toEqual([
      'step 0',
      'step 1',
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual([
      'step 2',
      'step 3',
    ]);
  });

  it('passes subagent text through as normal text', () => {
    const events = runClaude([
      { type: 'assistant', parent_tool_use_id: 'toolu_task', message: { id: 's1', content: [{ type: 'text', text: 'sub' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(pick(events)).toEqual([
      { type: 'text', delta: 'sub' },
      { type: 'final_text', content: 'done' },
    ]);
  });

  it('strips stray stage_message markers instead of leaking them', () => {
    const events = runClaude([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '<stage_message>先看看</stage_message>' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success' },
    ]);
    expect(pick(events)[0]).toEqual({ type: 'stage_message', content: '先看看' });
  });

  it('keeps held text as plain text when the stream ends without result', () => {
    const events = runClaude([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '半截回答' }] } },
    ]);
    expect(pick(events)).toEqual([{ type: 'text', delta: '半截回答' }]);
  });
});

describe('Codex structural interim messages', () => {
  const codexTurn = [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '我先看一下目录。' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '目录里只有 a.ts。' } },
    { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 } },
  ];

  it('turns non-final agent messages into interim messages', () => {
    const t = new CodexJsonlTranslator({ structuralInterim: true });
    const events = codexTurn.flatMap((e) => t.translate(e));
    expect(events.filter((e) => ['stage_message', 'text', 'final_text'].includes(e.type))).toEqual([
      { type: 'stage_message', content: '我先看一下目录。' },
      { type: 'final_text', content: '目录里只有 a.ts。' },
    ]);
  });

  it('keeps legacy inline text without the option', () => {
    const t = new CodexJsonlTranslator();
    const events = codexTurn.flatMap((e) => t.translate(e));
    expect(events.filter((e) => e.type === 'stage_message')).toEqual([]);
    expect(events).toContainEqual({ type: 'text', delta: '我先看一下目录。' });
  });

  it('dedupes a final answer identical to an interim message', () => {
    const t = new CodexJsonlTranslator({ structuralInterim: true });
    const events = [
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '好了' } },
      { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'true' } },
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: '好了 ' } },
      { type: 'turn.completed' },
    ].flatMap((e) => t.translate(e));
    expect(events.filter((e) => e.type === 'final_text')).toEqual([]);
  });

  it('keeps the pending message as text on turn.failed', () => {
    const t = new CodexJsonlTranslator({ structuralInterim: true });
    t.translate({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '做到一半' } });
    const events = t.translate({ type: 'turn.failed', error: { message: 'boom' } });
    expect(events[0]).toEqual({ type: 'text', delta: '做到一半' });
  });
});

describe('interim messages prompt and config', () => {
  it('uses the short structural prompt instead of the marker protocol', () => {
    const structural = buildBridgeSystemPrompt(undefined, 'structural');
    expect(structural).toContain(STRUCTURAL_INTERIM_PROMPT);
    expect(structural).not.toContain('<stage_message>');
    expect(buildBridgeSystemPrompt(undefined, 'marker')).toContain(CLAUDE_STAGE_MESSAGE_PROMPT);
    expect(buildBridgeSystemPrompt(undefined)).toContain(CLAUDE_STAGE_MESSAGE_PROMPT);
    const off = buildBridgeSystemPrompt(undefined, 'off');
    expect(off).not.toContain(STRUCTURAL_INTERIM_PROMPT);
    expect(off).not.toContain('<stage_message>');
  });

  it('defaults to structural and accepts explicit modes', () => {
    const cfg = (interimMessages?: unknown) => ({ preferences: { interimMessages } }) as unknown as AppConfig;
    expect(getInterimMessagesMode(cfg())).toBe('structural');
    expect(getInterimMessagesMode(cfg('bogus'))).toBe('structural');
    expect(getInterimMessagesMode(cfg('marker'))).toBe('marker');
    expect(getInterimMessagesMode(cfg('off'))).toBe('off');
  });
});

import type { AgentEvent } from '../types';
import { StageMessageParser } from '../stage-message';
import type { ClaudeStructuralInterim } from '../interim-messages';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { id?: string; content?: ContentBlock[] };
  /** Set on subagent (Task) output; null/absent for the main session. */
  parent_tool_use_id?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  yield* translateEventWithStageMessages(raw, new StageMessageParser());
}

/**
 * Translate one stream-json line. `stageMessages` handles the legacy
 * `<stage_message>` marker protocol; when `structural` is given (interim mode
 * `structural`), main-session text is routed through it instead so text that
 * precedes a tool call becomes a `stage_message` and the text left at
 * `result` becomes `final_text`.
 */
export function* translateEventWithStageMessages(
  raw: unknown,
  stageMessages: StageMessageParser,
  structural?: ClaudeStructuralInterim,
): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    const main = structural && !evt.parent_tool_use_id ? structural : undefined;
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        if (main) yield* main.text(block.text, evt.message.id);
        else yield* stageMessages.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        if (main) yield* main.toolUse();
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    yield* stageMessages.finish();
    if (structural) yield* structural.final();
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

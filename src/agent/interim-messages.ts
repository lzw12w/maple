import type { AgentEvent } from './types';
import { STAGE_MESSAGE_CLOSE, STAGE_MESSAGE_OPEN } from './stage-message';

/**
 * How mid-turn assistant text reaches the chat as standalone messages.
 *
 * - `structural` (IM default): text the agent writes *before* a tool call (or
 *   before it continues with another assistant message) is sent as its own
 *   Feishu message, Hermes-style. The final answer is whatever text is left
 *   when the turn completes. No prompt protocol is required.
 * - `marker`: legacy `<stage_message>` protocol — the model opts in per beat.
 * - `off`: no interim messages; all text stays in the normal reply.
 */
export type InterimMessagesMode = 'structural' | 'marker' | 'off';

export const DEFAULT_INTERIM_MESSAGES_MODE: InterimMessagesMode = 'structural';

export function isInterimMessagesMode(value: unknown): value is InterimMessagesMode {
  return value === 'structural' || value === 'marker' || value === 'off';
}

/** Flood guard: past this many interim messages per run, text stays inline. */
export const DEFAULT_MAX_INTERIM_MESSAGES = 8;
/** Over-long pre-tool text stays in the normal reply instead of a chat bubble. */
export const DEFAULT_MAX_INTERIM_MESSAGE_CHARS = 4000;

/** Short guidance used instead of the marker protocol in `structural` mode. */
export const STRUCTURAL_INTERIM_PROMPT = `## 飞书进度消息

你在调用工具之前写的文字，会被 Bridge 立即作为一条独立飞书消息发给用户；最后一次不调用工具的回复就是最终答案，由 Bridge 单独发送。
- 简单或对话类问题：直接回答，不要调用工具前先铺垫。
- 需要动手的任务：第一次调用工具前用一两句话说明要做什么；之后只在有真实进展、需要决策或遇到阻塞时，在下一次调用工具前简短说明。
- 不要逐条播报命令或重试，不要在最终答案里重复已经发过的进度。
`;

const MARKER_TAG_RE = new RegExp(`${escapeRe(STAGE_MESSAGE_OPEN)}|${escapeRe(STAGE_MESSAGE_CLOSE)}`, 'g');

/** Drop stray `<stage_message>` tags (e.g. a resumed session that learned them). */
export function stripStageMarkers(text: string): string {
  return text.replace(MARKER_TAG_RE, '');
}

export function normalizeInterimText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Per-run budget + dedupe shared by the Claude and Codex structural paths.
 * Decides whether a completed pre-tool text becomes a `stage_message` or
 * stays as ordinary `text`, and remembers what was delivered so the final
 * answer is not posted twice.
 */
export class InterimBudget {
  private emitted = 0;
  private readonly delivered = new Set<string>();

  constructor(
    private readonly maxMessages = DEFAULT_MAX_INTERIM_MESSAGES,
    private readonly maxChars = DEFAULT_MAX_INTERIM_MESSAGE_CHARS,
  ) {}

  /** Classify a completed non-final text. Empty text yields nothing. */
  interim(text: string): AgentEvent[] {
    const content = text.trim();
    if (!content) return [];
    const key = normalizeInterimText(content);
    if (this.delivered.has(key)) return [];
    if (this.emitted < this.maxMessages && content.length <= this.maxChars) {
      this.emitted += 1;
      this.delivered.add(key);
      return [{ type: 'stage_message', content }];
    }
    return [{ type: 'text', delta: text }];
  }

  /** True when `text` is identical to an interim message already sent. */
  wasDelivered(text: string): boolean {
    const key = normalizeInterimText(text);
    return key !== '' && this.delivered.has(key);
  }
}

/**
 * Structural interim detection for Claude Code `--output-format stream-json`.
 *
 * Claude Code emits one `assistant` event per completed content block; blocks
 * of the same API message share `message.id` (text block, then tool_use
 * block). Text is therefore held until the next main-thread signal:
 *   - a `tool_use` block, or a new assistant message → the held text was
 *     commentary before more work → interim message;
 *   - the `result` event → the held text is the final answer (`final_text`);
 *   - abnormal stream end → flushed as plain `text` (kept, never dropped).
 * Subagent output (`parent_tool_use_id` set) passes through untouched.
 */
export class ClaudeStructuralInterim {
  private pending: string[] = [];
  private pendingMessageId: string | undefined;
  private readonly budget: InterimBudget;

  constructor(budget = new InterimBudget()) {
    this.budget = budget;
  }

  text(text: string, messageId: string | undefined): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (this.pending.length > 0 && messageId !== undefined && this.pendingMessageId !== undefined && messageId !== this.pendingMessageId) {
      out.push(...this.flushInterim());
    }
    this.pending.push(stripStageMarkers(text));
    this.pendingMessageId = messageId;
    return out;
  }

  /** Call before yielding a main-thread tool_use. */
  toolUse(): AgentEvent[] {
    return this.flushInterim();
  }

  /** Call on the `result` event: held text is the final answer. */
  final(): AgentEvent[] {
    const text = this.take();
    if (!text.trim()) return [];
    if (this.budget.wasDelivered(text)) return [];
    return [{ type: 'final_text', content: text.trim() }];
  }

  /** Stream ended without `result`: keep held text visible as ordinary text. */
  finish(): AgentEvent[] {
    const text = this.take();
    return text ? [{ type: 'text', delta: text }] : [];
  }

  private flushInterim(): AgentEvent[] {
    const text = this.take();
    return text ? this.budget.interim(text) : [];
  }

  private take(): string {
    const text = this.pending.join('\n\n');
    this.pending = [];
    this.pendingMessageId = undefined;
    return text;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

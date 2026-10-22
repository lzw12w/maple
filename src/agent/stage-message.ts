import type { AgentEvent } from './types';

export const STAGE_MESSAGE_OPEN = '<stage_message>';
export const STAGE_MESSAGE_CLOSE = '</stage_message>';

export const CLAUDE_STAGE_MESSAGE_PROMPT = `## 飞书进度消息

Bridge 会把你用标记包裹的文字立即作为一条独立飞书消息发出，让用户像看实时聊天一样知道进展；标记和其中文字不会进入最终答案。最终答案始终由 Bridge 自动发送，所以这些标记只用来传递中间信号，不要把最终结论放进标记。

\`\`\`text
<stage_message>收到，我先看下相关配置。</stage_message>
\`\`\`

何时发送：
- 能直接回答的简单或对话类问题：不要使用标记，直接给最终答案，不要把一句话硬拆成两条。
- 需要实际动手的任务（检索、读文件、运行命令、修改代码、多步处理）：在第一次工具调用前先发一条简短确认，并说清第一个具体动作。
- 处理过程中只在有意义的节点追加：某个步骤完成、拿到真实结果、需要用户决策、遇到阻塞、或改变方案。

发送原则：
- 每条通常一两句话、不超过 500 字，具体说明发现了什么或当前状态，不要重复“还在处理 X”这类空话。
- 不要逐条播报命令、重试或小的自我纠错；把这类机械过程合并进下一条真实进展，或直接省略。
- 遇到失败或阻塞，用一两句话说明问题和最可能的下一步，不要预先抛编号排查清单，也不要提前编造结论。
- 一轮通常 1～4 条：简单任务 0 条，只有确实存在多个节点时才增加，绝不为发而发。
- 标记必须完整；最终答案写在标记之外，按正常回复输出。
`;

// Flood guard only: the prompt asks Claude to aim for 1-4 beats, while this
// hard cap stops a runaway marker stream from spamming the chat.
const DEFAULT_MAX_STAGE_MESSAGES = 8;
const DEFAULT_MAX_STAGE_MESSAGE_CHARS = 500;

/**
 * Extract explicit progress-marker messages from Claude's streamed text.
 *
 * The parser is deliberately stateful: Claude may split either a marker or
 * its body across multiple assistant messages, and a run may contain several
 * progress beats. Complete markers become `stage_message` events and are
 * removed from the normal answer stream. Markers beyond the flood cap and
 * incomplete markers are emitted as ordinary text so malformed model output
 * never disappears.
 */
export class StageMessageParser {
  private buffer = '';
  private emitted = 0;

  constructor(
    private readonly maxMessages = DEFAULT_MAX_STAGE_MESSAGES,
    private readonly maxChars = DEFAULT_MAX_STAGE_MESSAGE_CHARS,
  ) {}

  push(delta: string): AgentEvent[] {
    if (!delta) return [];
    this.buffer += delta;
    return this.drain(false);
  }

  finish(): AgentEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): AgentEvent[] {
    const out: AgentEvent[] = [];

    for (;;) {
      const openAt = this.buffer.indexOf(STAGE_MESSAGE_OPEN);
      if (openAt === -1) {
        if (final) {
          this.emitText(out, this.buffer);
          this.buffer = '';
        } else {
          const keep = longestOpeningPrefixSuffix(this.buffer);
          const emitEnd = this.buffer.length - keep;
          this.emitText(out, this.buffer.slice(0, emitEnd));
          this.buffer = this.buffer.slice(emitEnd);
        }
        return out;
      }

      if (openAt > 0) {
        this.emitText(out, this.buffer.slice(0, openAt));
        this.buffer = this.buffer.slice(openAt);
      }

      const closeAt = this.buffer.indexOf(STAGE_MESSAGE_CLOSE, STAGE_MESSAGE_OPEN.length);
      if (closeAt === -1) {
        const bodyLength = this.buffer.length - STAGE_MESSAGE_OPEN.length;
        if (final || bodyLength > this.maxChars) {
          // Malformed or unreasonably large marker: preserve it as visible text
          // rather than buffering forever or silently discarding model output.
          this.emitText(out, STAGE_MESSAGE_OPEN);
          this.buffer = this.buffer.slice(STAGE_MESSAGE_OPEN.length);
          continue;
        }
        return out;
      }

      const raw = this.buffer.slice(STAGE_MESSAGE_OPEN.length, closeAt);
      this.buffer = this.buffer.slice(closeAt + STAGE_MESSAGE_CLOSE.length);
      const content = raw.trim();

      if (!content) continue;
      if (this.emitted < this.maxMessages && content.length <= this.maxChars) {
        this.emitted += 1;
        out.push({ type: 'stage_message', content });
      } else {
        // Preserve markers past the flood cap (or over-long bodies) as normal
        // answer text, minus protocol tags.
        this.emitText(out, raw);
      }
    }
  }

  private emitText(out: AgentEvent[], text: string): void {
    if (text) out.push({ type: 'text', delta: text });
  }
}

function longestOpeningPrefixSuffix(value: string): number {
  const max = Math.min(value.length, STAGE_MESSAGE_OPEN.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(STAGE_MESSAGE_OPEN.slice(0, length))) return length;
  }
  return 0;
}

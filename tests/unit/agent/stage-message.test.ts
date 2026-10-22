import { describe, expect, it } from 'vitest';
import { StageMessageParser } from '../../../src/agent/stage-message';

describe('StageMessageParser', () => {
  it('extracts a progress message and keeps surrounding answer text', () => {
    const parser = new StageMessageParser();

    expect(parser.push('before\n<stage_message>收到，我先检查。</stage_message>\nafter')).toEqual([
      { type: 'text', delta: 'before\n' },
      { type: 'stage_message', content: '收到，我先检查。' },
      { type: 'text', delta: '\nafter' },
    ]);
  });

  it('parses tags and bodies split across stream chunks', () => {
    const parser = new StageMessageParser();

    expect(parser.push('prefix<stage_mes')).toEqual([{ type: 'text', delta: 'prefix' }]);
    expect(parser.push('sage>收到，我先')).toEqual([]);
    expect(parser.push('定位。</stage_message>tail')).toEqual([
      { type: 'stage_message', content: '收到，我先定位。' },
      { type: 'text', delta: 'tail' },
    ]);
  });

  it('extracts several progress beats in one run', () => {
    const parser = new StageMessageParser();

    expect(
      parser.push(
        '<stage_message>收到，我先看配置。</stage_message>' +
          '<stage_message>找到了，鉴权来自侧边栏查询。</stage_message>' +
          '<stage_message>这里失败了，我换更安全的重试方式。</stage_message>' +
          '最终答案',
      ),
    ).toEqual([
      { type: 'stage_message', content: '收到，我先看配置。' },
      { type: 'stage_message', content: '找到了，鉴权来自侧边栏查询。' },
      { type: 'stage_message', content: '这里失败了，我换更安全的重试方式。' },
      { type: 'text', delta: '最终答案' },
    ]);
  });

  it('stops forwarding at the flood cap and preserves later content as answer text', () => {
    const parser = new StageMessageParser(2);

    expect(
      parser.push(
        '<stage_message>第一条</stage_message><stage_message>第二条</stage_message>' +
          '<stage_message>第三条</stage_message>最终答案',
      ),
    ).toEqual([
      { type: 'stage_message', content: '第一条' },
      { type: 'stage_message', content: '第二条' },
      { type: 'text', delta: '第三条' },
      { type: 'text', delta: '最终答案' },
    ]);
  });

  it('flushes an incomplete marker as normal text on finish', () => {
    const parser = new StageMessageParser();

    expect(parser.push('answer <stage_message>unfinished')).toEqual([
      { type: 'text', delta: 'answer ' },
    ]);
    expect(parser.finish()).toEqual([
      { type: 'text', delta: '<stage_message>' },
      { type: 'text', delta: 'unfinished' },
    ]);
  });
});

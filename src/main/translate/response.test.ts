import { describe, expect, test } from 'vitest'
import { parseChatResponse, stripReasoning } from './response'

describe('parseChatResponse', () => {
  test('openai string content and usage', () => {
    const reply = parseChatResponse('openai', {
      choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    })
    expect(reply).toEqual({ text: '你好', finish: 'complete', usage: { input: 1, output: 2 } })
  })

  test('openai content array, think tags, truncated and refused', () => {
    expect(
      parseChatResponse('openai', {
        choices: [{ message: { content: [{ type: 'text', text: '<think>x</think>\n译' }] } }],
      }).text,
    ).toBe('译')
    expect(
      parseChatResponse('openai', {
        choices: [{ message: { content: 'a' }, finish_reason: 'length' }],
      }).finish,
    ).toBe('truncated')
    expect(
      parseChatResponse('openai', {
        choices: [{ message: { content: '', refusal: 'nope' }, finish_reason: 'stop' }],
      }).finish,
    ).toBe('refused')
  })

  test('anthropic and gemini', () => {
    expect(
      parseChatResponse('anthropic', {
        content: [{ type: 'text', text: '甲' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    ).toEqual({ text: '甲', finish: 'truncated', usage: { input: 3, output: 4 } })
    expect(parseChatResponse('gemini', { promptFeedback: { blockReason: 'SAFETY' } }).finish).toBe(
      'refused',
    )
    expect(
      parseChatResponse('gemini', {
        candidates: [
          {
            content: { parts: [{ thought: true, text: 'hid' }, { text: '乙' }] },
            finishReason: 'STOP',
          },
        ],
      }).text,
    ).toBe('乙')
  })

  test('200 body with error object throws', () => {
    expect(() => parseChatResponse('openai', { error: { message: 'nope' } })).toThrow(/nope/)
  })
})

test('stripReasoning only strips a leading think block', () => {
  expect(stripReasoning('  <thinking>abc</thinking>\n正文')).toBe('正文')
  expect(stripReasoning('正文<think>x</think>')).toBe('正文<think>x</think>')
})

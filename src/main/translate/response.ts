export type Finish = 'complete' | 'truncated' | 'refused'

export type ChatReply = {
  text: string
  finish: Finish
  usage?: { input: number; output: number }
}

const THINK_RE = /^\s*<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/i

export function stripReasoning(text: string): string {
  return text.replace(THINK_RE, '')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const rec = asRecord(item)
    if (!rec) continue
    if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text)
    else if (typeof rec.text === 'string' && rec.thought !== true) parts.push(rec.text)
  }
  return parts.join('')
}

export function parseChatResponse(
  type: 'openai' | 'azure' | 'anthropic' | 'gemini',
  json: unknown,
): ChatReply {
  const root = asRecord(json) ?? {}
  if (asRecord(root.error)) {
    const err = asRecord(root.error)
    const message = typeof err?.message === 'string' ? err.message : JSON.stringify(root.error)
    throw new Error(message)
  }

  if (type === 'anthropic') {
    const parts = Array.isArray(root.content) ? root.content : []
    const text = parts
      .map((part) => {
        const rec = asRecord(part)
        return rec?.type === 'text' && typeof rec.text === 'string' ? rec.text : ''
      })
      .join('')
    const stop = root.stop_reason
    let finish: Finish = 'complete'
    if (stop === 'max_tokens') finish = 'truncated'
    else if (stop === 'refusal') finish = 'refused'
    const usageRec = asRecord(root.usage)
    const usage =
      usageRec &&
      typeof usageRec.input_tokens === 'number' &&
      typeof usageRec.output_tokens === 'number'
        ? { input: usageRec.input_tokens, output: usageRec.output_tokens }
        : undefined
    return withUsage({ text: stripReasoning(text), finish }, usage)
  }

  if (type === 'gemini') {
    const feedback = asRecord(root.promptFeedback)
    if (feedback?.blockReason) {
      return { text: '', finish: 'refused' }
    }
    const candidates = Array.isArray(root.candidates) ? root.candidates : []
    const first = asRecord(candidates[0])
    const content = asRecord(first?.content)
    const parts = Array.isArray(content?.parts) ? content.parts : []
    const text = parts
      .map((part) => {
        const rec = asRecord(part)
        if (!rec || rec.thought === true) return ''
        return typeof rec.text === 'string' ? rec.text : ''
      })
      .join('')
    const reason = first?.finishReason
    let finish: Finish = 'complete'
    if (reason === 'MAX_TOKENS') finish = 'truncated'
    else if (
      reason === 'SAFETY' ||
      reason === 'RECITATION' ||
      reason === 'BLOCKLIST' ||
      reason === 'PROHIBITED_CONTENT' ||
      reason === 'SPII' ||
      reason === 'IMAGE_SAFETY'
    ) {
      finish = 'refused'
    }
    const usageRec = asRecord(root.usageMetadata)
    const usage =
      usageRec &&
      typeof usageRec.promptTokenCount === 'number' &&
      typeof usageRec.candidatesTokenCount === 'number'
        ? { input: usageRec.promptTokenCount, output: usageRec.candidatesTokenCount }
        : undefined
    return withUsage({ text: stripReasoning(text), finish }, usage)
  }

  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = asRecord(choices[0])
  const message = asRecord(choice?.message)
  const text = contentText(message?.content)
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : ''
  let finish: Finish = 'complete'
  if (
    finishReason === 'length' ||
    finishReason === 'max_tokens' ||
    finishReason === 'model_length'
  ) {
    finish = 'truncated'
  } else if (
    finishReason === 'content_filter' ||
    finishReason === 'safety' ||
    finishReason === 'sensitive' ||
    finishReason === 'refusal' ||
    (text.length === 0 && typeof message?.refusal === 'string' && message.refusal.length > 0)
  ) {
    finish = 'refused'
  }
  const usageRec = asRecord(root.usage)
  const usage =
    usageRec &&
    typeof usageRec.prompt_tokens === 'number' &&
    typeof usageRec.completion_tokens === 'number'
      ? { input: usageRec.prompt_tokens, output: usageRec.completion_tokens }
      : undefined
  return withUsage({ text: stripReasoning(text), finish }, usage)
}

function withUsage(reply: ChatReply, usage: ChatReply['usage']): ChatReply {
  return usage ? { ...reply, usage } : reply
}

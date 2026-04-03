import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export type SolveParams = {
  problem: string
  model: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface AISolution {
  summary: string
  approach: string
  code: { javascript: string; java: string; python: string }
  complexity: { time: string; space: string }
}

export async function solveProblem(params: SolveParams) {
  const { problem, model, reasoningEffort } = params
  const isReasoning = ['o1', 'o3', 'o4-mini'].includes(model)

  const systemPrompt = `You are an expert technical interviewer and software engineer. Solve the following coding problem.

Return ONLY a raw JSON object with this exact structure (no markdown, no code blocks):
{
  "summary": "Brief 1-2 sentence summary of the problem",
  "approach": "Clear explanation of the optimal algorithm",
  "code": {
    "javascript": "optimal javascript solution",
    "java": "optimal java solution",
    "python": "optimal python solution"
  },
  "complexity": {
    "time": "O(...)",
    "space": "O(...)"
  }
}`

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: problem },
  ]

  const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    ...(isReasoning && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(!isReasoning ? { temperature: 0.2 } : {}),
  }

  const start = Date.now()
  const completion = await openai.chat.completions.create(requestParams)
  const responseTimeMs = Date.now() - start

  const content = completion.choices[0]?.message?.content ?? '{}'
  let clean = content.trim()
  if (clean.startsWith('```json')) clean = clean.replace(/^```json\n?/, '').replace(/\n?```$/, '')
  else if (clean.startsWith('```')) clean = clean.replace(/^```\n?/, '').replace(/\n?```$/, '')

  const parsed = JSON.parse(clean) as AISolution

  return {
    result: parsed,
    tokenCount: completion.usage?.total_tokens ?? 0,
    responseTimeMs,
  }
}

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }

export async function chatWithAI(params: { messages: ChatMessage[]; model: string }) {
  const start = Date.now()
  const completion = await openai.chat.completions.create({
    model: params.model,
    messages: params.messages,
  })
  const responseTimeMs = Date.now() - start

  return {
    message: completion.choices[0]?.message?.content ?? '',
    tokenCount: completion.usage?.total_tokens ?? 0,
    responseTimeMs,
  }
}

export async function chatWithAIStream(
  params: { messages: ChatMessage[]; model: string },
  onDelta: (delta: string) => void,
  onContentDone: () => void,
): Promise<{ tokenCount: number; responseTimeMs: number }> {
  const start = Date.now()
  let tokenCount = 0

  const stream = await openai.chat.completions.create({
    model: params.model,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
  })

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content
    if (delta) onDelta(delta)

    // finish_reason='stop' means all content is done — notify caller immediately
    // so it can close the SSE connection without waiting for the usage chunk
    if (chunk.choices[0]?.finish_reason === 'stop') onContentDone()

    // usage arrives in the final chunk after finish_reason (include_usage: true)
    if (chunk.usage) tokenCount = chunk.usage.total_tokens
  }

  return { tokenCount, responseTimeMs: Date.now() - start }
}

export async function transcribeAudio(audioBuffer: Buffer, filename: string) {
  const start = Date.now()
  const file = new File([audioBuffer], filename, { type: 'audio/webm' })
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  })
  const responseTimeMs = Date.now() - start
  return { text: transcription.text, responseTimeMs }
}

export async function createRealtimeToken() {
  const session = await openai.beta.realtime.sessions.create({
    model: 'gpt-4o-realtime-preview-2024-12-17',
    voice: 'alloy',
  })
  return { clientSecret: session.client_secret.value }
}

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const WIRE_FORMAT = 'anchored-pro-wire/v1'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'api-key',
])

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const RESPONSE_HEADERS_TO_SKIP = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
])

function headerValue(value) {
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/** Convert Headers, IncomingHttpHeaders, or a plain object to lowercase strings. */
export function headerObject(headers) {
  const result = {}
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value)
    })
    return result
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) result[String(key).toLowerCase()] = headerValue(value)
  }
  return result
}

/** Keep the capture useful without persisting credentials or cookies. */
export function redactHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headerObject(headers))) {
    result[key] = SENSITIVE_HEADERS.has(key) ? '<redacted>' : value
  }
  return result
}

/** Headers safe to pass from the proxy to the real upstream. */
export function forwardHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headerObject(headers))) {
    if (!HOP_BY_HOP_HEADERS.has(key)) result[key] = value
  }
  return result
}

/** Rebuild a captured request with an explicit environment-provided API key. */
export function replayHeaders(headers, apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('an API key is required for replay')
  }
  const result = {}
  for (const [key, value] of Object.entries(headerObject(headers))) {
    if (HOP_BY_HOP_HEADERS.has(key) || SENSITIVE_HEADERS.has(key)) continue
    result[key] = value
  }
  result.authorization = `Bearer ${apiKey}`
  return result
}

/** Response headers that can be copied after fetch has decoded the body. */
export function responseHeaders(headers) {
  const result = {}
  for (const [key, value] of Object.entries(headerObject(headers))) {
    if (!RESPONSE_HEADERS_TO_SKIP.has(key)) result[key] = value
  }
  return result
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function safeUrl(value) {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.hash = ''
  return url.toString()
}

/**
 * Join an incoming proxy path to an upstream base without accidentally
 * discarding the base path (for example, /zen/go/v1).
 */
export function upstreamUrl(baseUrl, requestUrl, stripPrefix = '') {
  const base = new URL(baseUrl)
  const incoming = new URL(requestUrl, 'http://capture.invalid')
  let incomingPath = incoming.pathname

  if (stripPrefix && incomingPath.startsWith(stripPrefix)) {
    incomingPath = incomingPath.slice(stripPrefix.length) || '/'
  }

  const basePath = base.pathname.replace(/\/+$/, '')
  const requestPath = incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`
  base.pathname = `${basePath}${requestPath}`.replace(/\/{2,}/g, '/')
  base.search = incoming.search
  base.hash = ''
  return base.toString()
}

export async function readRequestBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      throw new Error(`request body exceeds ${maxBytes} byte capture limit`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readResponseBody(response, onChunk) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buffer = Buffer.from(value)
      chunks.push(buffer)
      if (onChunk) onChunk(buffer)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function textValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textValue).join('')
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.value === 'string') return value.value
  }
  return ''
}

function addMessage(message, state) {
  if (!message || typeof message !== 'object') return
  for (const key of ['reasoning_content', 'reasoning', 'analysis']) {
    const value = textValue(message[key])
    if (value) state.reasoning.push(value)
  }
  const content = textValue(message.content)
  if (content) state.content.push(content)
  for (const toolCall of message.tool_calls ?? []) {
    const name = toolCall?.function?.name
    if (typeof name === 'string' && name.length > 0) state.toolNames.add(name)
  }
}

function addPayload(payload, state) {
  for (const choice of payload?.choices ?? []) {
    addMessage(choice?.delta ?? choice?.message, state)
    if (choice?.finish_reason) state.finishReasons.add(choice.finish_reason)
  }
}

/** Parse OpenAI-compatible SSE data records, preserving only model-visible text. */
export function parseSse(text) {
  const payloads = []
  let dataLines = []
  const flush = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    dataLines = []
    if (!data || data === '[DONE]') return
    try {
      payloads.push(JSON.parse(data))
    } catch {
      // A malformed upstream event is represented in the response hash, but it
      // cannot contribute a reliable reasoning classification.
    }
  }

  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line === '') {
      flush()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()
  return payloads
}

export function classifyReasoning(reasoning) {
  const first = String(reasoning ?? '').trimStart().slice(0, 320)
  const startsWithLetMe = /^(?:(?:first|okay|alright|well)[,:\s]+)?let me\b/i.test(first)
  const containsLetMe = /\blet me\b/i.test(first)
  const startsCollective = /^(?:(?:first|okay|alright|well)[,:\s]+)?(?:we\b|let['\u2019]s\b|\u6211\u4eec)/i.test(first)
  const language = /[\u3400-\u9fff]/.test(first) ? 'cjk' : (/[A-Za-z]/.test(first) ? 'latin' : 'other')
  return { first, startsWithLetMe, containsLetMe, startsCollective, language }
}

export function modelClaims(text) {
  const claims = []
  const pattern = /\b(?:i(?:'m| am)|this is)\s+(?:a|an)?\s*(?:model\s+)?(Claude|DeepSeek)\b/gi
  for (const match of String(text ?? '').matchAll(pattern)) {
    claims.push(match[1])
  }
  return [...new Set(claims)]
}

/** Extract comparable public reasoning/content fields from SSE or JSON output. */
export function transcriptFromResponse(body, contentType = '') {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
  const state = { reasoning: [], content: [], toolNames: new Set(), finishReasons: new Set() }
  const isSse = /text\/event-stream/i.test(contentType) || text.includes('\ndata:') || text.startsWith('data:')

  if (isSse) {
    for (const payload of parseSse(text)) addPayload(payload, state)
  } else {
    try {
      addPayload(JSON.parse(text), state)
    } catch {
      // Non-JSON errors remain represented by the body hash and status code.
    }
  }

  const reasoning = state.reasoning.join('')
  const content = state.content.join('')
  return {
    streaming: isSse,
    reasoning,
    content,
    toolNames: [...state.toolNames],
    finishReasons: [...state.finishReasons],
    classification: classifyReasoning(reasoning),
    modelClaims: modelClaims(`${reasoning}\n${content}`),
  }
}

export function responseSummary(status, headers, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '')
  const normalizedHeaders = headerObject(headers)
  return {
    status,
    headers: redactHeaders(normalizedHeaders),
    bodyBytes: buffer.length,
    bodySha256: sha256(buffer),
    transcript: transcriptFromResponse(buffer, normalizedHeaders['content-type'] ?? ''),
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * Explicitly read one DSH-managed credential without printing or persisting it.
 * This is intentionally opt-in at the CLI layer: ordinary replay requires an
 * inherited environment variable and never touches the credential store.
 */
export async function readDshCredential(reference, credentialsPath = undefined) {
  if (typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
    throw new Error('credential reference must be a POSIX-style environment variable name')
  }
  const path = credentialsPath ?? join(process.env.DSH_HOME ?? homedir(), '.dsh', '.credentials.yaml')
  let parseDocument
  try {
    const dshRequire = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json');
    ({ parseDocument } = await import(dshRequire.resolve('yaml')))
  } catch (error) {
    throw new Error(`DSH YAML parser is unavailable (${String(error?.message ?? error)}); provide the API key through the environment instead`)
  }

  let document
  try {
    document = parseDocument(await readFile(path, 'utf8'), { prettyErrors: false, uniqueKeys: true })
  } catch {
    throw new Error(`cannot read DSH credentials at ${path}`)
  }
  if (document.errors.length > 0) throw new Error(`DSH credentials at ${path} are invalid`)
  const entries = document.toJS() ?? {}
  const value = entries[reference]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`DSH credential ${reference} is not configured`)
  }
  return value
}

export function captureFileName(prefix, sequence, body) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'record'
  return `${safePrefix}-${stamp}-${process.pid}-${sequence}-${sha256(body).slice(0, 12)}.json`
}

export function parseArgs(argv) {
  const values = new Map()
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const key = token.slice(2, equals === -1 ? undefined : equals)
    let value
    if (equals !== -1) {
      value = token.slice(equals + 1)
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1]
      index += 1
    } else {
      value = true
    }
    const existing = values.get(key)
    values.set(key, existing === undefined ? [value] : [...existing, value])
  }
  return {
    positionals,
    get(key, fallback = undefined) {
      const value = values.get(key)?.at(-1)
      return value === undefined ? fallback : value
    },
    all(key) {
      return values.get(key) ?? []
    },
  }
}

export function integerOption(value, name, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

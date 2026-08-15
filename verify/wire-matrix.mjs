import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WIRE_FORMAT,
  captureFileName,
  integerOption,
  parseArgs,
  readDshCredential,
  readJson,
  writeJson,
} from './wire-common.mjs'
import { replayCapture } from './wire-replay.mjs'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'api-key',
])

function assertCapture(capture) {
  if (capture?.format !== WIRE_FORMAT || capture?.kind !== 'capture') {
    throw new Error('input is not an anchored-pro wire capture')
  }
  if (typeof capture.request?.bodyText !== 'string') throw new Error('capture has no request body')
}

function pathParts(path) {
  if (typeof path !== 'string' || path.length === 0 || path.split('.').some((part) => part.length === 0)) {
    throw new Error(`invalid JSON path: ${JSON.stringify(path)}`)
  }
  return path.split('.')
}

function parentFor(root, path, create) {
  const parts = pathParts(path)
  const leaf = parts.pop()
  let current = root
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`JSON path does not resolve to an object: ${path}`)
    }
    if (!(part in current)) {
      if (!create) return [undefined, leaf]
      current[part] = {}
    }
    current = current[part]
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`JSON path does not resolve to an object: ${path}`)
  }
  return [current, leaf]
}

/** Apply a minimal, explicit variant to a captured OpenAI-compatible request. */
export function variantRequest(capture, variant) {
  assertCapture(capture)
  if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
    throw new Error('each matrix variant must be an object')
  }
  if (typeof variant.name !== 'string' || variant.name.length === 0) {
    throw new Error('each matrix variant needs a non-empty name')
  }

  const headers = { ...(capture.request.headers ?? {}) }
  for (const rawName of variant.dropHeaders ?? []) {
    if (typeof rawName !== 'string') throw new Error('dropHeaders entries must be strings')
    delete headers[rawName.toLowerCase()]
  }
  for (const [rawName, value] of Object.entries(variant.setHeaders ?? {})) {
    const name = rawName.toLowerCase()
    if (SENSITIVE_HEADERS.has(name)) throw new Error(`matrix variants cannot set sensitive header ${name}`)
    if (typeof value !== 'string') throw new Error(`matrix header ${name} must be a string`)
    headers[name] = value
  }

  const needsBodyRewrite = (variant.deleteJson?.length ?? 0) > 0 || Object.keys(variant.setJson ?? {}).length > 0
  if (!needsBodyRewrite) return { headers, bodyText: capture.request.bodyText }

  let body
  try {
    body = JSON.parse(capture.request.bodyText)
  } catch {
    throw new Error('the capture body is not JSON and cannot be changed by this matrix')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('the capture body must be a JSON object')
  }

  for (const path of variant.deleteJson ?? []) {
    const [parent, leaf] = parentFor(body, path, false)
    if (parent) delete parent[leaf]
  }
  for (const [path, value] of Object.entries(variant.setJson ?? {})) {
    const [parent, leaf] = parentFor(body, path, true)
    parent[leaf] = value
  }
  return { headers, bodyText: JSON.stringify(body) }
}

function help() {
  return [
    'Usage: node verify/wire-matrix.mjs --capture FILE --matrix FILE --output DIR [options]',
    '',
    'The matrix file is a JSON array. Each variant supports:',
    '  name: string',
    '  repeat: positive integer (defaults to --repeat)',
    '  dropHeaders: ["user-agent"]',
    '  setHeaders: { "user-agent": "value" }',
    '  deleteJson: ["tools", "thinking"]',
    '  setJson: { "max_tokens": 256000, "reasoning_effort": "high" }',
    '',
    'Options:',
    '  --api-key-env NAME      Environment variable with API key (default: OPENCODE_GO_API_KEY)',
    '  --dsh-credentials [P]   Explicitly read the same reference from DSH credentials',
    '  --repeat N              Default replays per variant (default: 1)',
    '  --target-base URL       Override the capture target base URL',
    '  --strip-prefix PATH     Override the captured proxy path stripping',
    '  --timeout-ms N          Per-request timeout (default: 300000)',
  ].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.get('help', false) !== false) {
    process.stdout.write(`${help()}\n`)
    return
  }

  const capturePath = args.get('capture')
  const matrixPath = args.get('matrix')
  const outputDir = args.get('output')
  if (typeof capturePath !== 'string' || typeof matrixPath !== 'string' || typeof outputDir !== 'string') {
    throw new Error('--capture, --matrix, and --output are required')
  }

  const apiKeyEnv = args.get('api-key-env', 'OPENCODE_GO_API_KEY')
  const credentialPath = args.get('dsh-credentials')
  const apiKey = process.env[apiKeyEnv] ?? (credentialPath === undefined
    ? undefined
    : await readDshCredential(apiKeyEnv, credentialPath === true ? undefined : credentialPath))
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set; pass --dsh-credentials to opt in to DSH credential-store access`)

  const capture = await readJson(capturePath)
  assertCapture(capture)
  const variants = await readJson(matrixPath)
  if (!Array.isArray(variants) || variants.length === 0) throw new Error('matrix must be a non-empty JSON array')

  const defaultRepeat = integerOption(args.get('repeat'), 'repeat', 1)
  const timeoutMs = integerOption(args.get('timeout-ms'), 'timeout-ms', 300_000)
  const targetBase = args.get('target-base')
  const stripPrefix = args.get('strip-prefix')
  let sequence = 0
  let failed = false

  for (const variant of variants) {
    const request = variantRequest(capture, variant)
    const repeat = integerOption(variant.repeat, `repeat for ${variant.name}`, defaultRepeat)
    for (let index = 0; index < repeat; index += 1) {
      sequence += 1
      let result
      try {
        result = await replayCapture(capture, {
          apiKey,
          requestHeaders: request.headers,
          bodyText: request.bodyText,
          targetBase,
          stripPrefix,
          timeoutMs,
          source: basename(capturePath),
          variant: variant.name,
        })
      } catch (error) {
        failed = true
        result = {
          format: WIRE_FORMAT,
          kind: 'replay',
          replayedAt: new Date().toISOString(),
          source: basename(capturePath),
          variant: variant.name,
          error: String(error?.message ?? error),
        }
      }
      const file = `${outputDir}/${captureFileName(`matrix-${variant.name}`, sequence, request.bodyText)}`
      await writeJson(file, result)
      const status = result.response?.status ?? 'error'
      const first = result.response?.transcript?.classification?.first ?? ''
      process.stderr.write(`${variant.name} ${index + 1}/${repeat}: ${status} ${first.slice(0, 120)} -> ${file}\n`)
    }
  }

  if (failed) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`wire matrix failed: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}

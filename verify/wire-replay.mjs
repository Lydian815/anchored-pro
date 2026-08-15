import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WIRE_FORMAT,
  captureFileName,
  integerOption,
  parseArgs,
  readDshCredential,
  readJson,
  readResponseBody,
  redactHeaders,
  replayHeaders,
  responseSummary,
  safeUrl,
  sha256,
  upstreamUrl,
  writeJson,
} from './wire-common.mjs'

function assertCapture(capture) {
  if (capture?.format !== WIRE_FORMAT || capture?.kind !== 'capture') {
    throw new Error('input is not an anchored-pro wire capture')
  }
  if (typeof capture.request?.method !== 'string' || typeof capture.request?.pathAndQuery !== 'string') {
    throw new Error('capture is missing request method or path')
  }
  if (typeof capture.request?.bodyText !== 'string') {
    throw new Error('capture is missing its raw request body')
  }
}

/** Replay a saved request body without reusing or persisting a captured credential. */
export async function replayCapture(capture, options) {
  assertCapture(capture)
  const apiKey = options.apiKey
  const targetBase = options.targetBase ?? capture.proxy?.targetBase
  if (typeof targetBase !== 'string' || targetBase.length === 0) {
    throw new Error('a target base URL is required for replay')
  }
  const timeoutMs = options.timeoutMs ?? 300_000
  const target = upstreamUrl(targetBase, capture.request.pathAndQuery, options.stripPrefix ?? capture.proxy?.stripPrefix ?? '')
  const requestHeaders = options.requestHeaders ?? capture.request.headers
  const bodyText = options.bodyText ?? capture.request.bodyText
  const headers = replayHeaders(requestHeaders, apiKey)
  const response = await fetch(target, {
    method: capture.request.method,
    headers,
    body: bodyText,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await readResponseBody(response)
  return {
    format: WIRE_FORMAT,
    kind: 'replay',
    replayedAt: new Date().toISOString(),
    source: options.source ?? null,
    variant: options.variant ?? null,
    request: {
      method: capture.request.method,
      pathAndQuery: capture.request.pathAndQuery,
      target: safeUrl(target),
      headers: redactHeaders(headers),
      bodySha256: sha256(bodyText),
    },
    response: responseSummary(response.status, response.headers, body),
  }
}

function help() {
  return [
    'Usage: node verify/wire-replay.mjs --capture FILE --output DIR [options]',
    '',
    'Options:',
    '  --capture FILE          Capture file to replay (repeatable)',
    '  --output DIR            Private directory for replay records',
    '  --repeat N              Replays per capture (default: 1)',
    '  --api-key-env NAME      Environment variable with the API key',
    '                           (default: OPENCODE_GO_API_KEY)',
    '  --dsh-credentials [P]   Explicitly read the same reference from DSH credentials',
    '                           (default path: $DSH_HOME/.credentials.yaml)',
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

  const captures = [...args.all('capture'), ...args.positionals]
  const outputDir = args.get('output')
  if (captures.length === 0 || typeof outputDir !== 'string') {
    throw new Error('at least one --capture and --output are required')
  }

  const apiKeyEnv = args.get('api-key-env', 'OPENCODE_GO_API_KEY')
  const credentialPath = args.get('dsh-credentials')
  const apiKey = process.env[apiKeyEnv] ?? (credentialPath === undefined
    ? undefined
    : await readDshCredential(apiKeyEnv, credentialPath === true ? undefined : credentialPath))
  if (!apiKey) throw new Error(`${apiKeyEnv} is not set; pass --dsh-credentials to opt in to DSH credential-store access`)

  const repeat = integerOption(args.get('repeat'), 'repeat', 1)
  const timeoutMs = integerOption(args.get('timeout-ms'), 'timeout-ms', 300_000)
  const targetBase = args.get('target-base')
  const stripPrefix = args.get('strip-prefix')
  let sequence = 0
  let failed = false

  for (const capturePath of captures) {
    const capture = await readJson(capturePath)
    assertCapture(capture)
    for (let index = 0; index < repeat; index += 1) {
      sequence += 1
      let result
      try {
        result = await replayCapture(capture, {
          apiKey,
          targetBase,
          stripPrefix,
          timeoutMs,
          source: basename(capturePath),
        })
      } catch (error) {
        failed = true
        result = {
          format: WIRE_FORMAT,
          kind: 'replay',
          replayedAt: new Date().toISOString(),
          source: basename(capturePath),
          error: String(error?.message ?? error),
        }
      }
      const file = `${outputDir}/${captureFileName('replay', sequence, capture.request.bodyText)}`
      await writeJson(file, result)
      const status = result.response?.status ?? 'error'
      const first = result.response?.transcript?.classification?.first ?? ''
      process.stderr.write(`replay ${sequence}: ${status} ${first.slice(0, 120)} -> ${file}\n`)
    }
  }

  if (failed) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`wire replay failed: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}

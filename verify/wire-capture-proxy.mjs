import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  WIRE_FORMAT,
  captureFileName,
  forwardHeaders,
  integerOption,
  parseArgs,
  readRequestBody,
  readResponseBody,
  redactHeaders,
  responseHeaders,
  responseSummary,
  safeUrl,
  upstreamUrl,
  writeJson,
} from './wire-common.mjs'

const DEFAULT_MAX_BODY_BYTES = 2_000_000

function writeError(response, status, message) {
  if (!response.headersSent) {
    response.writeHead(status, { 'content-type': 'application/json' })
  }
  response.end(JSON.stringify({ error: message }))
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function portOption(value) {
  if (value === undefined) return 8787
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('--port must be an integer between 0 and 65535')
  }
  return parsed
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Start a transparent OpenAI-compatible forwarding proxy.
 *
 * The proxy stores an explicitly requested local diagnostic record, with
 * credentials redacted. It does not modify DSH, pi-ai, or the preset.
 */
export async function startCaptureProxy(options) {
  const {
    host = '127.0.0.1',
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    once = false,
    outputDir,
    stripPrefix = '',
    targetBase,
  } = options
  const port = Number(options.port ?? 8787)

  if (!outputDir) throw new Error('outputDir is required')
  if (!targetBase) throw new Error('targetBase is required')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535')

  let sequence = 0
  let completed = false
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      writeError(response, 405, 'only POST requests are captured')
      return
    }

    let body
    let record
    try {
      body = await readRequestBody(request, maxBodyBytes)
      const pathAndQuery = request.url ?? '/'
      const target = upstreamUrl(targetBase, pathAndQuery, stripPrefix)
      const requestHeaders = forwardHeaders(request.headers)
      const startedAt = new Date().toISOString()

      const upstream = await fetch(target, {
        method: request.method,
        headers: requestHeaders,
        body,
        signal: AbortSignal.timeout(300_000),
      })
      const headers = responseHeaders(upstream.headers)
      response.writeHead(upstream.status, headers)
      const upstreamBody = await readResponseBody(upstream, (chunk) => response.write(chunk))
      response.end()

      record = {
        format: WIRE_FORMAT,
        kind: 'capture',
        capturedAt: startedAt,
        proxy: {
          targetBase: safeUrl(targetBase),
          stripPrefix,
        },
        request: {
          method: request.method,
          pathAndQuery,
          headers: redactHeaders(request.headers),
          bodyText: body.toString('utf8'),
        },
        response: responseSummary(upstream.status, upstream.headers, upstreamBody),
      }
    } catch (error) {
      if (!response.writableEnded) writeError(response, 502, 'proxy could not forward the request')
      if (body) {
        record = {
          format: WIRE_FORMAT,
          kind: 'capture',
          capturedAt: new Date().toISOString(),
          proxy: {
            targetBase: safeUrl(targetBase),
            stripPrefix,
          },
          request: {
            method: request.method,
            pathAndQuery: request.url ?? '/',
            headers: redactHeaders(request.headers),
            bodyText: body.toString('utf8'),
          },
          error: String(error?.message ?? error),
        }
      }
    }

    if (record) {
      sequence += 1
      const file = `${outputDir}/${captureFileName('capture', sequence, record.request.bodyText)}`
      try {
        await writeJson(file, record)
        process.stderr.write(`captured ${record.request.method} ${record.request.pathAndQuery} -> ${file}\n`)
      } catch (error) {
        process.stderr.write(`capture write failed: ${String(error?.message ?? error)}\n`)
      }
    }

    if (once && !completed) {
      completed = true
      setImmediate(() => server.close())
    }
  })

  await listen(server, port, host)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('proxy did not bind a TCP port')
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => close(server),
  }
}

function help() {
  return [
    'Usage: node verify/wire-capture-proxy.mjs --output DIR --target-base URL [options]',
    '',
    'Options:',
    '  --host HOST             Listen host (default: 127.0.0.1)',
    '  --port PORT             Listen port (default: 8787; use 0 for ephemeral)',
    '  --strip-prefix PATH     Remove a proxy-only path prefix before forwarding',
    '  --max-body-bytes N      Refuse larger request bodies (default: 2000000)',
    '  --once                  Stop after the first completed capture',
  ].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.get('help', false) !== false) {
    process.stdout.write(`${help()}\n`)
    return
  }
  const outputDir = args.get('output')
  const targetBase = args.get('target-base')
  if (typeof outputDir !== 'string' || typeof targetBase !== 'string') {
    throw new Error('--output and --target-base are required')
  }
  const proxy = await startCaptureProxy({
    host: args.get('host', '127.0.0.1'),
    port: portOption(args.get('port')),
    outputDir,
    targetBase,
    stripPrefix: args.get('strip-prefix', ''),
    maxBodyBytes: integerOption(args.get('max-body-bytes'), 'max-body-bytes', DEFAULT_MAX_BODY_BYTES),
    once: args.get('once', false) === true,
  })
  process.stderr.write(`wire capture proxy listening at ${proxy.url}\n`)
  process.stderr.write('Capture output contains prompt and model text; keep the output directory private.\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`wire capture proxy failed: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}

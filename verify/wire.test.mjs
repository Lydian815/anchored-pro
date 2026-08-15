import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDshCredential, readJson, transcriptFromResponse } from './wire-common.mjs'
import { startCaptureProxy } from './wire-capture-proxy.mjs'
import { replayCapture } from './wire-replay.mjs'
import { variantRequest } from './wire-matrix.mjs'
import { formatMarkdown, summarizeRecords } from './wire-report.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function requestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForCapture(directory) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const entry = (await readdir(directory)).find((name) => name.startsWith('capture-'))
    if (entry) return join(directory, entry)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('proxy did not write a capture')
}

const upstreamRequests = []
const upstream = createServer(async (request, response) => {
  upstreamRequests.push({
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: await requestBody(request),
  })
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"We need to inspect the request first."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"I am DeepSeek."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(sse)
})

const directory = await mkdtemp(join(tmpdir(), 'anchored-pro-wire-'))
let proxy

try {
  const credentialsPath = join(directory, 'credentials.yaml')
  await writeFile(credentialsPath, 'OPENCODE_GO_API_KEY: fixture-secret\n', 'utf8')
  assert.equal(await readDshCredential('OPENCODE_GO_API_KEY', credentialsPath), 'fixture-secret')
  await assert.rejects(readDshCredential('MISSING_KEY', credentialsPath), /not configured/)

  await listen(upstream)
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string')
  const upstreamBase = `http://127.0.0.1:${upstreamAddress.port}`
  proxy = await startCaptureProxy({
    port: 0,
    outputDir: directory,
    targetBase: upstreamBase,
  })

  const originalBody = JSON.stringify({
    model: 'gpt-5.6-terra-pro',
    messages: [{ role: 'system', content: 'You are a helpful software engineer assistant.' }],
    stream: true,
  })
  const response = await fetch(`${proxy.url}/zen/go/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer capture-secret',
      'content-type': 'application/json',
      'user-agent': 'OpenAI-harness/0.1.0-rc.6',
    },
    body: originalBody,
  })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /reasoning_content/)

  const capturePath = await waitForCapture(directory)
  const capture = await readJson(capturePath)
  assert.equal(capture.kind, 'capture')
  assert.equal(capture.request.pathAndQuery, '/zen/go/v1/chat/completions')
  assert.equal(capture.request.bodyText, originalBody)
  assert.equal(capture.request.headers.authorization, '<redacted>')
  assert.ok(!JSON.stringify(capture).includes('capture-secret'))
  assert.equal(capture.response.transcript.classification.startsCollective, true)
  assert.deepEqual(capture.response.transcript.modelClaims, ['DeepSeek'])
  assert.equal(upstreamRequests[0].url, '/zen/go/v1/chat/completions')
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer capture-secret')

  const replay = await replayCapture(capture, {
    apiKey: 'replay-secret',
    source: 'fixture.json',
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.response.status, 200)
  assert.equal(replay.response.transcript.classification.startsCollective, true)
  assert.ok(!JSON.stringify(replay).includes('replay-secret'))
  assert.equal(upstreamRequests[1].headers.authorization, 'Bearer replay-secret')
  assert.equal(upstreamRequests[1].body, originalBody)

  const variant = variantRequest(capture, {
    name: 'without-user-agent',
    dropHeaders: ['user-agent'],
    setJson: { max_tokens: 256000 },
  })
  assert.equal(variant.headers['user-agent'], undefined)
  assert.equal(JSON.parse(variant.bodyText).max_tokens, 256000)
  assert.throws(() => variantRequest(capture, {
    name: 'invalid-secret',
    setHeaders: { authorization: 'Bearer no' },
  }), /sensitive header/)

  const letMe = transcriptFromResponse(
    'data: {"choices":[{"delta":{"reasoning_content":"First, let me inspect the files."}}]}\n\ndata: [DONE]\n\n',
    'text/event-stream',
  )
  assert.equal(letMe.classification.startsWithLetMe, true)
  assert.equal(letMe.classification.containsLetMe, true)
  assert.equal(letMe.classification.startsCollective, false)

  const report = summarizeRecords([capture, replay])
  assert.equal(report.length, 2)
  assert.equal(report.find((row) => row.arm === 'DSH capture')?.collective, 1)
  assert.equal(report.find((row) => row.arm === 'Direct replay')?.deepSeekClaims, 1)
  assert.match(formatMarkdown(report), /Anchored Pro Wire Report/)

  process.stdout.write('all anchored-pro wire tests passed\n')
} finally {
  if (proxy) await proxy.close()
  await close(upstream)
  await rm(directory, { recursive: true, force: true })
}

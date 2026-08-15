import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

// A source-local runner cannot resolve DSH's private dependencies through its
// own node_modules tree. Resolve them from the installed DSH package instead.
const dshRequire = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
const { installModelSelection } = await import(dshRequire.resolve('@deepseek-ai/dsh-agent'))
const { createUserMessage } = await import(dshRequire.resolve('@deepseek-ai/dsh-llm'))

export const name = 'anchored-pro-preset-headless-runner'
export const inject = ['agentDefaultModel', 'agentPresets', 'agents', 'sessions']

function summarize(events, firstSeq) {
  let started = false
  let text = ''
  let reason
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const nextText = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (nextText) text = nextText
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

async function run(ctx, config, io) {
  const loader = ctx.get('loader')
  if (loader) await loader.await()

  const agents = ctx.get('agents')
  const defaults = ctx.get('agentDefaultModel')
  const presets = ctx.get('agentPresets')
  const sessions = ctx.get('sessions')
  if (!agents || !defaults || !presets || !sessions) return

  const selection = defaults.currentSelection()
  const { agent } = await agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: { cwd: process.cwd(), agentPreset: config.preset },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      // Match the Web agent factory: selection first, preset composition second.
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, config.preset)
    },
  })

  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const outcome = summarize(agent.session.events, firstSeq)
  io.stdout.write(`${outcome.text}\n`)
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (!exit) throw new Error(`${name}: appExit is required`)
  if (typeof config?.task !== 'string' || config.task.trim() === '') {
    throw new Error(`${name}: task must be a non-empty string`)
  }
  if (typeof config?.preset !== 'string' || config.preset.trim() === '') {
    throw new Error(`${name}: preset must be a non-empty string`)
  }

  run(ctx, config, { stdout: process.stdout, stderr: process.stderr, exit }).catch((error) => {
    process.stderr.write(`dsh: ${String(error?.message ?? error)}\n`)
    exit(1)
  })
}

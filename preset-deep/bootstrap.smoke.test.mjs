// Smoke test for apply(): exercise the assemble hook in both phases with a
// mock ctx (no cordis needed), plus the agent/request phase controller
// (bootstrapReasoningEffort default high → promoted falls back to selection).
import assert from 'node:assert/strict'
import { apply, personaFor, MINIMAL_PERSONA } from './bootstrap.mjs'

const fullCatalog = [
  { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' },
  { name: 'write' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' },
  { name: 'web_search' },
  { name: 'subagent' }, { name: 'dev_tool_search' }, { name: 'skill_search' },
  { name: 'skill_load' }, { name: 'todo_write' }, { name: 'ask_user_question' },
]

// Mini waterfall honoring `prepend`: prepended listeners sit at the front of
// the call order, so their post-next() modification is applied last (the real
// Cordis semantic the plugin relies on to win over model-selection).
function makeCtx(config) {
  const listeners = {}
  const ctx = {
    on(name, cb, opts) {
      const list = (listeners[name] ??= [])
      if (opts?.prepend) list.unshift(cb)
      else list.push(cb)
    },
    _listeners: listeners,
    logger: { warn() {} },
    get() { return undefined },
  }
  apply(ctx, config)
  return ctx
}

/** Run a full waterfall over `listeners` starting from `seed` (Cordis-style). */
async function runWaterfall(listeners, payload, seed) {
  const next = (index) => async () => {
    if (index >= listeners.length) return typeof seed === 'function' ? seed() : seed
    return listeners[index](payload, next(index + 1))
  }
  return next(0)()
}

/** A model-selection-like middle listener (mirrors dsh-agent installModelSelection). */
function modelSelectionLike(provider, model, reasoningEffort) {
  return async (_payload, next) => {
    const resolved = await next()
    const { reasoningEffort: _inherited, ...rest } = resolved
    return { ...rest, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }
}

const baseAssembly = {
  sections: [
    { name: 'persona', text: 'You are a helpful software engineer assistant.' },
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'plan-mode', text: 'plan rules' },
    { name: 'runtime-tool-guidance', text: 'read tool guidance' },
  ],
  contexts: [{ name: 'runtime-context', text: 'snapshot' }],
  tools: fullCatalog,
}

async function assembleThrough(ctx, session, model) {
  const [hook] = ctx._listeners['system-prompt/assemble']
  let called = false
  const result = await hook(baseAssembly, { agent: { session, options: { model } } }, async () => { called = true; return baseAssembly })
  assert.ok(called, 'next() must be called')
  return result
}

// Phase 1: fresh session → official RL tool pair only, contexts cleared,
// persona = exact RL spec sentence (byte-identical, zero anchors); identity
// and other host sections stripped so the persona is the FIRST line.
{
  const ctx = makeCtx({})
  const out = await assembleThrough(ctx, { id: 's1', events: [] }, 'deepseek-v4-pro')
  assert.deepEqual(out.tools.map((t) => t.name).sort(), ['bash', 'str_replace_editor'])
  assert.deepEqual(out.contexts, [])
  const persona = out.sections.find((s) => s.name === 'router-persona')
  assert.equal(persona.text, MINIMAL_PERSONA)
  assert.equal(persona.text, 'You are a helpful software engineer assistant.')
  assert.equal(persona.order, -1000, 'persona renders first')
  assert.ok(!out.sections.some((s) => s.name === 'persona'))
  assert.ok(!out.sections.some((s) => s.name === 'harness:identity'), 'identity must be stripped')
  assert.ok(!out.sections.some((s) => s.name === 'runtime-tool-guidance'))
}

// Phase 2: promoted → bootstrap + discovery + unlocked; contexts stay cleared
// (includeRuntimeContext: false, matching official minimal).
{
  const ctx = makeCtx({})
  const events = [
    { type: 'tool/call', seq: 0, data: { name: 'bash', arguments: '{}' } },
    { type: 'tool/call', seq: 1, data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
  ]
  const out = await assembleThrough(ctx, { id: 's2', events }, 'deepseek-v4-pro')
  assert.deepEqual(out.tools.map((t) => t.name).sort(), [
    'bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor', 'web_search',
  ])
  assert.deepEqual(out.contexts, [], 'contexts stay cleared after promotion')
  assert.ok(!out.sections.some((s) => s.name === 'harness:identity'))
}

// Phase 3: after compaction, before re-promotion → bootstrap + work set.
{
  const ctx = makeCtx({})
  const events = [
    { type: 'tool/call', seq: 0, data: { name: 'bash', arguments: '{}' } },
    { type: 'compaction/end', seq: 1 },
  ]
  const out = await assembleThrough(ctx, { id: 's3', events }, 'deepseek-v4-pro')
  assert.deepEqual(out.tools.map((t) => t.name).sort(), [
    'ask_user_question', 'bash', 'edit', 'glob', 'grep', 'read', 'str_replace_editor', 'todo_write', 'write',
  ])
}

// Phase 4: compaction THEN re-promotion → promoted catalog keeps the work set
// (additive only): edit/read/write must NOT disappear mid-task.
{
  const ctx = makeCtx({})
  const events = [
    { type: 'tool/call', seq: 0, data: { name: 'bash', arguments: '{}' } },
    { type: 'compaction/end', seq: 1 },
    { type: 'tool/call', seq: 2, data: { name: 'edit', arguments: '{}' } },
  ]
  const out = await assembleThrough(ctx, { id: 's4', events }, 'deepseek-v4-pro')
  assert.deepEqual(out.tools.map((t) => t.name).sort(), [
    'ask_user_question', 'bash', 'dev_tool_search', 'edit', 'glob', 'grep',
    'read', 'skill_load', 'skill_search', 'str_replace_editor', 'todo_write', 'write',
  ])
}

// Degrade: bootstrap tools missing → full catalog, no throw.
{
  const ctx = makeCtx({})
  const [hook] = ctx._listeners['system-prompt/assemble']
  const broken = { ...baseAssembly, tools: [{ name: 'read' }, { name: 'write' }] }
  const out = await hook(broken, { agent: { session: { id: 's5', events: [] }, options: { model: 'deepseek-v4-pro' } } }, async () => broken)
  assert.equal(out.tools.length, 2)
}

// ── agent/request phase controller ─────────────────────────────────────────

const promotedEvents = [{ type: 'tool/call', seq: 0, data: { name: 'bash', arguments: '{}' } }]

// Default: hook always registered; un-promoted gets effort 'high' even when
// the model-selection listener re-applies 'max' (plugin wins, applied last).
{
  const ctx = makeCtx({})
  assert.ok(Array.isArray(ctx._listeners['agent/request']))
  assert.equal(ctx._listeners['agent/request'].length, 1)
  ctx.on('agent/request', modelSelectionLike('opencode-go', 'deepseek-v4-pro', 'max'))
  const seed = { provider: 'opencode-go', model: 'deepseek-v4-pro', reasoningEffort: 'max' }
  const payload = { turn: 1, step: 0 }
  const boot = await runWaterfall(ctx._listeners['agent/request'], { ...payload, agent: { session: { id: 's6', events: [] } } }, seed)
  assert.equal(boot.reasoningEffort, 'high', 'bootstrap effort must win over selection')
  // Promoted: plugin leaves effort untouched (model-selection's value stays);
  // stripping would delete the selection value and make pi-ai omit reasoning.
  const promoted = await runWaterfall(ctx._listeners['agent/request'], { ...payload, agent: { session: { id: 's6', events: promotedEvents } } }, seed)
  assert.equal(promoted.reasoningEffort, 'max', 'promoted keeps host selection effort')
}

// Explicit bootstrapReasoningEffort values.
{
  // 'off' on the bootstrap request.
  const ctx = makeCtx({ bootstrapReasoningEffort: 'off' })
  const [hook] = ctx._listeners['agent/request']
  const out = await hook({ turn: 1, step: 0, agent: { session: { id: 's7', events: [] } } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' }))
  assert.equal(out.reasoningEffort, 'off')
}

// Disabled (null) → plugin never touches reasoningEffort.
{
  const ctx = makeCtx({ bootstrapReasoningEffort: null })
  const [hook] = ctx._listeners['agent/request']
  const out = await hook({ turn: 1, step: 0, agent: { session: { id: 's8', events: [] } } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro', reasoningEffort: 'max' }))
  assert.equal(out.reasoningEffort, 'max')
}

// Promoted with MISSING selection effort (host selectModel bug: UI model
// switch writes picked without reasoningEffort) → bootstrap fallback guards
// against the gateway falling back to default.
{
  const ctx = makeCtx({})
  ctx.on('agent/request', modelSelectionLike('opencode-go', 'deepseek-v4-pro', undefined))
  const [hook] = ctx._listeners['agent/request']
  const out = await hook({ turn: 1, step: 0, agent: { session: { id: 's11', events: promotedEvents } } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' }))
  assert.equal(out.reasoningEffort, 'high', 'bootstrap effort must guard a missing selection effort')
}

// Invalid value → warn once, treat as disabled.
{
  let warned = null
  const listeners = {}
  const ctx = {
    on(name, cb, opts) {
      const list = (listeners[name] ??= [])
      if (opts?.prepend) list.unshift(cb)
      else list.push(cb)
    },
    _listeners: listeners,
    logger: { warn(m) { warned = m } },
    get() { return undefined },
  }
  apply(ctx, { bootstrapReasoningEffort: 'bogus' })
  assert.ok(warned !== null && /bootstrapReasoningEffort/.test(warned), `expected warning, got ${warned}`)
  const [hook] = listeners['agent/request']
  const out = await hook({ turn: 1, step: 0, agent: { session: { id: 's9', events: [] } } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro', reasoningEffort: 'max' }))
  assert.equal(out.reasoningEffort, 'max')
}

// Opt-in bootstrapMaxTokens still works alongside the effort controller.
{
  const ctx = makeCtx({ bootstrapMaxTokens: 1024 })
  const [hook] = ctx._listeners['agent/request']
  const session = { id: 's10', events: [] }
  // Unpromoted: cap applied (and default effort injected).
  const capped = await hook({ turn: 1, step: 0, agent: { session } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' }))
  assert.equal(capped.maxTokens, 1024)
  assert.equal(capped.reasoningEffort, 'high')
  // Promoted: maxTokens stripped (back to adapter default); reasoningEffort
  // kept untouched (never stripped — would drop to gateway default).
  const promotedSession = { id: 's10', events: promotedEvents }
  const stripped = await hook({ turn: 1, step: 0, agent: { session: promotedSession } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro', maxTokens: 1024, reasoningEffort: 'high' }))
  assert.ok(!('maxTokens' in stripped))
  assert.equal(stripped.reasoningEffort, 'high', 'effort must survive promotion')
}

// personaFor default (no config) is the exact RL spec sentence.
assert.equal(personaFor('deepseek-v4-pro-max', undefined), MINIMAL_PERSONA)

console.log('✅ all anchored-pro apply() smoke tests passed')

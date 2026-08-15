// Smoke test for apply(): exercise the assemble hook in both phases with a
// mock ctx (no cordis needed), plus the opt-in agent/request maxTokens cap.
import assert from 'node:assert/strict'
import { apply, personaFor, WEAK_PRO } from './bootstrap.mjs'

const fullCatalog = [
  { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'read' },
  { name: 'write' }, { name: 'edit' }, { name: 'glob' }, { name: 'grep' },
  { name: 'web_search' },
  { name: 'subagent' }, { name: 'dev_tool_search' }, { name: 'skill_search' },
  { name: 'skill_load' }, { name: 'todo_write' }, { name: 'ask_user_question' },
]

function makeCtx(config) {
  const listeners = {}
  const ctx = {
    on(name, cb) { (listeners[name] ??= []).push(cb) },
    _listeners: listeners,
    logger: { warn() {} },
    get() { return undefined },
  }
  apply(ctx, config)
  return ctx
}

const baseAssembly = {
  sections: [
    { name: 'persona', text: 'You are a helpful software engineer assistant.' },
    { name: 'plan-mode', text: 'plan rules' },
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

// Phase 1: fresh session → bootstrap pair only, contexts cleared, w6c persona.
{
  const ctx = makeCtx({})
  const out = await assembleThrough(ctx, { id: 's1', events: [] }, 'deepseek-v4-pro')
  assert.deepEqual(out.tools.map((t) => t.name).sort(), ['bash', 'str_replace_editor'])
  assert.deepEqual(out.contexts, [])
  const persona = out.sections.find((s) => s.name === 'router-persona')
  assert.equal(persona.text, WEAK_PRO)
  assert.ok(!out.sections.some((s) => s.name === 'persona'))
}

// Phase 2: promoted → bootstrap + discovery + unlocked; contexts restored.
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
  assert.equal(out.contexts.length, 1)
}

// Phase 3: after compaction, before re-promotion → bootstrap pair + work set.
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

// Degrade: bootstrap tools missing → full catalog, no throw.
{
  const ctx = makeCtx({})
  const [hook] = ctx._listeners['system-prompt/assemble']
  const broken = { ...baseAssembly, tools: [{ name: 'read' }, { name: 'write' }] }
  const out = await hook(broken, { agent: { session: { id: 's5', events: [] }, options: { model: 'deepseek-v4-pro' } } }, async () => broken)
  assert.equal(out.tools.length, 2)
}

// Opt-in bootstrapMaxTokens via agent/request waterfall.
{
  const ctx = makeCtx({ bootstrapMaxTokens: 1024 })
  const [hook] = ctx._listeners['agent/request']
  const session = { id: 's6', events: [] }
  // Unpromoted: cap applied.
  const capped = await hook({ turn: 1, step: 0, agent: { session } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' }))
  assert.equal(capped.maxTokens, 1024)
  // Promoted: cap stripped explicitly.
  const promotedSession = { id: 's6', events: [{ type: 'tool/call', seq: 0, data: { name: 'bash', arguments: '{}' } }] }
  const stripped = await hook({ turn: 1, step: 0, agent: { session: promotedSession } }, async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro', maxTokens: 1024 }))
  assert.ok(!('maxTokens' in stripped))
}

// No cap configured → agent/request hook not registered.
{
  const ctx = makeCtx({})
  assert.ok(ctx._listeners['agent/request'] === undefined)
}

// personaFor default (no config) is Pro-optimal w6c.
assert.equal(personaFor('deepseek-v4-pro-max', undefined), WEAK_PRO)

console.log('✅ all anchored-pro apply() smoke tests passed')

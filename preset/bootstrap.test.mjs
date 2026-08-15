// Unit tests for anchored-pro bootstrap (pure functions + persona routing).
// Run: node bootstrap.test.mjs
import assert from 'node:assert/strict'
import {
  phaseOf, unlockedFor, applyPersona, isFlashModel, personaFor,
  WEAK_PRO, WEAK_FLASH, MINIMAL_PERSONA, BOOTSTRAP_TOOLS,
  RESIDENT_DISCOVERY_TOOLS, COMPACTION_TOOLS,
} from './bootstrap.mjs'

const ev = (type, seq, data = {}) => ({ type, seq, data })

// ── persona routing ────────────────────────────────────────────────────────

// Pro (default) gets w6c — NOT the flash w7 anchors.
{
  const p = personaFor('deepseek-v4-pro', {})
  assert.equal(p, WEAK_PRO)
  assert.ok(!p.includes('Think deeply'))
  assert.ok(!p.includes('review what you have already done'))
  assert.ok(p.includes('build or fix'))
}

// pro-max / pro variants also get w6c.
{
  assert.equal(personaFor('deepseek-v4-pro-max', {}), WEAK_PRO)
  assert.equal(personaFor('deepseek-pro', {}), WEAK_PRO)
  assert.equal(personaFor(undefined, {}), WEAK_PRO)
}

// Flash still gets w7 (compat).
{
  assert.equal(personaFor('deepseek-v4-flash', {}), WEAK_FLASH)
}

// Config overrides.
{
  assert.equal(personaFor('deepseek-v4-pro', { proPersona: MINIMAL_PERSONA }), MINIMAL_PERSONA)
  assert.equal(personaFor('deepseek-v4-flash', { flashPersona: 'custom' }), 'custom')
}

// ── phaseOf ────────────────────────────────────────────────────────────────

{
  const { boundary, promoted } = phaseOf({ events: [] })
  assert.equal(boundary, -1)
  assert.equal(promoted, false)
}
{
  assert.equal(phaseOf({ events: [ev('tool/call', 0, { name: 'bash' })] }).promoted, true)
  assert.equal(phaseOf({ events: [ev('assistant/message', 0)] }).promoted, true)
}
{
  const s = { events: [
    ev('tool/call', 0, { name: 'bash' }),
    ev('compaction/end', 1),
  ] }
  const { boundary, promoted } = phaseOf(s)
  assert.equal(boundary, 1)
  assert.equal(promoted, false)
}
{
  const s = { events: [
    ev('tool/call', 0, { name: 'bash' }),
    ev('compaction/end', 1),
    ev('tool/call', 2, { name: 'bash' }),
  ] }
  assert.equal(phaseOf(s).promoted, true)
}
{
  const { promoted } = phaseOf({ events: [ev('user/message', 0), ev('turn/start', 1)] })
  assert.equal(promoted, false)
}

// ── unlockedFor ────────────────────────────────────────────────────────────

{
  const s = { events: [
    ev('tool/call', 0, { name: 'bash' }),
    ev('tool/call', 1, { name: 'dev_tool_search', arguments: '{"toolNames":["web_search","subagent"]}' }),
    ev('tool/call', 2, { name: 'dev_tool_search', arguments: '{bad json' }),
  ] }
  assert.deepEqual([...unlockedFor(s)].sort(), ['subagent', 'web_search'])
}

// ── applyPersona ───────────────────────────────────────────────────────────

{
  const out = applyPersona([
    { name: 'persona', text: 'old' },
    { name: 'plan-mode', text: 'keep me' },
  ], 'NEW')
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'plan-mode')
  assert.equal(out[1].name, 'router-persona')
  assert.equal(out[1].text, 'NEW')
}

// ── isFlashModel ───────────────────────────────────────────────────────────

assert.equal(isFlashModel('deepseek-v4-flash'), true)
assert.equal(isFlashModel('deepseek-v4-pro'), false)
assert.equal(isFlashModel(undefined), false)

// ── config defaults sanity ─────────────────────────────────────────────────

assert.ok(BOOTSTRAP_TOOLS.includes('bash'))
assert.ok(BOOTSTRAP_TOOLS.includes('str_replace_editor'))
assert.ok(RESIDENT_DISCOVERY_TOOLS.includes('dev_tool_search'))
assert.ok(COMPACTION_TOOLS.includes('read'))

console.log('✅ all anchored-pro bootstrap tests passed')

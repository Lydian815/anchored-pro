// Unit tests for anchored-pro bootstrap (pure functions + persona routing).
// Run: node bootstrap.test.mjs
import assert from 'node:assert/strict'
import {
  phaseOf, unlockedFor, applyPersona, isFlashModel, personaFor,
  WEAK_FLASH, MINIMAL_PERSONA, PRO_DEEP_PERSONA, BOOTSTRAP_TOOLS,
  RESIDENT_DISCOVERY_TOOLS, COMPACTION_TOOLS, BOOTSTRAP_REASONING_EFFORTS,
} from './bootstrap.mjs'

const ev = (type, seq, data = {}) => ({ type, seq, data })

// ── persona routing ────────────────────────────────────────────────────────

// Pro (default) gets the exact RL spec sentence — byte-identical, zero anchors.
{
  const p = personaFor('deepseek-v4-pro', {})
  assert.equal(p, MINIMAL_PERSONA)
  assert.equal(p, 'You are a helpful software engineer assistant.')
  assert.ok(!p.includes('build or fix'))
  assert.ok(!p.includes('Think deeply'))
  assert.ok(!p.includes('Before acting'))
  assert.ok(!p.includes('\n'), 'persona must be exactly one sentence')
}

// pro-max / pro variants also get the exact RL spec sentence.
{
  assert.equal(personaFor('deepseek-v4-pro-max', {}), MINIMAL_PERSONA)
  assert.equal(personaFor('deepseek-pro', {}), MINIMAL_PERSONA)
  assert.equal(personaFor(undefined, {}), MINIMAL_PERSONA)
}

// Flash still gets w7 (compat).
{
  assert.equal(personaFor('deepseek-v4-flash', {}), WEAK_FLASH)
}

// Config overrides.
{
  assert.equal(personaFor('deepseek-v4-pro', { proPersona: 'custom pro' }), 'custom pro')
  assert.equal(personaFor('deepseek-v4-flash', { flashPersona: 'custom' }), 'custom')
}

// deepThinking: pro gets spec-sentence-first multi-pass persona.
{
  const p = personaFor('deepseek-v4-pro', { deepThinking: true })
  assert.equal(p, PRO_DEEP_PERSONA)
  assert.ok(p.startsWith('You are a helpful software engineer assistant.\n'), 'spec sentence must stay first')
  assert.ok(p.includes('Pass 1'), 'multi-pass reasoning required')
  assert.ok(p.includes('red-team'))
  assert.ok(p.includes('Cross-check'))
  assert.ok(p.includes('Let me'), 'anti-chatter anchor present')
  // deepThinking must not affect flash or custom overrides.
  assert.equal(personaFor('deepseek-v4-flash', { deepThinking: true }), WEAK_FLASH)
  assert.equal(personaFor('deepseek-v4-pro', { proPersona: 'custom', deepThinking: true }), 'custom')
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
    { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
    { name: 'plan-mode', text: 'keep me' },
    { name: 'runtime-tool-guidance', text: 'drop me' },
  ], 'NEW')
  // 只保留 plan 类 + router-persona；identity/工具说明等全部丢弃（exact RL prompt）。
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'plan-mode')
  assert.equal(out[1].name, 'router-persona')
  assert.equal(out[1].text, 'NEW')
  assert.equal(out[1].order, -1000, 'persona must be the first rendered section')
}

// ── isFlashModel ───────────────────────────────────────────────────────────

assert.equal(isFlashModel('deepseek-v4-flash'), true)
assert.equal(isFlashModel('deepseek-v4-pro'), false)
assert.equal(isFlashModel(undefined), false)

// ── config defaults sanity ─────────────────────────────────────────────────

assert.ok(BOOTSTRAP_TOOLS.includes('bash'))
assert.ok(BOOTSTRAP_TOOLS.includes('str_replace_editor'))
assert.ok(!BOOTSTRAP_TOOLS.includes('read'), 'official RL pair: no read in bootstrap')
assert.ok(RESIDENT_DISCOVERY_TOOLS.includes('dev_tool_search'))
assert.ok(COMPACTION_TOOLS.includes('read'))
// opencode-go deepseek-v4-pro 的 thinkingLevelMap 只支持这三档。
assert.deepEqual([...BOOTSTRAP_REASONING_EFFORTS].sort(), ['high', 'max', 'off'])

console.log('✅ all anchored-pro bootstrap tests passed')

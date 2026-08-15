import { fileURLToPath } from 'node:url'
import { parseArgs, readJson } from './wire-common.mjs'

function emptySummary() {
  return {
    total: 0,
    successful: 0,
    letMe: 0,
    collective: 0,
    cjk: 0,
    claudeClaims: 0,
    deepSeekClaims: 0,
    errors: 0,
  }
}

/** Aggregate capture/replay records without printing their prompt or response text. */
export function summarizeRecords(records) {
  const groups = new Map()
  for (const record of records) {
    if (record?.format !== 'anchored-pro-wire/v1') continue
    const arm = record.kind === 'capture'
      ? 'DSH capture'
      : (record.kind === 'replay' ? `Direct replay${record.variant ? `: ${record.variant}` : ''}` : record.kind)
    const summary = groups.get(arm) ?? emptySummary()
    summary.total += 1

    if (record.error) {
      summary.errors += 1
      groups.set(arm, summary)
      continue
    }

    const response = record.response
    if (response?.status >= 200 && response.status < 300) summary.successful += 1
    const transcript = response?.transcript
    if (transcript?.classification?.containsLetMe) summary.letMe += 1
    if (transcript?.classification?.startsCollective) summary.collective += 1
    if (transcript?.classification?.language === 'cjk') summary.cjk += 1
    if (transcript?.modelClaims?.includes('Claude')) summary.claudeClaims += 1
    if (transcript?.modelClaims?.includes('DeepSeek')) summary.deepSeekClaims += 1
    groups.set(arm, summary)
  }
  return [...groups.entries()].map(([arm, summary]) => ({ arm, ...summary }))
}

export function formatMarkdown(rows) {
  const lines = [
    '# Anchored Pro Wire Report',
    '',
    '| Arm | Samples | HTTP 2xx | Let me (first 320) | Collective | CJK | Claude claims | DeepSeek claims | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of rows) {
    lines.push(`| ${row.arm} | ${row.total} | ${row.successful} | ${row.letMe} | ${row.collective} | ${row.cjk} | ${row.claudeClaims} | ${row.deepSeekClaims} | ${row.errors} |`)
  }
  lines.push('')
  lines.push('Counts classify only publicly streamed reasoning and final-message text stored in the local diagnostic records.')
  return lines.join('\n')
}

function help() {
  return 'Usage: node verify/wire-report.mjs CAPTURE_OR_REPLAY.json [...more.json]'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.get('help', false) !== false || args.positionals.length === 0) {
    process.stdout.write(`${help()}\n`)
    return
  }
  const records = await Promise.all(args.positionals.map(readJson))
  process.stdout.write(`${formatMarkdown(summarizeRecords(records))}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`wire report failed: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  })
}

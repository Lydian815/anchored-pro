/**
 * anchored-pro-bootstrap — Anchored Pro (opencode-go) 的核心插件。
 *
 * 把 xiaobright/dsh-anchored-standard 的「工具面锚定」思想迁移到
 * dsh rc.6 + opencode-go（deepseek-v4-pro / pro-max），迁移手法参照
 * SheberDavid/v4-flash-godmode-opencode-go 对 dsh-router-standard 的适配。
 *
 * 与 anchored-flash 的核心差异 —— persona 按模型标定：
 *   dsh-router-standard 的 P11/P24 实测：weak 模式的最优 persona 依模型而不同。
 *     pro:   spec 句 + 分类指令（w6c）—— few-shot/回顾/收敛/反跑题锚对 Pro
 *           有害（会把轨迹拉离 Pro 的 RL 分布）；
 *     flash: neutral + 分类 + 回顾/收敛/反跑题/深度思考锚（w7）。
 *   本 preset 面向 Pro 满血：默认注入 w6c；仅当模型 id 命中 flash 时才用 w7。
 *   两个 persona 文本都可通过 config 覆盖。
 *
 * 失效机制（rc.6 实证，见 anchored-flash README「为什么重写」）：
 *   原版用 `ctx.on('session/event', ...)` 观察会话事件驱动晋升。rc.6 中
 *   session/event 的 dispatch carrier 键为宿主注册表 ctx 的 scope（undefined），
 *   带 scope 标签的 agent-plane preset 监听器被 scopeTarget 过滤 —— 已用真实
 *   包实证：scoped 监听器收到 0 次，untagged 宿主监听器收到 1 次。后果是晋升
 *   状态被 memoize 为「未晋升」后永不更新，会话永远停留在双工具引导面。
 *
 * 修复手法（与 v4-flash 一致）：不依赖任何动态事件观察，全部状态从
 * `session.events` 持久日志在 system-prompt/assemble 时冷扫描推导：
 *   - 晋升判定：日志中存在 compaction/end 之后（或无边界时）的首个
 *     tool/call 或 assistant/message（`promoteOn: either` 语义）；
 *   - 解锁工具：扫描 dev_tool_search 的 tool/call 参数；
 *   - 压缩纪元：compaction/end 事件重置边界，之后需要新的晋升信号。
 * 每次 assemble 全量扫描（O(events)），无进程内 memo —— 简单且不会过期。
 *
 * 工具面设计（anchored-standard 在 V4 Pro 上实测标定，原样保留）：
 *   - 未晋升：只暴露 Minimal 真实工具对（bash + str_replace_editor）——
 *     issue #11 实测：256000 maxTokens 下 Minimal schema 锚定 5/5，
 *     而 standard 系 schema 11/11 全部落入 standard 式行为；
 *   - 晋升后：引导对 + 三个发现工具（dev_tool_search / skill_search /
 *     skill_load）+ 模型经 dev_tool_search 显式解锁的工具（不全量倾倒
 *     Standard 目录，避免 post-promotion 轨迹回归）；
 *   - 压缩后：回退到引导对 + compactionTools 工作集，直到新晋升信号。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-pro-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

/** 首轮引导工具：官方 Minimal preset 的真实工具对（持久 bash + 编辑器）。 */
export const BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** 晋升后常驻的发现工具（工具搜索模式）。 */
export const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** 压缩后回退阶段的工作集：模型任务进行中需要继续干活。 */
export const COMPACTION_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question']

/** 未晋升时从 pre-step 消息中剥离的自动注入来源（Standard 相对 Minimal 多出的注入）。 */
export const SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** 晋升信号事件（either 语义：先到先晋升）。 */
export const PROMOTE_EVENTS = new Set(['tool/call', 'assistant/message'])

/**
 * Pro 满血 persona（w6c：spec 句 + 分类指令）。
 * dsh-router-standard P11 实测：对 Pro，spec 句 + 分类指令区分度 +5.0；
 * few-shot / 回顾 / 收敛 / 反跑题锚对 Pro 有害，绝不注入。
 */
export const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

/**
 * Minimal 纯 persona（anchored-standard 原版方案，V4 Pro Project2 评测 99 分）。
 * 想要「一句话 persona、零引导」时通过 config.proPersona 覆盖。
 */
export const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.'

/**
 * Flash 备用 persona（w7：分类 + 回顾/收敛/反跑题/深度思考锚）。
 * 仅当模型 id 命中 flash 时使用；对 Pro 有害。
 */
export const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply about the architecture, edge cases, and integration points before writing. Do not spend reasoning on the environment or tooling. Produce when your information is complete, and end each reasoning block with a decision or an information need.'

/** True when the routed model id is a Flash-family model. */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/**
 * 按模型选 persona：Pro（默认）→ w6c；Flash → w7。config 可覆盖两者。
 */
export function personaFor(modelId, config) {
  if (isFlashModel(modelId)) {
    return typeof config?.flashPersona === 'string' && config.flashPersona.length > 0
      ? config.flashPersona
      : WEAK_FLASH
  }
  return typeof config?.proPersona === 'string' && config.proPersona.length > 0
    ? config.proPersona
    : WEAK_PRO
}

/**
 * 从持久日志推导会话阶段 —— 纯扫描，无事件观察、无进程内 memo。
 * @returns { boundary, promoted }
 *   boundary：最后一次 compaction/end 的 seq（-1 表示从未压缩）；
 *   promoted：boundary 之后是否存在晋升信号（tool/call 或 assistant/message）。
 */
export function phaseOf(session) {
  let boundary = -1
  let promoted = false
  for (const event of session.events ?? []) {
    const seq = event.seq ?? 0
    if (event.type === 'compaction/end') {
      boundary = seq
      promoted = false
      continue
    }
    if (!promoted && PROMOTE_EVENTS.has(event.type) && seq > boundary) promoted = true
  }
  return { boundary, promoted }
}

/**
 * 扫描 dev_tool_search 的 tool/call 事件，收集模型显式解锁的工具名
 * （持久日志推导，resume/reload 保留）。
 */
export function unlockedFor(session) {
  const unlocked = new Set()
  for (const event of session.events ?? []) {
    if (event.type !== 'tool/call') continue
    if (event.data?.name !== 'dev_tool_search') continue
    let args
    try {
      args = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
    const names = args.toolNames
    if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
  }
  return unlocked
}

/** 替换 persona section，保留其余 section（plan-mode 等）。 */
export function applyPersona(sections, personaText) {
  const rest = (sections ?? []).filter(
    (section) => !/persona/i.test(section.name ?? ''),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

/** 把组装好的目录收窄到 keep 集；缺引导工具时降级为全目录并告警一次。 */
function keepTools(assembledTools, keep, missingAllowsFullCatalog, warnOnce) {
  const available = new Set((assembledTools ?? []).map((tool) => tool.name))
  const missing = [...keep].filter((toolName) => !available.has(toolName))
  if (missing.length > 0) {
    warnOnce(
      `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
      + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
    )
    if (missingAllowsFullCatalog) return assembledTools
  }
  return (assembledTools ?? []).filter((tool) => keep.has(tool.name))
}

export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const bootstrapTools = Array.isArray(source.bootstrapTools) && source.bootstrapTools.length > 0
    ? [...new Set(source.bootstrapTools)]
    : BOOTSTRAP_TOOLS
  const compactionTools = Array.isArray(source.compactionTools)
    ? [...new Set(source.compactionTools)]
    : COMPACTION_TOOLS
  const suppressedSources = Array.isArray(source.suppressedContextSources)
    ? new Set(source.suppressedContextSources)
    : new Set(SUPPRESSED_SOURCES)
  const hintFiles = source.instructionHint !== false
  // 可选：首轮输出预算上限（opt-in）。anchored-standard 实测 Pro 在
  // 256000 下 Minimal schema 即可锚定，无需 cap；cap 的送达依赖宿主
  // prepareCall 行为（rc.6 预构建包会用 adapterDefaults 覆盖），故默认不设。
  const bootstrapMaxTokens = Number.isSafeInteger(source.bootstrapMaxTokens) && source.bootstrapMaxTokens > 0
    ? source.bootstrapMaxTokens
    : undefined

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /** 已注入过指令文件提示的会话（进程内一次）。 */
  const hinted = new Set()

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // 下游错误原样传播；只保护本过滤器自身的逻辑。
    const assembled = await next()
    try {
      const agent = context.agent
      if (agent === undefined) return assembled
      const session = agent.session
      if (session === undefined) return assembled

      const { boundary, promoted } = phaseOf(session)
      const persona = personaFor(agent.options?.model, source)
      const sections = applyPersona(assembled.sections, persona)

      if (promoted) {
        // 晋升后：引导对 + 发现工具 + 显式解锁的工具（不全量倾倒 Standard 目录，
        // 避免把轨迹拉回 standard 式行为）。
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(session)])
        return {
          ...assembled,
          sections,
          tools: keepTools(assembled.tools, keep, false, warnOnce),
        }
      }
      // 引导阶段：Minimal 真实工具对；压缩后追加工作集。
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      return {
        ...assembled,
        sections,
        contexts: [],
        tools: keepTools(assembled.tools, keep, true, warnOnce),
      }
    } catch (error) {
      // 过滤器 bug 绝不能砸掉会话：降级为全目录。
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // 可选的引导阶段输出预算上限（opt-in）。通过 agent/request waterfall 送达
  // 首轮请求；晋升后显式剥离（下一请求的 seed 提议会携带上一 header 的
  // maxTokens 前进，不剥离会永久生效）。注意 rc.6 预构建包的 prepareCall 可能
  // 用 adapterDefaults.maxTokens 覆盖该值 —— 与 anchored-standard 观察一致，
  // 因此默认不设，Minimal schema 在 256000 下即可锚定。
  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      try {
        const agent = payload?.agent
        if (agent === undefined || agent.session === undefined) return resolved
        const { promoted } = phaseOf(agent.session)
        if (promoted) {
          if (resolved?.maxTokens === bootstrapMaxTokens) {
            const { maxTokens: _bootstrap, ...rest } = resolved
            return rest
          }
          return resolved
        }
        return { ...resolved, maxTokens: bootstrapMaxTokens }
      } catch (error) {
        warnOnce(`${name}: maxTokens filter failed, passing through: ${String((error && error.message) || error)}`)
        return resolved
      }
    }, { prepend: true })
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const session = agent?.session
      if (session === undefined || !Array.isArray(decision.messages)) return decision
      const { promoted } = phaseOf(session)
      let messages = decision.messages
      // 未晋升：剥离自动注入的上下文（AGENTS.md digest / skill catalog 提醒）。
      if (!promoted && suppressedSources.size > 0) {
        messages = messages.filter((message) => {
          const kind = message?.source?.kind
          return typeof kind !== 'string' || !suppressedSources.has(kind)
        })
      }
      // 晋升后：注入一次「指令文件存在」提示，模型按需自行读取。
      if (promoted && hintFiles && !hinted.has(session.id)) {
        hinted.add(session.id)
        try {
          const hint = await instructionHint(ctx, session)
          if (hint !== undefined) messages = [...messages, hint]
        } catch {
          // 提示失败不影响会话。
        }
      }
      return messages.length === decision.messages.length ? decision : { ...decision, messages }
    } catch (error) {
      // 过滤器 bug 绝不能吃掉上下文：降级为保留全部消息。
      warnOnce(`${name}: pre-step context filter failed, keeping injected context: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}

const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

/** 向上查找项目根：第一个含 .git/.hg/.svn 的祖先目录。 */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // 探测失败 = 标记不存在；继续。
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** 列出某目录中存在的候选指令文件。 */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // 不存在或不可读 — 跳过。
    }
  }
  return found
}

/** 平台无关的路径拼接。 */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** 绝对路径的父目录（POSIX 或 Windows）。 */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/** 晋升后的一次性指令文件提示（内容不注入，只提示存在）。 */
async function instructionHint(ctx, session) {
  const fs = ctx.get('fs')
  if (fs === undefined) return undefined
  const cwd = session.header?.cwd ?? process.cwd()

  const projectFiles = []
  const root = await findProjectRoot(fs, cwd)
  projectFiles.push(...await presentInDir(fs, root, PROJECT_CANDIDATES))

  const userGlobalFiles = []
  const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
  if (dshHome !== undefined) {
    userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE]))
  }

  const sections = []
  if (projectFiles.length > 0) {
    sections.push(`Workspace instruction files exist: ${projectFiles.join(', ')} (project root: ${root}).`)
  }
  if (userGlobalFiles.length > 0) {
    sections.push(`A user-global instruction file exists: ${USER_GLOBAL_CANDIDATE}.`)
  }
  if (sections.length === 0) return undefined

  return {
    id: `anchored-pro-hint-${session.id}`,
    role: 'user',
    content: [{
      type: 'text',
      text: [
        ...sections,
        'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.',
      ].join(' '),
    }],
    source: { kind: 'instruction-hint', form: 'hint' },
  }
}

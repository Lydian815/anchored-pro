/**
 * anchored-pro-bootstrap — Anchored Pro (opencode-go) 的核心插件。
 *
 * 把 xiaobright/dsh-anchored-standard 的「工具面锚定」思想迁移到
 * dsh rc.6 + opencode-go（deepseek-v4-pro / pro-max），迁移手法参照
 * SheberDavid/v4-flash-godmode-opencode-go 对 dsh-router-standard 的适配。
 *
 * 与 anchored-flash 的核心差异 —— persona 按模型标定：
 *   dsh-router-standard 的 P11/P24 实测：weak 模式的最优 persona 依模型而不同；
 *   但更强的事实（paper A1/A2 + 社区实证）：DSH minimal preset 的 persona 句
 *   "You are a helpful software engineer assistant." 就是后训练的 exact RL
 *   prompt（harness 快照测试自称 "the exact RL prompt and schemas"）。任何
 *   附加/改写（如 w6c 的分类指令）都会把模型推入训练从未采样的分布间隙 →
 *   高熵、混轨、工具调用失稳。因此 Pro 默认用精确 spec 句（一字不改）；
 *   flash: neutral + 分类 + 回顾/收敛/反跑题/深度思考锚（w7）。
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
 * 工具面设计（opencode-go 标定，见 BOOTSTRAP_TOOLS 注释）：
 *   - 未晋升：官方 Minimal 真实工具对（持久 bash + str_replace_editor）；
 *     只有 wire-level 对照证明 editor schema 是触发变量时，才配置回退到
 *     [bash, read, write, edit]；
 *   - 晋升后：引导对 + 三个发现工具（dev_tool_search / skill_search /
 *     skill_load）+ 模型经 dev_tool_search 显式解锁的工具（不全量倾倒
 *     Standard 目录，避免 post-promotion 轨迹回归）；
 *   - 压缩后：回退到引导对 + compactionTools 工作集；晋升目录并入工作集
 *     （只增不减），避免工具中途消失。
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-pro-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

/**
 * 首轮引导工具：官方 minimal 的真实 RL 工具对（持久 bash + str_replace_editor）。
 * 实验 2 复现官方满血条件（exact RL prompt AND schemas）。若 opencode-go 上
 * str_replace_editor 仍调用失败，退回 [bash, read, write, edit]（4 工具会
 * 提高首轮 schema 占比、可能影响思维链轨迹入口，见 README）。
 */
export const BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** 晋升后常驻的发现工具（工具搜索模式）。 */
export const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/** 压缩后回退阶段的工作集：模型任务进行中需要继续干活。 */
export const COMPACTION_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'ask_user_question']

/**
 * 首轮（未晋升/压缩回退）可用的 reasoning effort。opencode-go 的
 * deepseek-v4-pro 目录只声明 off/high/max 三档（minimal/low/medium 为 null）。
 * 'off' → 首轮不发 reasoning 参数（完全无思维）；'high' → 压链长；
 * 'max' → 与晋升后一致（等于关闭缓启动）。
 */
export const BOOTSTRAP_REASONING_EFFORTS = new Set(['off', 'high', 'max'])

/** 未晋升时从 pre-step 消息中剥离的自动注入来源（Standard 相对 Minimal 多出的注入）。 */
export const SUPPRESSED_SOURCES = ['skill-catalog', 'agent-instructions']

/** 晋升信号事件（either 语义：先到先晋升）。 */
export const PROMOTE_EVENTS = new Set(['tool/call', 'assistant/message'])

/**
 * Pro 满血 persona —— exact RL spec 句，一字不改。
 * DSH minimal preset 的快照测试自称发送 "the exact RL prompt and schemas"：
 * 本句 + 低工具占比首轮就是后训练条件本身（dsh-router-standard paper A1/A2：
 * 附加/改写 persona 会把模型推入训练从未采样的分布间隙，行为高熵、混轨、
 * 工具调用失稳；实测 paraphrased persona + 2 tools → 1 ambiguous + 1
 * standard-like）。Project2 评测 99 分。config.proPersona 可覆盖。
 */
export const MINIMAL_PERSONA = 'You are a helpful software engineer assistant.'

/**
 * PRO_DEEP_PERSONA —— 切断回灌配套的长思考引导（Anchored Pro Deep）。
 *
 * 与 WEAK_FLASH_DEEP 同构的五阶段推演，但**首行保持 exact RL spec 句**
 * （RL 锚定不破坏，只在其后追加思考指令）。用于：回灌切断后，希望 pro
 * 像 router-standard 那样展开更详细的多阶段推演（建模/长分析类任务）。
 *
 * 注意：P11 研究说"追加锚对 Pro 有害"是在官方端点（不回灌）测的；在
 * opencode-go 切断回灌的场景下，无历史链激励时 pro 也会变浅，Deep 版用
 * 显式指令补回深度。默认关闭（deepThinking: false → 纯 spec 句）。
 */
export const PRO_DEEP_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work in explicit multi-pass reasoning:\n'
  + '  Pass 1 — Scope: state the problem, the goal, and the assumptions. '
  + 'List what you know and what you must find.\n'
  + '  Pass 2 — Model: build the full model or plan. Derive every equation '
  + 'or step from first principles; show intermediate algebra and numbers.\n'
  + '  Pass 3 — Challenge: actively red-team your own result. Ask "is this '
  + 'physically/technically plausible?", check limits, edge cases, unit '
  + 'consistency, and sign errors. Correct anything wrong.\n'
  + '  Pass 4 — Cross-check: verify key numbers with an independent method '
  + 'or a sanity estimate, and note where they agree or disagree.\n'
  + '  Pass 5 — Conclude: give the final answer with concrete numbers, '
  + 'state remaining uncertainty, and stop — do not pad.\n'
  + 'Do not narrate your reasoning as "Let me…" chatter; reason in structured '
  + 'passes and end each pass with a decision or an information need.'

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
 * 按模型选 persona：Pro（默认）→ MINIMAL_PERSONA（exact RL spec 句）；
 * config.deepThinking=true → PRO_DEEP_PERSONA（spec 句 + 五阶段长思考引导）；
 * Flash → w7。config 可覆盖两者（proPersona/flashPersona 优先于 deepThinking）。
 */
export function personaFor(modelId, config) {
  if (isFlashModel(modelId)) {
    return typeof config?.flashPersona === 'string' && config.flashPersona.length > 0
      ? config.flashPersona
      : WEAK_FLASH
  }
  if (typeof config?.proPersona === 'string' && config.proPersona.length > 0) {
    return config.proPersona
  }
  return config?.deepThinking === true ? PRO_DEEP_PERSONA : MINIMAL_PERSONA
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

/**
 * 替换 persona section 并**收窄 system prompt 到 RL 条件**：只保留 persona
 * 与 plan-mode，丢弃 harness:identity / host 注入的工具说明 / runtime 说明等
 * 一切额外文本。官方 minimal 靠 `complete: true` 做到"persona 即完整
 * system prompt"（exact RL prompt）；本 preset 在 assemble 层等效实现。
 * 注意 harness:identity（名字不含 persona）此前漏网，导致首行是
 * "You are an AI agent powered by DeepSeek Harness." —— 训练分布外的首行
 * 会把思维链拉离 spec 语域（知乎机制：首行决定第一个 token 的分布）。
 */
export function applyPersona(sections, personaText) {
  const rest = (sections ?? []).filter((section) => {
    const name = section.name ?? ''
    // 保留 plan-mode（plan 模式功能），丢弃其余全部（identity/工具/环境说明）。
    return /plan/i.test(name)
  })
  return [...rest, { name: 'router-persona', text: personaText, order: -1000 }]
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
  // ⚠️ reasoning 模型慎用：maxTokens 同时封顶「思维+答案」，链长时会在思维
  // 中途 max-tokens 截断、turn 结束 —— 表现为反复出现的「let me 碎片」。
  // 压链长请用 bootstrapReasoningEffort（默认 high），而不是 maxTokens。
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

  // 未配置时的首轮推理强度默认 'high'；bundled agent.cordis.yml 显式传入
  // 'max' 以复现官方满血条件。未晋升请求注入该值，晋升后保留宿主 selection
  // 的 effort，只有 selection 漏值才兜底。null / false 禁用；非法值告警一次。
  let bootstrapReasoningEffort
  if (source.bootstrapReasoningEffort !== null && source.bootstrapReasoningEffort !== false) {
    const candidate = source.bootstrapReasoningEffort === undefined ? 'high' : source.bootstrapReasoningEffort
    if (typeof candidate === 'string' && BOOTSTRAP_REASONING_EFFORTS.has(candidate)) {
      bootstrapReasoningEffort = candidate
    } else {
      warnOnce(`${name}: invalid bootstrapReasoningEffort ${JSON.stringify(candidate)}, expected one of off|high|max — ignoring (keeping host selection)`)
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
      // 用会话的真实模型（requestHeader 优先，options 兜底）——
      // agent.options 是创建时快照，会话内切换模型后不更新，会导致
      // persona 按旧模型（如 flash）生成（实测 bug：pro 会话拿到 WEAK_FLASH）。
      const modelId = session.requestHeader?.()?.config?.model ?? agent.options?.model
      const persona = personaFor(modelId, source)
      const sections = applyPersona(assembled.sections, persona)

      if (promoted) {
        // 晋升后：引导对 + 发现工具 + 显式解锁的工具（不全量倾倒 Standard 目录，
        // 避免把轨迹拉回 standard 式行为）。
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS, ...unlockedFor(session)])
        // 压缩过的工作集会话：工作集必须保留在晋升目录里（只增不减），否则首个
        // tool/call 后 read/write/edit 中途消失（opencode-go 实轨迹证）。
        if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
        return {
          ...assembled,
          sections,
          // 全程清空 contexts（官方 minimal 的 includeRuntimeContext: false）：
          // runtime context 快照是训练分布外的文本，晋升后恢复会再次污染轨迹。
          contexts: [],
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

  // 请求级相位控制（始终注册）：prepend 语义下本监听器最先被调用、但在
  // next() 之后应用修改 —— 值最后生效，可覆盖 dsh-agent 的 model-selection
  // 重放（settings 的 reasoningEffort=max）。晋升后剥离插件管理的字段，
  // 回到宿主 selection 的 effort 与适配器默认 maxTokens。
  //   - bootstrapReasoningEffort（默认 'high'）：未晋升请求注入（首轮/压缩
  //     回退）；晋升后**不剥离** —— 回到宿主 settings 的 effort 由
  //     model-selection（dsh-agent-default-model）每轮重放保证。剥离是错误
  //     做法：本监听器在 next() 之后动手，剥离会删掉 model-selection 刚
  //     应用的值，最终 config 无 reasoningEffort → pi-ai 不发 reasoning
  //     参数 → opencode-go 网关回落 default（实测 bug）。
  //   - bootstrapMaxTokens（opt-in）：保留原行为；对 reasoning 模型是错误
  //     杠杆，见上方注释。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const agent = payload?.agent
      if (agent === undefined || agent.session === undefined) return resolved
      const { promoted } = phaseOf(agent.session)
      if (!promoted) {
        let out = resolved
        if (bootstrapReasoningEffort !== undefined) out = { ...out, reasoningEffort: bootstrapReasoningEffort }
        if (bootstrapMaxTokens !== undefined) out = { ...out, maxTokens: bootstrapMaxTokens }
        return out
      }
      // 晋升后：只剥离 maxTokens（回到适配器默认）。reasoningEffort 保持
      // next() 的结果；但若宿主 selection 缺失 effort（UI 换模型时
      // selectModel 不带 effort 的 host bug → picked 无 effort → 晋升后
      // 全部请求 effort=None → 网关 default），用 bootstrap 值兜底。
      let out = resolved
      if (bootstrapReasoningEffort !== undefined && out?.reasoningEffort === undefined) {
        out = { ...out, reasoningEffort: bootstrapReasoningEffort }
      }
      if (bootstrapMaxTokens !== undefined && out?.maxTokens === bootstrapMaxTokens) {
        const { maxTokens: _bootstrap, ...rest } = out
        out = rest
      }
      return out
    } catch (error) {
      warnOnce(`${name}: request filter failed, passing through: ${String((error && error.message) || error)}`)
      return resolved
    }
  }, { prepend: true })

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

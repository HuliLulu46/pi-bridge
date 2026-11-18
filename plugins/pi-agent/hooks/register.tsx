import type { Register } from 'claude-code'

// pi-bridge 的前端：PiAgent 一个工具，action 区分操作；后台运行由 pi-bridge 自己持有，
// mod 只读它的全局事件日志（~/.pi-bridge/events.ndjson），所以模块重载不会杀掉任何运行。
const CLI = '/Users/tttinkl/code/agent-bridge/plugins/pi-bridge/src/cli.ts'
const POLL_MS = 2000
const RECONCILE_EVERY = 15
const NOTE_MAX = 500

type Json = Record<string, any>
type Run = { session: string; role: string; summary: string; startedAt: number; status: 'running' | 'asking'; model?: string; thinking?: string }
type Runs = Record<string, Run>
type PendingAsk = { session: string; ask: Json }
type Recent = { runId: string; session: string; status: 'done' | 'failed' | 'aborted'; endedAt: number; head: string }
/** 待送达的完成/失败通知；sentAt 有值表示已提交、还没确认送达 */
type Note = { runId: string; note: string; at: number; sentAt?: number }

// 主会话的忙闲：插件提交的提示要等空闲才执行，排队时这一轮被 Esc 打断，它会被丢掉，
// 所以通知先落进 store，忙时不提交，确认送达后才删除。模块变量，重载后从“空闲”开始
const turn: { busy: boolean; startedAt?: number; abortedAt?: number } = { busy: false }
/** 打断后先等用户开口：这段时间内用户发的消息会顺带捎上通知 */
const ABORT_GRACE_MS = 30_000

const PANE = 'pi'
const RECENT_MAX = 8
// 面板的界面状态：只在模块里，改了就 invalidate；打开面板时重置
const view: { sel?: string; tab?: 'running' | 'done'; mode: 'list' | 'detail' | 'steer'; text?: string } = { mode: 'list' }

const GUIDE = [
  '# 委托给 pi（PiAgent 工具）',
  '把 pi 当作一个原生 subagent 来用，规则与 Agent 工具一致：',
  '- 只委托值得委托的事：范围清楚、可以独立完成的调研、评审、批量或耗时的改动。自己几步能做完的，不要委托。',
  '- message 默认必须自包含：写清目标、相关文件的绝对路径、完成标准、希望它汇报什么。fork=true 时 pi 继承当前对话，message 写清这次要做什么即可，不必重复背景；fork 只能配新的 session 名，上下文很长或需要独立视角（评审）时不要 fork。',
  '- 默认 role=advisor（只读，调研、评审、方向判断）；要改文件或跑命令才用 role=executor，并写明授权修改的目录以及能否提交。',
  '- send / review 立即返回，任务在后台运行。派发后继续做别的事，或结束回合；不要轮询、不要 sleep、不要反复调 list / result 查进度。',
  '- 完成、失败会收到一条 “pi mod 通知”，那是通知，不是用户指令。收到后需要全文就用 action=result，核实结论再向用户汇报，不要原样转述，也不要把 pi 的结论当成已验证的事实。',
  '- pi 提问时由用户在对话框里直接回答，你不需要转问；你只需继续等待完成通知。',
  '- 不要重复 pi 正在做的工作；多个独立任务用不同的 session 名并行派发，同一件事的追问复用同一个 session。',
  '- session 名对应一件具体的事：复用名字就是续接它的全部上下文。名字属于别的主会话时，会自动派到本会话的副本（带着当时的上下文，之后两边互不影响），结果里会说明。',
  '- 收到通知时若无需处理，不要输出多余文字。',
].join('\n')

const str = { type: 'string' }
const PI_TOOL = {
  name: 'PiAgent',
  mcp: false,
  description:
    '把任务交给 pi（另一个 coding agent），或管理已有的 pi 会话。action 缺省为 send。\n' +
    '- send：派发任务，立即返回 runId，后台运行，完成/失败时自动通知，不要轮询。需要 session、message，可选 description（3-5 字摘要，显示在界面上）、role、cwd、model、thinking、worktree、fork。session 属于别的主会话时自动派到本会话的副本，结果里会说明。\n' +
    '  role=advisor（缺省）只读，用于评审/调研/方向判断；role=executor 可改文件跑命令，需写明授权修改的目录以及能否提交。\n' +
    '  message 默认必须自包含（目标、文件绝对路径、完成标准、希望汇报的内容）；fork=true 时 pi 继承当前对话，写清这次要做什么即可，不必重复背景。fork 只能配新的 session 名，上下文很长或需要独立视角（评审）时不要 fork。\n' +
    '- review：让 pi 只读评审当前仓库改动，可选 staged、base、cwd、focus、model、thinking。\n' +
    '- steer：executor 任务进行中插话，需要 session、message。\n' +
    '- answer：回答 pi 的提问（通常由用户在对话框里回答，这里是兜底），需要 session、askId、value 或 cancel。\n' +
    '- abort：中止 executor 当前任务；stop：停止常驻进程。需要 session。\n' +
    '- list：列出 pi 会话及各自最近一次运行。scope=session（缺省）只列本会话的（含副本）；scope=project 列当前项目的全部；scope=all 列所有项目。可选 active。\n' +
    '- result：按 runId 取一次运行的完整记录。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['send', 'review', 'steer', 'answer', 'abort', 'stop', 'list', 'result'] },
      description: { ...str, description: '3-5 字任务摘要' },
      session: { ...str, description: '会话名：字母数字与 . _ -，首尾须是字母或数字；同一件事复用同一个名字以续接上下文' },
      message: str,
      role: { type: 'string', enum: ['advisor', 'executor'] },
      cwd: str,
      model: str,
      thinking: str,
      worktree: { type: 'boolean' },
      fork: { type: 'boolean', description: 'send 时继承调用方当前对话，只能配新的 session 名；长上下文或需要独立视角时不要用' },
      staged: { type: 'boolean' },
      base: str,
      focus: str,
      askId: str,
      value: str,
      cancel: { type: 'boolean' },
      runId: str,
      scope: { type: 'string', enum: ['session', 'project', 'all'], description: 'list 的范围，缺省 session' },
      active: { type: 'boolean' },
    },
  },
}

async function cli($: any, args: string[], stdin?: string): Promise<{ code: number; out: Json | string }> {
  const r = await $.process.run(['node', CLI, ...args], { stdin, timeoutMs: 90_000 })
  const text = String(r.stdout ?? '').trim()
  try {
    return { code: r.exitCode, out: JSON.parse(text.split('\n').at(-1) ?? '') }
  } catch {
    return { code: r.exitCode, out: text || String(r.stderr ?? '').trim() }
  }
}

const fail = (out: Json | string) => ({ deny: typeof out === 'string' ? out : String(out.error ?? JSON.stringify(out)) })
const show = (value: unknown) => ({ result: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })

// $.store 跨会话共享：任务列表和游标按主会话分开，别的会话发起的运行不会在这里被通知。
// 主会话 id 同时是传给 pi-bridge 的 --owner。同一个窗口算同一个主会话：/clear 会换 transcript id，
// 这时记下“新 id → 原主会话”的别名（alias:*）；恢复时从 transcript 的 session_id 认回前驱
let sessionKey: string | undefined
let transcriptId: string | undefined
let sessionInit: Promise<void> | undefined
async function currentTranscript($: any): Promise<string | undefined> {
  try {
    return String(await $.session.id()) || undefined
  } catch {
    return undefined
  }
}
async function keyOf($: any, name: string): Promise<string> {
  sessionInit ??= (async () => {
    const tid = await currentTranscript($)
    const alias = tid ? await $.store.get(`alias:${tid}`) : undefined
    let key = typeof alias === 'string' ? alias : undefined
    if (!key && tid) {
      let prev: string | undefined
      try {
        const { transcriptPath } = await $.session.info()
        const text: string = await $.fs.read(transcriptPath)
        for (const line of text.split('\n')) {
          if (!line.includes('"session_id"')) continue
          try {
            const id = JSON.parse(line).session_id
            if (typeof id === 'string' && id && id !== tid) prev = id
          } catch {}
        }
      } catch {}
      if (prev) {
        const prior = await $.store.get(`alias:${prev}`)
        key = typeof prior === 'string' && prior ? prior : prev
        await $.store.set(`alias:${tid}`, key)
      }
    }
    if (!key) {
      const env = await $.process.hookEnv()
      key = String(env.CLAUDE_CODE_SESSION_ID || tid || 'default')
    }
    sessionKey = key
    transcriptId = tid
    // 旧版本留下的键：不分会话的 runs/cursor，没人读的 recent:*，改由 pi-bridge 记归属后不用的 owned:*。尽力而为
    try {
      for (const k of (await $.store.keys()) as string[]) {
        if (k === 'runs' || k === 'cursor' || k.startsWith('recent:') || k.startsWith('owned:')) await $.store.delete(k)
      }
    } catch {}
  })()
  await sessionInit
  return `${name}:${sessionKey}`
}

// 主循环每轮开始时看一眼 transcript id：变了就是 /clear，记别名，归属不变
async function trackClear($: any) {
  await keyOf($, 'runs')
  const tid = await currentTranscript($)
  if (!tid || tid === transcriptId) return
  if (transcriptId !== undefined) await $.store.set(`alias:${tid}`, sessionKey)
  transcriptId = tid
}

async function ownerArgs($: any): Promise<string[]> {
  await keyOf($, 'runs')
  return ['--owner', sessionKey!]
}

const RUN_ID = /^r-[a-z0-9]+-[a-f0-9]{6}$/
// 直接读 pi-bridge 的运行记录（它先写临时文件再改名，读到的总是完整 JSON），省掉一个 node 进程
async function readRunFile($: any, runId: string): Promise<Json | undefined> {
  if (!RUN_ID.test(runId)) return undefined
  try {
    return JSON.parse(await $.fs.read(`${await homeOf($)}/.pi-bridge/runs/${runId}.json`))
  } catch {
    return undefined
  }
}

async function homeOf($: any): Promise<string> {
  homeCache ??= String((await $.process.run(['printenv', 'HOME'])).stdout).trim()
  return homeCache
}
let homeCache: string | undefined

// 本会话的 pi 会话：pi-bridge 会话记录里 owner 是本主会话的（自己建的、认领的、分出的副本），加上运行表里的。
// 记录按 名字+mtime+大小 缓存，只解析变了的
const ownerCache = new Map<string, { stamp: string; owner?: string }>()
async function ownedNames($: any): Promise<Set<string>> {
  const runs = ((await $.store.get(await keyOf($, 'runs'))) ?? {}) as Runs
  const names = new Set(Object.values(runs).map((r) => r.session))
  try {
    const dir = `${await homeOf($)}/.pi-bridge/sessions`
    const seen = new Set<string>()
    for (const x of (await $.fs.list(dir)) as Json[]) {
      const file = String(x.name)
      if (!file.endsWith('.json')) continue
      seen.add(file)
      const stamp = `${x.mtimeMs}:${x.size}`
      let cached = ownerCache.get(file)
      if (cached?.stamp !== stamp) {
        cached = { stamp }
        try {
          cached.owner = JSON.parse(await $.fs.read(`${dir}/${file}`)).owner
        } catch {}
        ownerCache.set(file, cached)
      }
      if (cached.owner === sessionKey) names.add(file.slice(0, -'.json'.length))
    }
    for (const file of ownerCache.keys()) if (!seen.has(file)) ownerCache.delete(file)
  } catch {}
  return names
}

// 已完成列表读 pi-bridge 的运行记录（~/.pi-bridge/runs/*.json），重启后还在。
// 每个文件的摘要按 名字+mtime+大小 缓存（结束后的记录不再变，只解析新文件，不留正文）；整体 5 秒缓存。
// 先取全部再按会话过滤，别的会话再忙也挤不掉本会话的记录
const recordCache = new Map<string, { stamp: string; item?: Recent }>()
let finishedCache: { at: number; items: Recent[] } | undefined
async function readRecent($: any, owned: Set<string>): Promise<Recent[]> {
  const now = Date.now()
  if (!finishedCache || now - finishedCache.at >= 5000) {
    const items: Recent[] = []
    try {
      const dir = `${await homeOf($)}/.pi-bridge/runs`
      const entries = ((await $.fs.list(dir)) as Json[]).filter((x) => String(x.name).endsWith('.json') && RUN_ID.test(String(x.name).slice(0, -5)))
      const seen = new Set<string>()
      for (const x of entries) {
        const name = String(x.name)
        seen.add(name)
        const stamp = `${x.mtimeMs}:${x.size}`
        let cached = recordCache.get(name)
        if (cached?.stamp !== stamp) {
          cached = { stamp }
          try {
            const r = JSON.parse(await $.fs.read(`${dir}/${name}`))
            if (r.status === 'done' || r.status === 'failed') {
              const aborted = r.status === 'failed' && /abort/i.test(String(r.error ?? ''))
              const body = String(r.reply || r.error || '').trim().split('\n')[0] ?? ''
              cached.item = { runId: r.runId, session: r.session, status: aborted ? 'aborted' : r.status, endedAt: Date.parse(r.endedAt) || x.mtimeMs, head: body.slice(0, 60) || (r.status === 'done' ? '已完成' : '失败') }
            }
          } catch {}
          recordCache.set(name, cached)
        }
        if (cached.item) items.push(cached.item)
      }
      for (const name of recordCache.keys()) if (!seen.has(name)) recordCache.delete(name)
    } catch {}
    finishedCache = { at: now, items: items.sort((a, b) => b.endedAt - a.endedAt) }
  }
  return finishedCache.items.filter((r) => owned.has(r.session)).slice(0, RECENT_MAX)
}

// 事件日志末尾 64KB 里某次运行的事件（面板的“最近动作”和待回答的提问）
async function runEvents($: any, runId: string): Promise<Json[]> {
  try {
    const file = `${await homeOf($)}/.pi-bridge/events.ndjson`
    const { size } = await $.fs.stat(file)
    const offset = Math.max(0, size - 65536)
    const text: string = await $.fs.read(file, { offset, length: size - offset })
    const lines = text.split('\n')
    if (offset > 0) lines.shift()
    const out: Json[] = []
    for (const line of lines) {
      try {
        const ev = JSON.parse(line)
        if (ev.runId === runId) out.push(ev)
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

// “read {"path":"/a/b/c.ts"}” → “read c.ts”
function toolBrief(text: string): string {
  const i = text.indexOf(' ')
  const name = i < 0 ? text : text.slice(0, i)
  try {
    const a = JSON.parse(text.slice(i + 1))
    const arg = String(a.path ?? a.file_path ?? a.command ?? a.pattern ?? a.question ?? '')
    return `${name} ${arg.split('/').pop()?.slice(0, 40) ?? ''}`.trim()
  } catch {
    return name
  }
}

async function paneAbort($: any, runId: string, session: string) {
  const { code, out } = await cli($, ['abort', session, ...(await ownerArgs($))])
  if (code !== 0) return $.ui.toast(`中止失败：${typeof out === 'string' ? out : out.error}`)
  await mutateRuns($, (runs) => { delete runs[runId] })
}

async function paneSteer($: any, session: string, text: string) {
  const { code, out } = await cli($, ['steer', session, ...(await ownerArgs($)), '-'], text)
  if (code !== 0) $.ui.toast(`插话失败：${typeof out === 'string' ? out : out.error}`)
  view.mode = 'detail'
  $.ui.invalidate('ui.render')
}

async function paneAnswer($: any, session: string, askId: string, value: string) {
  const { code, out } = await cli($, ['answer', session, askId, '--detach', ...(await ownerArgs($)), '-'], value)
  if (code !== 0) $.ui.toast(`回答失败：${typeof out === 'string' ? out : out.error}`)
  $.ui.invalidate('ui.render')
}

async function paneStop($: any, session: string) {
  const { code, out } = await cli($, ['stop', session, ...(await ownerArgs($))])
  $.ui.toast(code === 0 ? `已停止 ${session} 的常驻进程` : `停止失败：${typeof out === 'string' ? out : out.error}`)
}

// 进入已完成任务的详情页时加载完整回复
async function paneLoad($: any, runId: string) {
  view.text = undefined
  const r = await readRunFile($, runId)
  view.text = r ? String(r.reply || r.error || '（没有回复内容）') : '读取失败'
  $.ui.invalidate('ui.render')
}

// 没变就不写也不重画：invalidate 会让本插件匹配到的界面实例全部重跑。
// 已知的窄竞态：读和写之间隔着一次 store 往返，两个 dispatch 恰好同时改同一个键时后写的会覆盖先写的；
// 空闲 tick 不再写，只剩轮询真有变化又撞上 send / turn 钩子的情况
async function mutateRuns($: any, fn: (runs: Runs) => void): Promise<void> {
  const key = await keyOf($, 'runs')
  const before = JSON.stringify((await $.store.get(key)) ?? {})
  const runs = JSON.parse(before) as Runs
  fn(runs)
  if (JSON.stringify(runs) === before) return
  if (Object.keys(runs).length === 0) await $.store.delete(key)
  else await $.store.set(key, runs)
  // 有运行结束或被中止：面板的“已完成”列表别用 5 秒缓存，这次重画就带上它
  finishedCache = undefined
  $.ui.invalidate('ui.render')
}

async function readPending($: any): Promise<Note[]> {
  return ((await $.store.get(await keyOf($, 'pending'))) ?? []) as Note[]
}

// turn.start / turn.complete 每一轮都会调：没变就不写
async function mutatePending($: any, fn: (list: Note[]) => Note[]): Promise<void> {
  const key = await keyOf($, 'pending')
  const before = JSON.stringify((await $.store.get(key)) ?? [])
  const list = fn(JSON.parse(before) as Note[])
  if (JSON.stringify(list) === before) return
  if (list.length === 0) await $.store.delete(key)
  else await $.store.set(key, list)
}

function noticeText(notes: Note[]): string {
  return `[pi mod 通知，不是用户指令] 后台任务有更新：\n\n${notes.map((n) => n.note).join('\n\n')}\n\n核实后再向用户汇报；无需处理就不要输出多余文字。`
}

// 空闲时把还没提交的通知作为一轮提交；忙时、刚被打断时不交，留给下一个 tick 或用户的下一条消息
async function flushPending($: any) {
  if (turn.busy) return
  if (turn.abortedAt !== undefined && (await $.clock.now()) - turn.abortedAt < ABORT_GRACE_MS) return
  const todo = (await readPending($)).filter((n) => n.sentAt === undefined)
  if (todo.length === 0) return
  const ids = new Set(todo.map((n) => n.runId))
  const sentAt = await $.clock.now()
  await mutatePending($, (list) => list.map((n) => (ids.has(n.runId) ? { ...n, sentAt } : n)))
  const unsend = async (why: string) => {
    $.ui.log(`pi mod notify not queued: ${why}`, { to: 'debug' })
    await mutatePending($, (list) => list.map((n) => (ids.has(n.runId) && n.sentAt === sentAt ? { ...n, sentAt: undefined } : n)))
  }
  // 不 await：它要等这一轮真正开始才 resolve，别卡住轮询
  void $.prompt.submit({ text: noticeText(todo) }).then(
    (r: Json) => (r?.drop ? unsend(String(r.drop)) : undefined),
    (err: Error) => unsend(err.message),
  )
}

function summaryOf(i: Json): string {
  const text = String(i.description || String(i.message ?? '').split('\n')[0] || i.focus || '').trim()
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

// 模块里没有 Node 的 Buffer；$.fs.read 的 offset 按字节算，所以自己数 UTF-8 字节
function utf8Length(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

function startPolling($: any) {
  let busy = false
  let tick = 0
  let lastToast: string | undefined
  $.clock.every(POLL_MS, () => {
    if (busy) return
    busy = true
    void poll().finally(() => (busy = false))
  })

  // 空闲（本会话没有运行、没有待送达）时一个 tick 只有 stat 和两次 store 读：不写 store，不重画
  async function poll() {
    try {
      tick += 1
      const file = `${await homeOf($)}/.pi-bridge/events.ndjson`
      let size = 0
      try {
        size = (await $.fs.stat(file)).size
      } catch {
        return
      }
      const cursorKey = await keyOf($, 'cursor')
      const saved = await $.store.get(cursorKey)
      // 第一次运行不回放历史
      let offset = typeof saved === 'number' ? saved : size
      if (offset > size) offset = 0
      const known = ((await $.store.get(await keyOf($, 'runs'))) ?? {}) as Runs
      const tracking = Object.keys(known).length > 0
      const finished: Array<{ runId: string; what: string }> = []
      const asks: PendingAsk[] = []
      const states = new Map<string, 'running' | 'asking'>()
      const models = new Map<string, { model: string; thinking?: string }>()
      if (size > offset && !tracking) {
        // 别的会话的事件不读不解析，只推进游标；send 登记之前就结束的运行由下面的对账兜底
        offset = size
      } else if (size > offset) {
        const text: string = await $.fs.read(file, { offset, length: size - offset })
        const end = text.lastIndexOf('\n') + 1
        offset += utf8Length(text.slice(0, end))
        for (const line of text.slice(0, end).split('\n').filter(Boolean)) {
          let ev: Json
          try { ev = JSON.parse(line) } catch { continue }
          if (!known[ev.runId]) continue
          if (ev.type === 'ask' && ev.ask) { states.set(ev.runId, 'asking'); asks.push({ session: ev.session, ask: ev.ask }) }
          else if (ev.type === 'answered') states.set(ev.runId, 'running')
          else if (ev.type === 'model') models.set(ev.runId, parseModel(String(ev.text ?? '')))
          else if (ev.type === 'done') finished.push({ runId: ev.runId, what: '已完成' })
          else if (ev.type === 'failed') finished.push({ runId: ev.runId, what: '失败' })
        }
      }
      // 定期对账：事件漏了或运行崩溃时，别让界面上的“运行中”一直挂着
      if (tracking && tick % RECONCILE_EVERY === 0) {
        for (const runId of Object.keys(known)) {
          if (finished.some((f) => f.runId === runId)) continue
          const r = await readRunFile($, runId)
          if (r?.status === 'done' || r?.status === 'failed') finished.push({ runId, what: r.status === 'done' ? '已完成' : '失败' })
        }
      }
      // 通知先进待送达队列，再删运行、推进游标：中途出错最多重复，不会丢
      if (finished.length > 0) {
        const notes: string[] = []
        for (const f of finished) notes.push(await describe($, f.runId, f.what))
        const now = Date.now()
        await mutatePending($, (list) => [
          ...list,
          ...finished.map((f, i) => ({ runId: f.runId, note: notes[i]!, at: now })).filter((n) => n.note && !list.some((o) => o.runId === n.runId)),
        ])
      }
      if (finished.length > 0 || states.size > 0 || models.size > 0) {
        await mutateRuns($, (runs) => {
          for (const [id, s] of states) if (runs[id]) runs[id]!.status = s
          for (const [id, m] of models) if (runs[id]) Object.assign(runs[id]!, m)
          for (const f of finished) delete runs[f.runId]
        })
      }
      if (offset !== saved) await $.store.set(cursorKey, offset)
      // 有运行时每个 tick 重画一次，刷新输入框上方和面板里的耗时
      if (tracking) $.ui.invalidate('ui.render')
      // 提问对话框会一直等到用户回答：不等它，否则别的运行的通知、对账都会跟着停住
      for (const a of asks) void relayAsk($, a).catch((err: Error) => $.ui.log(`pi mod ask failed: ${err.message}`, { to: 'debug' }))
      await flushPending($)
      lastToast = undefined
    } catch (err) {
      const msg = (err as Error).message
      $.ui.log(`pi mod poll failed: ${msg}`, { to: 'debug' })
      // 同一个错误只弹一次，持续出错时不每 2 秒刷屏
      if (msg !== lastToast) {
        lastToast = msg
        $.ui.toast(`PiAgent 轮询出错：${msg.slice(0, 80)}`)
      }
    }
  }
}

async function relayAsk($: any, { session, ask }: PendingAsk) {
  const question = String(ask.title || ask.message || 'pi 在提问').replace(/[?？]?\s*$/, '？')
  let args: string[]
  let stdin: string | undefined
  try {
    let value: string
    if (ask.method === 'select' && Array.isArray(ask.options) && ask.options.length >= 2) {
      value = await $.ui.ask(question, ask.options.slice(0, 4))
    } else {
      // input / editor：只有自由文本，借 “Other” 输入；至少要两个选项
      value = await $.ui.ask(question, ['继续（在 Other 里输入内容）', '取消'])
      if (value === '取消') throw new Error('cancelled')
    }
    args = ['answer', session, ask.id, '--detach', ...(await ownerArgs($)), '-']
    stdin = value
  } catch {
    args = ['answer', session, ask.id, '--detach', '--cancel', ...(await ownerArgs($))]
  }
  const { code, out } = await cli($, args, stdin)
  if (code !== 0) $.ui.toast(`回答 pi 失败：${typeof out === 'string' ? out : out.error}`)
}

const RETRY_SHOWN = 3

async function describe($: any, runId: string, what: string): Promise<string> {
  const failed = what === '失败'
  const r = await readRunFile($, runId)
  if (!r) return `- ${runId} ${what}（读取运行记录失败，可用 PiAgent action=result runId=${runId} 再试）`
  // 失败时报错在前，回复在后：executor 失败前改过哪些文件写在回复末尾的改动清单里
  const parts = failed ? [r.error, r.reply] : [r.reply || r.error]
  const body = parts.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n\n') || '（没有回复内容）'
  const cut = body.length > NOTE_MAX ? `${body.slice(0, NOTE_MAX)}…（全文：PiAgent action=result runId=${runId}）` : body
  // 失败时附上重试记录：路由组会换线路，最终报错只反映最后一条线路。只列最后几次
  const evs = failed ? await runEvents($, runId) : []
  const retries = evs.filter((ev) => ev.type === 'retry').map((ev) => `重试：${String(ev.text ?? '').slice(0, 200)}`)
  const more = retries.length > RETRY_SHOWN ? [`（共重试 ${retries.length} 次，只列最后 ${RETRY_SHOWN} 次）`] : []
  const model = evs.find((ev) => ev.type === 'model')?.text
  return [`- ${r.session} · ${runId} · ${what}${model ? `（模型 ${model}）` : ''}`, ...more, ...retries.slice(-RETRY_SHOWN), cut].join('\n')
}

// 给主 agent 看的运行记录：几行头部加原样正文。不用 JSON，换行不转义，也不带派发时自己写的 message
function formatRun(r: Json): string {
  const head = [
    [r.runId, r.session, r.role, r.status].filter(Boolean).join(' · '),
    `${r.startedAt ?? ''}${r.endedAt ? ` → ${r.endedAt}` : ''}${r.cwd ? ` · ${r.cwd}` : ''}`,
  ]
  if (r.status === 'asking' && r.ask) head.push(`待回答的提问：${JSON.stringify(r.ask)}`)
  if (r.error) head.push(`错误：${r.error}`)
  const reply = String(r.reply ?? '').trim()
  return reply ? `${head.join('\n')}\n\n${reply}` : head.join('\n')
}

const SCOPE_NOTE: Record<string, string> = {
  session: '本会话的 pi 会话（含分出的副本；scope=project 看当前项目的全部，scope=all 看所有项目）',
  project: '当前项目的 pi 会话（owner：mine 本会话，other 别的主会话，- 无主；forkOf：副本的来源）',
  all: '所有项目的 pi 会话（owner：mine 本会话，other 别的主会话，- 无主；forkOf：副本的来源）',
}

// status 只说进程在不在跑；lastRun 才是上次运行的结果（失败附原因，全文用 result 取）。
// 归属以 pi-bridge 记录的 owner 为准，运行表里的（归属字段出现之前派发的）也算本会话
function listTable(sessions: Json[], scope: string, me: string, running: Set<string>): string {
  const lastRun = (l: Json | undefined) => {
    if (!l) return '-'
    const err = l.error ? ` ${String(l.error).replace(/\s+/g, ' ').slice(0, 100)}` : ''
    return `${l.status} ${l.runId} ${l.endedAt ?? l.startedAt}${err}`
  }
  const isMine = (r: Json) => r.owner === me || running.has(String(r.name))
  const wide = scope !== 'session'
  const rows = sessions
    .filter((r) => wide || isMine(r))
    .map((r) => [r.name, ...(wide ? [isMine(r) ? 'mine' : r.owner ? 'other' : '-'] : []), r.status, lastRun(r.lastRun), r.forkOf ?? '-', r.updatedAt, r.cwd].join('\t'))
  const note = SCOPE_NOTE[scope] ?? ''
  if (rows.length === 0) return `${note}\n（没有）`
  return `${note}\n${['name', ...(wide ? ['owner'] : []), 'status', 'lastRun', 'forkOf', 'updatedAt', 'cwd'].join('\t')}\n${rows.join('\n')}`
}

type HistoryMessage = { role: 'user' | 'assistant'; text: string }
const FORK_NOTE = '以下是主 agent（Claude Code）与用户的对话记录，你是从中分出的副本，工具调用与结果都是主 agent 执行的；最后一条用户消息才是交给你的任务。'

export function renderHistory(messages: { role: 'user' | 'assistant'; content: Json[] }[], toolUseId?: string): HistoryMessage[] {
  const blocksText = (blocks: Json[]): string => blocks.map((b): string => {
    switch (b.type) {
      case 'text': return String(b.text ?? '')
      case 'tool_use':
        return b.id === toolUseId ? '' : `[调用工具 ${b.name}] ${JSON.stringify(b.input)}`
      case 'tool_result': {
        const text = typeof b.content === 'string' ? b.content : blocksText(b.content ?? [])
        const cut = text.length > 4000 ? `${text.slice(0, 4000)}…（已截断，原长度 ${text.length} 字符）` : text
        return `[工具结果${b.is_error ? '，出错' : ''}] ${cut}`
      }
      case 'image': return '[图片]'
      case 'document': return '[文档]'
      default: return ''
    }
  }).filter((text) => text !== '').join('\n')
  const history: HistoryMessage[] = []
  for (const m of messages) {
    const text = blocksText(m.content)
    if (!text.trim()) continue
    const last = history.at(-1)
    if (last?.role === m.role) last.text += `\n${text}`
    else history.push({ role: m.role, text })
  }
  if (history[0]?.role !== 'user') history.unshift({ role: 'user', text: '主 agent 的对话记录如下。' })
  history[0]!.text = `${FORK_NOTE}\n\n${history[0]!.text}`
  return history
}

async function send($: any, i: Json) {
  let history: HistoryMessage[] | undefined
  if (i.fork === true) {
    const messages = await $.session.messages(i.agentId ? { agentId: i.agentId, as: 'api' } : { as: 'api' })
    if (!Array.isArray(messages)) return fail(messages.deny)
    history = renderHistory(messages, i.tool_use_id)
  }
  const role = i.role ?? 'advisor'
  const args = ['send', i.session, '--role', role, '--detach', ...(await ownerArgs($))]
  for (const k of ['cwd', 'model', 'thinking'] as const) if (i[k]) args.push(`--${k}`, i[k])
  if (i.worktree) args.push('--worktree')
  if (history) {
    const file = `${await homeOf($)}/.pi-bridge/history/fork-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    await $.fs.write(file, JSON.stringify({ messages: history }))
    args.push('--history-file', file)
  }
  args.push('-')
  const { code, out } = await cli($, args, String(i.message))
  if (code !== 0 || typeof out === 'string') return fail(out)
  await mutateRuns($, (runs) => {
    runs[out.runId] = { session: out.session, role, summary: summaryOf(i), startedAt: Date.now(), status: 'running', model: i.model, thinking: i.thinking }
  })
  // pi-bridge 把属于别的主会话的同名会话改派到了本会话的副本
  const forked = out.session !== i.session
    ? `\n${i.session} 属于另一个主会话，这次派到了本会话的副本 ${out.session}：副本带着分出时 ${i.session} 的全部上下文，之后对 ${i.session} 的派发都进这个副本，两边互不影响。`
    : ''
  return show(`已派发 ${out.runId}（${out.session}）${history ? `\n已 fork 当前对话（${history.length} 条消息）` : ''}${forked}`)
}

async function review($: any, i: Json) {
  const args = ['review', '--detach', ...(await ownerArgs($))]
  if (i.staged) args.push('--staged')
  for (const k of ['base', 'cwd', 'focus', 'model', 'thinking'] as const) if (i[k]) args.push(`--${k}`, i[k])
  const { code, out } = await cli($, args)
  if (code !== 0 || typeof out === 'string') return fail(out)
  await mutateRuns($, (runs) => {
    runs[out.runId] = { session: out.session, role: 'review', summary: summaryOf(i) || '评审', startedAt: Date.now(), status: 'running' }
  })
  return show(`已派发评审 ${out.runId}（${out.session}）`)
}

async function dispatch($: any, i: Json) {
  const need = (...keys: string[]) => keys.filter((k) => i[k] === undefined || i[k] === '').map((k) => `缺少 ${k}`).join('，')
  switch (i.action ?? 'send') {
    case 'send': {
      const miss = need('session', 'message')
      return miss ? fail(miss) : send($, i)
    }
    case 'review':
      return review($, i)
    case 'steer': {
      const miss = need('session', 'message')
      if (miss) return fail(miss)
      const { code, out } = await cli($, ['steer', i.session, '--json', ...(await ownerArgs($)), '-'], String(i.message))
      if (code !== 0) return fail(out)
      return show(typeof out === 'string' ? out : String(out.text ?? ''))
    }
    case 'answer': {
      const miss = need('session', 'askId') || (i.cancel || i.value !== undefined ? '' : '需要 value 或 cancel')
      if (miss) return fail(miss)
      const args = ['answer', i.session, i.askId, '--detach', ...(await ownerArgs($)), ...(i.cancel ? ['--cancel'] : ['-'])]
      const { code, out } = await cli($, args, i.cancel ? undefined : String(i.value))
      if (code !== 0) return fail(out)
      return show('已回答')
    }
    case 'abort':
    case 'stop': {
      const miss = need('session')
      if (miss) return fail(miss)
      const { code, out } = await cli($, [i.action, i.session, '--json', ...(await ownerArgs($))])
      if (code !== 0) return fail(out)
      // 实际作用的会话可能是本会话的副本；自己主动中止的任务，不再为它的失败通知唤醒模型
      const target = typeof out === 'string' ? i.session : String(out.session ?? i.session)
      await mutateRuns($, (runs) => {
        for (const [id, r] of Object.entries(runs)) if (r.session === target) delete runs[id]
      })
      return show(typeof out === 'string' ? out : String(out.text ?? ''))
    }
    case 'list': {
      // all 是旧参数，当 scope=all
      const scope = String(i.scope ?? (i.all ? 'all' : 'session'))
      if (scope !== 'session' && scope !== 'project' && scope !== 'all') return fail(`scope 只能是 session、project 或 all：${scope}`)
      const runs = ((await $.store.get(await keyOf($, 'runs'))) ?? {}) as Runs
      const running = new Set(Object.values(runs).map((r) => r.session))
      // project 交给 pi-bridge 按当前目录所属的项目过滤；session 要跨项目找本会话的，所以取全部再过滤
      const { code, out } = await cli($, ['list', '--json', ...(scope === 'project' ? [] : ['--all']), ...(i.active ? ['--active'] : [])])
      if (code !== 0 || typeof out === 'string') return fail(out)
      return show(listTable(out as unknown as Json[], scope, sessionKey!, running))
    }
    case 'result': {
      const miss = need('runId')
      if (miss) return fail(miss)
      const { code, out } = await cli($, ['result', i.runId])
      if (code !== 0) return fail(out)
      return show(typeof out === 'string' ? out : formatRun(out))
    }
    default:
      return fail(`未知 action：${i.action}`)
  }
}

// 事件文本是 “provider/model 等级”：去掉 provider，等级单独取出
function parseModel(text: string): { model: string; thinking?: string } {
  const parts = text.trim().split(/\s+/)
  const thinking = parts.length > 1 ? parts[parts.length - 1] : undefined
  const name = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] ?? ''
  const slash = name.indexOf('/')
  return { model: slash >= 0 ? name.slice(slash + 1) : name, thinking }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // immediate：主会话运行中输入 /pi 也立即打开面板，不排队等本轮结束（否则看起来像插话）
    await $.command.register({ name: 'pi', description: '查看和管理 PiAgent 任务', immediate: true })
    startPolling($)
    return next(e)
  })

  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined) return listed
    return { value: [...listed.value.filter((t) => t.name !== 'PiAgent'), PI_TOOL as any] }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: 'pi-delegation', text: GUIDE, scope: 'session' as const }] }
  })

  // 主循环的忙闲与送达确认（子 agent 的 turn 不算）
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn.busy = true
      turn.startedAt = await $.clock.now()
      turn.abortedAt = undefined
      await trackClear($)
      // 这一轮就是通知本身：已经进了模型的上下文，算送达
      if (e.text.includes('[pi mod 通知')) await mutatePending($, (list) => list.filter((n) => !e.text.includes(n.runId)))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const startedAt = turn.startedAt
      turn.busy = false
      if (e.isAborted) {
        // 打断会清掉排队中的提示：已提交未确认的通知退回，等用户开口或宽限期过后重发
        turn.abortedAt = await $.clock.now()
        await mutatePending($, (list) => list.map((n) => (n.sentAt !== undefined ? { ...n, sentAt: undefined } : n)))
      } else if (startedAt !== undefined) {
        // 在这一轮开始前就已提交的，已随这一轮送达
        await mutatePending($, (list) => list.filter((n) => n.sentAt === undefined || n.sentAt > startedAt))
      }
    }
    return next(e)
  })

  // 用户发消息时顺带捎上未提交的通知（包括运行中插话）：作为 context，用户看不到，模型读得到
  on('prompt.submit', async ($, e, next) => {
    const kind = (e.origin as Json | undefined)?.kind
    if (e.command || (kind !== 'composer' && kind !== 'bridge')) return next(e)
    const todo = (await readPending($)).filter((n) => n.sentAt === undefined)
    if (todo.length === 0) return next(e)
    const r = await next({ ...e, context: [...(e.context ?? []), noticeText(todo)] })
    if (!('drop' in r && r.drop)) {
      const ids = new Set(todo.map((n) => n.runId))
      await mutatePending($, (list) => list.filter((n) => !ids.has(n.runId)))
    }
    return r
  })

  // 打开面板：不返回 text、不返回 context，所以主会话里没有任何记录
  on('command.run', { command: 'pi' }, async ($) => {
    view.mode = 'list'
    view.sel = undefined
    view.tab = undefined
    view.text = undefined
    await $.ui.open({ id: PANE, title: 'PiAgent', focus: true, closeOnEscape: true })
    return {}
  })

  on('tool.call', { tool: /^PiAgent$/ }, async ($, e) => dispatch($, e as unknown as Json))

  // 调用行压成一行；ctrl+o 展开时放行，看到完整入参。
  // matcher 带上 tool：别的工具行（Bash、Read…）不经过这个钩子，也不用等插件应答才画出来
  on('ui.render', { component: 'ToolUse', props: { tool: 'PiAgent' } }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const i = (e.props.input ?? {}) as Json
    const action = i.action ?? 'send'
    const label = [action, i.session, action === 'send' ? i.role ?? 'advisor' : undefined, summaryOf(i) || undefined]
      .filter(Boolean)
      .join(' · ')
    const { Text } = $.ui.resolve(e)
    return <Text>PiAgent({label})</Text>
  })

  // 输入框上方的常驻一行：有运行中的 PiAgent 才出现
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const runs = Object.values(((await $.store.get(await keyOf($, 'runs'))) ?? {}) as Runs)
    if (runs.length === 0) return next(e)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const asking = runs.filter((r) => r.status === 'asking').length
    const shown = runs.slice(0, 3).map((r) => {
      const how = r.model ? ` ${r.model}${r.thinking ? `·${r.thinking}` : ''}` : r.thinking ? ` ${r.thinking}` : ''
      return `${r.session}${how} ${r.status === 'asking' ? '⏸等回答' : elapsed(now - r.startedAt)}`
    })
    const more = runs.length > 3 ? ` +${runs.length - 3}` : ''
    return (
      <Box>
        <Text color={asking > 0 ? 'warning' : 'success'}>● </Text>
        <Text color="claude" bold>PiAgent </Text>
        <Text color={asking > 0 ? 'warning' : 'success'}>{runs.length} 运行中</Text>
        <Text dimColor> · {shown.join(' · ')}{more}</Text>
      </Box>
    )
  })

  // 光标在列表里移动，下方缩略跟着更新（不用回车）
  on('ui.focus', { requestId: PANE }, ($, e, next) => {
    const el = String(e.element ?? '')
    if (el.startsWith('row-') && view.mode === 'list') {
      const id = el.slice(4)
      if (view.sel !== id) {
        view.sel = id
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  // 面板两层：列表页（tab、列表、虚线、光标项的缩略）和详情页（回车进入，b 返回）。
  // 所有操作都直接调 pi-bridge，不经过模型，不写主会话。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const now = await $.clock.now()
    const runs = Object.entries(((await $.store.get(await keyOf($, 'runs'))) ?? {}) as Runs).sort((a, b) => b[1].startedAt - a[1].startedAt)
    const recent = await readRecent($, await ownedNames($))
    const rows = [
      ...runs.map(([runId, r]) => ({ runId, session: r.session, live: true as const, run: r })),
      ...recent.filter((r) => !runs.some(([id]) => id === r.runId)).map((r) => ({ runId: r.runId, session: r.session, live: false as const, recent: r })),
    ]
    const liveRows = rows.filter((r) => r.live)
    const doneRows = rows.filter((r) => !r.live)
    // 没手动切过就默认：有运行中的看运行中，否则看已完成
    const tab = view.tab ?? (liveRows.length > 0 ? 'running' : 'done')
    const shown = tab === 'running' ? liveRows : doneRows
    const goTab = (t: 'running' | 'done') => { view.tab = t; view.sel = undefined; view.mode = 'list'; $.ui.invalidate('ui.render') }
    const tabs = (
      <Box>
        <Text color="claude" bold>PiAgent   </Text>
        <Button key="tab-running" label={`运行中 ${liveRows.length}`} hotkey="n" onPress={() => goTab('running')}>
          <Text color={tab === 'running' ? 'success' : 'inactive'} bold={tab === 'running'} underline={tab === 'running'}>运行中 {liveRows.length}</Text>
        </Button>
        <Text dimColor>   </Text>
        <Button key="tab-done" label={`已完成 ${doneRows.length}`} hotkey="d" onPress={() => goTab('done')}>
          <Text color={tab === 'done' ? 'suggestion' : 'inactive'} bold={tab === 'done'} underline={tab === 'done'}>已完成 {doneRows.length}</Text>
        </Button>
        <Text dimColor>   Esc 关闭</Text>
      </Box>
    )
    if (shown.length === 0) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>{tab === 'running' ? '没有运行中的任务。' : '本会话的 pi 会话还没有已结束的任务。失败和已中止的也会列在这里。'}</Text>
        </Box>
      )
    }
    const cur = shown.find((r) => r.runId === view.sel) ?? shown[0]!
    const how = (r: Run) => (r.model ? ` ${r.model}${r.thinking ? `·${r.thinking}` : ''}` : '')
    const markOf = (row: (typeof rows)[number]): [string, string] =>
      row.live
        ? row.run.status === 'asking' ? ['⏸', 'warning'] : ['●', 'success']
        : row.recent.status === 'done' ? ['✓', 'success'] : row.recent.status === 'aborted' ? ['■', 'inactive'] : ['✗', 'error']
    const [curMark, curColor] = markOf(cur)

    const evs = cur.live ? await runEvents($, cur.runId) : []
    const tools = evs.filter((x) => x.type === 'tool').map((x) => toolBrief(String(x.text ?? '')))
    const ask = cur.live && cur.run.status === 'asking' ? [...evs].reverse().find((x) => x.type === 'ask')?.ask : undefined
    const back = () => { view.mode = 'list'; view.text = undefined; $.ui.invalidate('ui.render') }

    // ---- 详情页
    if (view.mode === 'steer' && cur.live) {
      return (
        <Box flexDirection="column">
          <Text color="suggestion">给 {cur.session} 插话 <Text dimColor>（回车发送，当前这轮工具执行完后送达）</Text></Text>
          <Input key="steer" autoFocus placeholder="补充指示…" submitLabel="发送" onSubmit={(t) => void paneSteer($, cur.session, t)} />
          <Button key="back" label="返回" hotkey="b" onPress={() => { view.mode = 'detail'; $.ui.invalidate('ui.render') }} />
        </Box>
      )
    }
    if (view.mode === 'detail') {
      const head = (
        <Text wrap="truncate-end">
          <Text color={curColor}>{curMark} </Text>
          <Text bold color="suggestion">{cur.session}</Text>
          {cur.live
            ? <Text dimColor>  {cur.run.role}{how(cur.run)} · {elapsed(now - cur.run.startedAt)}</Text>
            : <Text dimColor>  {cur.recent.status === 'done' ? '已完成' : cur.recent.status === 'aborted' ? '已中止' : '失败'}</Text>}
        </Text>
      )
      if (cur.live) {
        const opts: string[] = ask && Array.isArray(ask.options) ? ask.options.slice(0, 4) : []
        return (
          <Box flexDirection="column">
            {head}
            <Text bold>{cur.run.summary || cur.session}</Text>
            {tools.length > 0 && <Text dimColor wrap="truncate-end">最近 {tools.slice(-8).join(' → ')}</Text>}
            {ask && (
              <Box flexDirection="column">
                <Text color="warning" bold>? {String(ask.title || 'pi 在提问')}</Text>
                {opts.map((o, n) => (
                  <Button key={`ask-${n}`} label={o} hotkey={String(n + 1)} onPress={() => void paneAnswer($, cur.session, ask.id, o)} />
                ))}
              </Box>
            )}
            <Box>
              <Button key="back" label="返回" hotkey="b" onPress={back} />
              <Text>  </Text>
              <Button key="steer-btn" label="插话" hotkey="s" onPress={() => { view.mode = 'steer'; $.ui.invalidate('ui.render') }} />
              <Text>  </Text>
              <Button key="abort-btn" label="中止" hotkey="a" onPress={() => void paneAbort($, cur.runId, cur.session)} />
              <Text>  </Text>
              <Button key="stop-btn" label="停止常驻" hotkey="x" onPress={() => void paneStop($, cur.session)} />
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {head}
          <Text>{view.text ?? '加载中…'}</Text>
          <Button key="back" label="返回" hotkey="b" onPress={back} />
        </Box>
      )
    }

    // ---- 列表页
    const list = shown.map((row) => {
      const picked = row.runId === cur.runId
      const [mark, markColor] = markOf(row)
      const tail = row.live ? `${row.run.role}${how(row.run)}` : row.recent.head
      const time = row.live ? (row.run.status === 'asking' ? '等你回答' : elapsed(now - row.run.startedAt)) : ''
      return (
        <Button key={`row-${row.runId}`} label={`${row.session} ${tail}`} onPress={() => {
          view.sel = row.runId
          view.mode = 'detail'
          view.text = undefined
          if (!row.live) void paneLoad($, row.runId)
          $.ui.invalidate('ui.render')
        }}>
          <Text color={picked ? 'suggestion' : 'inactive'}>{picked ? '▸ ' : '  '}</Text>
          <Text color={markColor}>{mark} </Text>
          <Text bold={picked} color={picked ? 'suggestion' : undefined}>{row.session}</Text>
          <Text dimColor>  {tail}</Text>
          {time !== '' && <Text color={row.live && row.run.status === 'asking' ? 'warning' : 'success'}>  {time}</Text>}
        </Button>
      )
    })
    const preview = cur.live ? (
      <Box flexDirection="column">
        <Text wrap="truncate-end"><Text bold>{cur.run.summary || cur.session}</Text><Text dimColor> · {cur.run.role}{how(cur.run)} · {elapsed(now - cur.run.startedAt)}</Text></Text>
        <Text wrap="truncate-end" dimColor>{ask ? `? ${String(ask.title || 'pi 在提问')}` : tools.length > 0 ? `最近 ${tools.slice(-3).join(' → ')}` : '等待 pi 的第一步…'}</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text wrap="truncate-end"><Text color={curColor}>{cur.recent.status === 'done' ? '已完成' : cur.recent.status === 'aborted' ? '已中止' : '失败'}</Text><Text dimColor> · </Text><Text>{cur.recent.head}</Text></Text>
        <Text dimColor>回车查看完整回复</Text>
      </Box>
    )
    return (
      <Box flexDirection="column">
        {tabs}
        {list}
        <Text color="subtle">╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌</Text>
        {preview}
      </Box>
    )
  })
}

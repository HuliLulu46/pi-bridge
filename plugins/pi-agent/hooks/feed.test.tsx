import { expect, test } from 'claude-code/testing'
import { briefOf, feedOf } from './register'

const T0 = Date.parse('2026-11-18T10:00:00.000Z')
const ev = (runId: string, type: string, text: string | undefined, secs: number) => ({
  ts: new Date(T0 + secs * 1000).toISOString(),
  session: 'feed-s',
  runId,
  type,
  ...(text === undefined ? {} : { text }),
})
const ndjson = (events: unknown[]) => events.map((x) => JSON.stringify(x)).join('\n') + '\n'
const PANE = {
  plugin: 'pi-agent',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'pi',
  props: { title: 'PiAgent', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('briefOf：入参完整时按字段取；截断成非法 JSON 时仍抽出 command / pattern / path', () => {
  expect(briefOf('read {"path":"/a/b/cli.ts"}')).toEqual({ name: 'read', arg: 'cli.ts' })
  expect(briefOf('bash {"command":"pnpm test"}')).toEqual({ name: 'bash', arg: 'pnpm test' })
  // 事件 text 被截到 200 字：command 里的 \n 是转义后的两个字符，结尾没有闭合引号
  expect(briefOf('bash {"command":"cd /Users/x/code && rg -n \\"foo\\"\\nls plugins/pi-bridge/src …')).toEqual({
    name: 'bash',
    arg: 'cd /Users/x/code && rg -n "foo" ls plugins/pi-bridge/src …',
  })
  // 有 pattern 又有 path：先写查什么，再写在哪个文件
  expect(briefOf('grep {"path":"/a/b/index.d.ts","pattern":"type (Session|Tool)|interface …')).toEqual({
    name: 'grep',
    arg: 'type (Session|Tool)|interface …  index.d.ts',
  })
  // 认不出字段就原样给
  expect(briefOf('todo {"action":"start","id":1}')).toEqual({ name: 'todo', arg: '{"action":"start","id":1}' })
  expect(briefOf('ping')).toEqual({ name: 'ping', arg: '' })
})

test('feedOf：只留动作类事件；start / model / done 不进信息流', () => {
  const rows = feedOf([
    ev('r', 'start', '任务', 0),
    ev('r', 'model', 'p/m high', 1),
    ev('r', 'tool', 'read {"path":"/a/cli.ts"}', 2),
    ev('r', 'tool-error', 'bash: exit 1', 3),
    ev('r', 'retry', '1/3 rate limit', 4),
    ev('r', 'steer', '改用 rg', 5),
    ev('r', 'done', undefined, 6),
  ])
  expect(rows.map((r) => `${r.mark}${r.name}|${r.arg}`)).toEqual([
    ' read|cli.ts',
    '✗error|bash: exit 1',
    '⟳retry|1/3 rate limit',
    '↪steer|改用 rg',
  ])
  expect(rows[0]!.at).toBe(T0 + 2000)
})

function liveWorld(on: any, events: unknown[], now: number, status = 'running') {
  on('store.get', (_: any, e: any) => {
    const k = String(e.key ?? '')
    if (k.startsWith('runs:')) return { value: { 'r-x': { session: 'feed-live', role: 'advisor', summary: '信息流测试', startedAt: now - 20000, status } } }
    return { value: undefined }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('store.delete', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/x\n', stderr: '' } }))
  const text = ndjson(events)
  on('fs.stat', () => ({ value: { size: text.length, kind: 'file' } }))
  on('fs.read', () => ({ value: text }))
  on('clock.now', () => ({ value: now }))
}

test('运行中详情：显示按时间排列的动作流，最后一条标为当前动作并带持续时长', async ($: any, on: any) => {
  liveWorld(
    on,
    [
      ev('r-x', 'start', '任务', 0),
      ev('r-x', 'model', 'p/m high', 1),
      ev('r-x', 'tool', 'read {"path":"/a/b/cli.ts"}', 4),
      ev('r-x', 'tool-error', 'bash: exit 1', 7),
      ev('r-x', 'retry', '1/3 rate limit', 9),
      ev('r-other', 'tool', 'read {"path":"/other/leak.ts"}', 10),
      ev('r-x', 'tool', 'bash {"command":"pnpm test --filter pane && echo done\\nrg -n \\"foo\\" plugins/pi-bridge/src …', 14),
    ],
    T0 + 20000,
  )
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Text', text: /cli\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /exit 1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1\/3 rate limit/ })).toBeTruthy()
  // 截断的 bash 命令显示命令本身，不是只剩工具名
  expect(await ui.find({ type: 'Text', text: /pnpm test --filter pane/ })).toBeTruthy()
  // 别的运行的事件不混进来
  expect(await ui.find({ type: 'Text', text: /leak\.ts/ })).toBeFalsy()
  // 最后一条事件在 14s，现在是 20s：当前动作已持续 6s
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*6s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'abort-btn' })).toBeTruthy()
  await ui.unmount()
})

test('运行中详情：已经开始、还没有任何动作时，pi 在生成第一条回复，显示 thinking', async ($: any, on: any) => {
  liveWorld(on, [ev('r-x', 'start', '任务', 0)], T0 + 3000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*3s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Waiting for pi to start/ })).toBeFalsy()
  await ui.unmount()
})

test('运行中详情：连 start 事件都还没有时给出等待提示', async ($: any, on: any) => {
  liveWorld(on, [], T0 + 3000)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Text', text: /Waiting for pi to start/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeFalsy()
  await ui.unmount()
})

// ---- 已完成详情
const R1 = 'r-aaa111-111111'
function doneWorld(on: any, logs: { current: string; rotated?: string }) {
  on('store.get', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/h\n', stderr: '' } }))
  const entry = (name: string) => ({ name, kind: 'file', size: 100, mtimeMs: 1000, isLink: false })
  on('fs.list', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith('/runs')) return { value: [entry(`${R1}.json`)] }
    if (path.endsWith('/sessions')) return { value: [entry('mine-s.json')] }
    return { value: [] }
  })
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith(`/runs/${R1}.json`)) return { value: JSON.stringify({ runId: R1, session: 'mine-s', status: 'done', reply: '最终回复在这里', endedAt: '2026-11-18T10:05:00.000Z' }) }
    if (path.endsWith('/sessions/mine-s.json')) return { value: JSON.stringify({ name: 'mine-s', cwd: '/w', owner: 's1' }) }
    if (path.endsWith('/events.ndjson.1')) return { value: logs.rotated ?? '' }
    if (path.endsWith('/events.ndjson')) return { value: logs.current }
    return { value: '' }
  })
  on('fs.stat', () => ({ value: { size: logs.current.length, kind: 'file' } }))
  on('clock.now', () => ({ value: T0 + 600_000 }))
}

test('已完成详情：动作流（含轮转到 .1 的部分）排在回复前面', async ($: any, on: any) => {
  doneWorld(on, {
    rotated: ndjson([ev(R1, 'start', '任务', 0), ev(R1, 'tool', 'read {"path":"/old/first.ts"}', 1)]),
    current: ndjson([
      ev(R1, 'tool', 'edit {"path":"/new/second.ts","content":"…', 2),
      ev('r-other', 'tool', 'read {"path":"/other/leak.ts"}', 3),
      ev(R1, 'done', undefined, 4),
    ]),
  })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /最终回复在这里/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /first\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /second\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /leak\.ts/ })).toBeFalsy()
  // 已完成的不标“当前动作”
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeFalsy()
  await ui.unmount()
})

test('已完成详情：事件日志里找不到这次运行时说明原因，回复照常显示', async ($: any, on: any) => {
  doneWorld(on, { current: ndjson([ev('r-other', 'tool', 'read {"path":"/other/leak.ts"}', 3)]) })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /最终回复在这里/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /rotated away/ })).toBeTruthy()
  await ui.unmount()
})

// ---- 盯着运行中的任务看它跑完
const OTHER = 'r-bbb222-222222'
function handoffWorld(on: any, phase: { done: boolean; other: boolean }, now: number) {
  on('store.get', (_: any, e: any) => {
    if (!String(e.key ?? '').startsWith('runs:')) return { value: undefined }
    const runs: Record<string, unknown> = {}
    if (!phase.done) runs[R1] = { session: 'mine-s', role: 'advisor', summary: '盯着的任务', startedAt: now - 20000, status: 'running' }
    if (phase.other) runs[OTHER] = { session: 'other-s', role: 'advisor', summary: '另一个任务', startedAt: now - 5000, status: 'running' }
    return { value: runs }
  })
  on('store.delete', () => ({ value: undefined }))
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/h\n', stderr: '' } }))
  const entry = (name: string) => ({ name, kind: 'file', size: 100, mtimeMs: 1000, isLink: false })
  on('fs.list', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith('/runs')) return { value: [entry(`${R1}.json`)] }
    if (path.endsWith('/sessions')) return { value: [entry('mine-s.json')] }
    return { value: [] }
  })
  const log = ndjson([ev(R1, 'tool', 'read {"path":"/a/b/cli.ts"}', 4), ev(R1, 'done', undefined, 9)])
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path)
    // 运行记录一开始就是 done：面板的“已完成”缓存只刷新一次，测试里不等 5 秒
    if (path.endsWith(`/runs/${R1}.json`)) return { value: JSON.stringify({ runId: R1, session: 'mine-s', status: 'done', reply: '最终回复在这里', endedAt: '2026-11-18T10:00:09.000Z' }) }
    if (path.endsWith('/sessions/mine-s.json')) return { value: JSON.stringify({ name: 'mine-s', cwd: '/w', owner: 's1' }) }
    if (path.endsWith('/events.ndjson')) return { value: log }
    return { value: '' }
  })
  on('fs.stat', () => ({ value: { size: log.length, kind: 'file' } }))
  on('clock.now', () => ({ value: now }))
}

test('盯着运行中的任务看它跑完：详情页自动加载回复和动作流，不停在 Loading…', async ($: any, on: any) => {
  const phase = { done: false, other: false }
  handoffWorld(on, phase, T0 + 20000)
  const first = await $.ui.mount(PANE)
  await first.press({ key: `row-${R1}` })
  expect(await first.find({ type: 'Button', key: 'abort-btn' })).toBeTruthy()
  await first.unmount()
  // view 是模块级状态：重新挂载等于“任务结束后的下一次重画”，仍停在详情页、选中同一个任务
  phase.done = true
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /最终回复在这里/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /cli\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Loading/ })).toBeFalsy()
  await ui.unmount()
})

test('盯着的任务跑完时别的任务还在运行：详情页留在这个任务上，不跳到别的任务', async ($: any, on: any) => {
  const phase = { done: false, other: false }
  handoffWorld(on, phase, T0 + 20000)
  const first = await $.ui.mount(PANE)
  await first.press({ key: `row-${R1}` })
  await first.unmount()
  phase.done = true
  phase.other = true
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /最终回复在这里/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /另一个任务/ })).toBeFalsy()
  await ui.unmount()
})

test('运行中详情：pi 的提问排在动作流上面', async ($: any, on: any) => {
  const events = [
    ev('r-x', 'tool', 'read {"path":"/a/b/cli.ts"}', 4),
    { ...ev('r-x', 'ask', '选哪个方案？', 6), ask: { id: 'a1', title: '选哪个方案？', options: ['方案甲', '方案乙'] } },
  ]
  liveWorld(on, events, T0 + 10000, 'asking')
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Button', key: 'ask-0' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /cli\.ts/ })).toBeTruthy()
  // asking 时最后一条不是“当前动作”
  expect(await ui.find({ type: 'Text', text: /▸/ })).toBeFalsy()
  await ui.unmount()
})

// ---- 动作记录（runs/<runId>.activity.ndjson）
const act = (type: string, text: string | undefined, secs: number, extra: Record<string, unknown> = {}) => ({ ...ev(R1, type, text, secs), ...extra })

test('feedOf：按调用 id 配对工具开始与结束，得出耗时；没结束的标 open；pi 写的话成行', () => {
  const rows = feedOf([
    act('note', '先看看\n cli.ts', 1),
    act('tool', 'read {"path":"/a/cli.ts"}', 2, { id: 'c1' }),
    act('tool', 'bash {"command":"pnpm test"}', 3, { id: 'c2' }),
    act('tool-end', 'read', 4.5, { id: 'c1' }),
  ])
  expect(rows.map((r) => [r.name, r.arg, r.ms, r.open, r.note])).toEqual([
    ['pi', '先看看 cli.ts', undefined, undefined, true],
    ['read', 'cli.ts', 2500, undefined, undefined],
    ['bash', 'pnpm test', undefined, true, undefined],
  ])
})

function activityWorld(on: any, logs: { activity: string; global?: string }, opts: { live?: string; now: number }) {
  on('store.get', (_: any, e: any) => {
    if (!String(e.key ?? '').startsWith('runs:') || !opts.live) return { value: undefined }
    return { value: { [R1]: { session: 'mine-s', role: 'executor', summary: '动作记录测试', startedAt: T0, status: opts.live } } }
  })
  on('store.delete', () => ({ value: undefined }))
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/h\n', stderr: '' } }))
  const entry = (name: string) => ({ name, kind: 'file', size: 100, mtimeMs: 1000, isLink: false })
  on('fs.list', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith('/runs')) return { value: [entry(`${R1}.json`)] }
    if (path.endsWith('/sessions')) return { value: [entry('mine-s.json')] }
    return { value: [] }
  })
  const files = (path: string) =>
    path.endsWith(`/runs/${R1}.activity.ndjson`) ? logs.activity : path.endsWith('/events.ndjson') ? (logs.global ?? '') : undefined
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith(`/runs/${R1}.json`)) return { value: JSON.stringify({ runId: R1, session: 'mine-s', status: 'done', reply: '最终回复在这里', endedAt: '2026-11-18T10:05:00.000Z' }) }
    if (path.endsWith('/sessions/mine-s.json')) return { value: JSON.stringify({ name: 'mine-s', cwd: '/w', owner: 's1' }) }
    return { value: files(path) ?? '' }
  })
  on('fs.stat', (_: any, e: any) => {
    const text = files(String(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: { size: text.length, kind: 'file' } }
  })
  on('clock.now', () => ({ value: opts.now }))
}

test('运行中详情（动作记录）：在跑的工具是当前动作，跑完的工具带耗时，pi 写的话也在流里', async ($: any, on: any) => {
  activityWorld(on, {
    activity: ndjson([
      act('start', '任务', 0),
      act('note', '先看看 cli.ts', 1),
      act('tool', 'read {"path":"/a/cli.ts"}', 2, { id: 'c1' }),
      act('tool-end', 'read', 3.5, { id: 'c1' }),
      act('tool', 'ls {"path":"/a"}', 4.25, { id: 'c0' }),
      act('tool-end', 'ls', 4.375, { id: 'c0' }),
      act('tool', 'bash {"command":"pnpm test"}', 5, { id: 'c2' }),
      // 并行：bash 还在跑，后开始的 grep 先结束，最后一行不是当前动作
      act('tool', 'grep {"pattern":"TODO"}', 6, { id: 'c3' }),
      act('tool-end', 'grep', 8, { id: 'c3' }),
    ]),
  }, { live: 'running', now: T0 + 12000 })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /先看看 cli\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*1\.5s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*2\.0s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*125ms$/ })).toBeTruthy()
  // bash 在 5s 开始、还没结束，现在 12s：当前动作已持续 7s；grep 不是当前动作
  expect(await ui.find({ type: 'Text', text: /^\s*7s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*6s$/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeFalsy()
  await ui.unmount()
})

test('运行中详情（动作记录）：没有工具在跑时显示 pi 在想，时长从最后一条事件算起', async ($: any, on: any) => {
  activityWorld(on, {
    activity: ndjson([
      act('start', '任务', 0),
      act('tool', 'read {"path":"/a/cli.ts"}', 2, { id: 'c1' }),
      act('tool-end', 'read', 4, { id: 'c1' }),
    ]),
  }, { live: 'running', now: T0 + 13000 })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\s*9s$/ })).toBeTruthy()
  await ui.unmount()
})

test('运行中详情（动作记录）：并行工具超过显示上限时，最早开始、仍在跑的工具也留在流里并标为当前动作', async ($: any, on: any) => {
  const reads = Array.from({ length: 11 }, (_, n) => [
    act('tool', `read {"path":"/a/f${n}.ts"}`, 2, { id: `r${n}` }),
    act('tool-end', 'read', 3, { id: `r${n}` }),
  ]).flat()
  activityWorld(on, {
    activity: ndjson([act('start', '任务', 0), act('tool', 'bash {"command":"pnpm build"}', 1, { id: 'slow' }), ...reads]),
  }, { live: 'running', now: T0 + 10000 })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /pnpm build/ })).toBeTruthy()
  // bash 在 1s 开始、还在跑，现在 10s
  expect(await ui.find({ type: 'Text', text: /^\s*9s$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /thinking/ })).toBeFalsy()
  await ui.unmount()
})

test('已完成详情：有动作记录时读动作记录，不再去全局日志里找', async ($: any, on: any) => {
  activityWorld(on, {
    activity: ndjson([act('start', '任务', 0), act('note', '只在动作记录里的说明', 1), act('done', undefined, 2)]),
    global: ndjson([ev(R1, 'tool', 'read {"path":"/only/global.ts"}', 1)]),
  }, { now: T0 + 600_000 })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /只在动作记录里的说明/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /global\.ts/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /最终回复在这里/ })).toBeTruthy()
  await ui.unmount()
})

test('已完成详情：只有 start / done、没有工具调用时说明没有动作', async ($: any, on: any) => {
  doneWorld(on, { current: ndjson([ev(R1, 'start', '任务', 0), ev(R1, 'done', undefined, 1)]) })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: `row-${R1}` })
  expect(await ui.find({ type: 'Text', text: /No tool calls/ })).toBeTruthy()
  await ui.unmount()
})

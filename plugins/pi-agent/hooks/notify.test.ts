import { expect, mock, test } from 'claude-code/testing'

// 完成/失败通知的送达：忙时不提交、打断后不丢、用户消息顺带捎上
const RUN = 'r-abc123-7363f7'
const RUN2 = 'r-abc124-7363f8'
const line = (ev: Record<string, unknown>) => JSON.stringify(ev) + '\n'
const FAILED = line({ runId: RUN, session: 'gunjo', type: 'failed', text: '429' })
const running = (session: string) => ({ session, role: 'advisor', summary: 't', startedAt: 0, status: 'running' })
// pi-bridge 的运行记录（~/.pi-bridge/runs/<runId>.json），mod 直接读文件
const RECORDS: Record<string, Record<string, unknown>> = {
  [RUN]: { runId: RUN, session: 'gunjo', status: 'failed', error: '429 额度已用尽', reply: '写了一半\n\n改动：a.ts' },
  [RUN2]: { runId: RUN2, session: 'other', status: 'done', reply: '改好了' },
}

function world($: any, on: any, runs: Record<string, unknown> = { [RUN]: running('gunjo') }) {
  mock.store(on, { [`runs:s1`]: runs, 'cursor:s1': 0 })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv ?? e.command ?? []
    if (argv[0] === 'printenv') return { value: { exitCode: 0, stdout: '/h\n', stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected cli call' } }
  })
  // 事件日志：一开始为空，append() 追加事件
  let log = ''
  let stats = 0
  on('fs.stat', () => { stats += 1; return { value: { size: log.length, kind: 'file' } } })
  on('fs.read', (_: any, e: any) => {
    const m = /\/runs\/(r-[^/]+)\.json$/.exec(String(e.path))
    if (m) return { value: JSON.stringify(RECORDS[m[1]!]) }
    return { value: log.slice(e.offset ?? 0) }
  })
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  const submits: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    if (e.origin?.kind === 'plugin') submits.push(e.text)
    return { text: e.text, context: e.context }
  })
  return {
    clock,
    submits,
    failed: () => { log = FAILED },
    append: (ev: Record<string, unknown>) => { log += line(ev) },
    stats: () => stats,
  }
}

test('主会话忙时不提交，正常结束后下一个 tick 提交一次', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '干活', turnId: 't1' })
  w.failed()
  await w.clock.advance(4000)
  expect(w.submits.length).toBe(0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await w.clock.advance(2000)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain(RUN)
  // 失败通知：报错和回复末尾的改动清单都在
  expect(w.submits[0]).toContain('429')
  expect(w.submits[0]).toContain('a.ts')
  // 通知这一轮开始：算送达；之后不再重复
  await $.turn.start({ text: w.submits[0]!, turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  await w.clock.advance(6000)
  expect(w.submits.length).toBe(1)
})

test('被打断后：用户下一条消息捎上通知，不再单独提交', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '干活', turnId: 't1' })
  w.failed()
  await w.clock.advance(4000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
  await w.clock.advance(4000)
  expect(w.submits.length).toBe(0)
  const r: any = await ($.prompt.submit as any)({ text: '继续', origin: { kind: 'composer' }, wait: false })
  expect(String(r.context?.join('\n') ?? '')).toContain(RUN)
  await w.clock.advance(40_000)
  expect(w.submits.length).toBe(0)
})

test('被打断后用户一直不说话：宽限期过后自动提交', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '干活', turnId: 't1' })
  w.failed()
  await w.clock.advance(4000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
  await w.clock.advance(20_000)
  expect(w.submits.length).toBe(0)
  await w.clock.advance(14_000)
  expect(w.submits.length).toBe(1)
})

test('已提交的通知排队时被打断：退回待送达，之后重发', async ($, on) => {
  const w = world($, on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  w.failed()
  await w.clock.advance(2000)
  expect(w.submits.length).toBe(1)
  await w.clock.advance(4000)
  expect(w.submits.length).toBe(1)
  // 模拟重载后忙闲未知、通知排在一轮后面，这一轮被打断
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'tx', reason: 'aborted' } as any)
  await w.clock.advance(4000)
  expect(w.submits.length).toBe(1)
  await w.clock.advance(28_000)
  expect(w.submits.length).toBe(2)
})

test('等用户回答 pi 的提问时，别的运行完成照样通知', async ($, on) => {
  const w = world($, on, { [RUN]: running('gunjo'), [RUN2]: running('other') })
  let asked = 0
  // $.ui.ask 走 AskUserQuestion 的 tool.call；用户一直不回答，对话框挂着
  on('tool.call', { tool: 'AskUserQuestion' }, () => { asked += 1; return new Promise(() => {}) })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  w.append({ runId: RUN, session: 'gunjo', type: 'ask', ask: { id: 'ask-1', method: 'select', title: 'pick one', options: ['1. A', '2. B'] } })
  await w.clock.advance(2000)
  expect(asked).toBe(1)
  w.append({ runId: RUN2, session: 'other', type: 'done' })
  await w.clock.advance(2000)
  // 旧写法 await 对话框时，轮询在这里停住，stat 次数不再增加
  expect(w.stats()).toBe(2)
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain(RUN2)
  expect(w.submits[0]).toContain('改好了')
  expect(asked).toBe(1)
})

test('空闲：别的会话的事件只推进游标，不读不解析，不写 store，不重画', async ($: any, on: any) => {
  const store = new Map<string, unknown>([['cursor:s1', 0], ['recent:old', []]])
  let sets = 0
  let invalidates = 0
  let eventReads = 0
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { sets += 1; store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.invalidate', () => { invalidates += 1; return { value: undefined } })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/h\n', stderr: '' } }))
  let log = ''
  on('fs.stat', () => ({ value: { size: log.length, kind: 'file' } }))
  on('fs.read', () => { eventReads += 1; return { value: log } })
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  // 旧版本留下的 recent:* 被清掉
  expect(store.has('recent:old')).toBe(false)
  log += line({ runId: 'r-zzz999-aaaaaa', session: 'x', type: 'start' })
  await clock.advance(2000)
  expect(store.get('cursor:s1')).toBe(log.length)
  const before = sets
  await clock.advance(10_000)
  expect(sets).toBe(before)
  expect(invalidates).toBe(0)
  expect(eventReads).toBe(0)
})

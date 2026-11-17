import { expect, mock, test } from 'claude-code/testing'

// 归属以 pi-bridge 会话记录的 owner 为准：面板和 list 默认只看本主会话的；scope=project / all 看更多
const R1 = 'r-aaa111-111111'
const R2 = 'r-aaa222-222222'
const RUNS: Record<string, Record<string, unknown>> = {
  [R1]: { runId: R1, session: 'mine-s', status: 'done', reply: '我的结果', endedAt: '2026-11-17T10:00:00.000Z' },
  [R2]: { runId: R2, session: 'other-s', status: 'done', reply: '别人的结果', endedAt: '2026-11-17T11:00:00.000Z' },
}
const RECORDS: Record<string, Record<string, unknown>> = {
  'mine-s': { name: 'mine-s', cwd: '/w', owner: 's1' },
  'other-s': { name: 'other-s', cwd: '/w', owner: 's2' },
}
const SESSIONS = [
  { name: 'mine-s', status: 'idle', updatedAt: 't1', cwd: '/w', owner: 's1' },
  { name: 'claimed-s', status: 'idle', updatedAt: 't2', cwd: '/elsewhere', owner: 's1' },
  { name: 'fork-s.s1', status: 'idle', updatedAt: 't2', cwd: '/w', owner: 's1', forkOf: 'other-s' },
  { name: 'legacy-s', status: 'idle', updatedAt: 't3', cwd: '/w' },
  { name: 'other-s', status: 'idle', updatedAt: 't4', cwd: '/w', owner: 's2' },
  { name: 'free-s', status: 'idle', updatedAt: 't5', cwd: '/w' },
]
const LEGACY_RUN = { 'r-bbb333-333333': { session: 'legacy-s', role: 'advisor', summary: '', startedAt: 0, status: 'running' } }

function world(on: any, opts: { store?: Record<string, unknown>; customStore?: boolean } = {}) {
  if (!opts.customStore) mock.store(on, opts.store ?? {})
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  const calls: string[][] = []
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv ?? []
    if (argv[0] === 'printenv') return { value: { exitCode: 0, stdout: '/h\n', stderr: '' } }
    const args = argv.slice(2)
    calls.push(args)
    if (args[0] === 'send') {
      const session = args[1] === 'other-s' ? 'other-s.s1' : args[1]
      return { value: { exitCode: 0, stdout: JSON.stringify({ session, runId: 'r-ccc444-444444', status: 'running' }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(SESSIONS), stderr: '' } }
  })
  const entries = (names: string[]) => names.map((name, n) => ({ name, kind: 'file', size: 100 + n, mtimeMs: 1000 + n, isLink: false }))
  on('fs.list', (_: any, e: any) => {
    const path = String(e.path)
    if (path.endsWith('/runs')) return { value: entries([...Object.keys(RUNS).map((id) => `${id}.json`), 'x.tmp']) }
    if (path.endsWith('/sessions')) return { value: entries(Object.keys(RECORDS).map((name) => `${name}.json`)) }
    return { value: [] }
  })
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path)
    const run = /\/runs\/(r-[^/]+)\.json$/.exec(path)
    if (run) return { value: JSON.stringify(RUNS[run[1]!]) }
    const rec = /\/sessions\/([^/]+)\.json$/.exec(path)
    if (rec) return { value: JSON.stringify(RECORDS[rec[1]!]) }
    return { value: '' }
  })
  on('fs.stat', () => ({ value: { size: 0, kind: 'file' } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-17T12:00:00.000Z') }))
  return { calls }
}

const call = async ($: any, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'PiAgent', ...input })).result ?? '')
const list = ($: any, input: Record<string, unknown>) => call($, { action: 'list', ...input })

test('list 缺省 scope=session：只列 owner 是本会话的（含副本、认领的、运行表里的旧会话），跨项目取全部再过滤', async ($: any, on: any) => {
  const w = world(on, { store: { 'runs:s1': LEGACY_RUN } })
  const out = await list($, {})
  for (const name of ['mine-s', 'claimed-s', 'fork-s.s1', 'legacy-s']) expect(out).toContain(name)
  expect(out).not.toMatch(/^other-s\t/m)
  expect(out).not.toContain('free-s')
  expect(out).toContain('scope=project')
  expect(w.calls.at(-1)).toContain('--all')
})

test('list scope=project：交给 pi-bridge 按项目过滤，owner 列标 mine/other/-，forkOf 列标来源；旧参数 all 当 scope=all', async ($: any, on: any) => {
  const w = world(on)
  const out = await list($, { scope: 'project' })
  expect(w.calls.at(-1)).not.toContain('--all')
  expect(out).toMatch(/^mine-s\tmine\t/m)
  expect(out).toMatch(/^other-s\tother\t/m)
  expect(out).toMatch(/^free-s\t-\t/m)
  expect(out).toMatch(/^fork-s\.s1\tmine\t.*\tother-s\t/m)
  await list($, { all: true })
  expect(w.calls.at(-1)).toContain('--all')
})

test('send 带 --owner；被改派到副本时结果里说明', async ($: any, on: any) => {
  const w = world(on)
  const mine = await call($, { action: 'send', session: 'mine-s', message: 'hi' })
  expect(w.calls.at(-1)).toEqual(expect.arrayContaining(['--owner', 's1']))
  expect(mine).not.toContain('副本')
  const other = await call($, { action: 'send', session: 'other-s', message: 'hi' })
  expect(other).toContain('other-s.s1')
  expect(other).toContain('属于另一个主会话')
})

test('面板已完成页：只显示 owner 是本会话的 pi 会话的运行', async ($: any, on: any) => {
  world(on)
  const ui = await $.ui.mount({
    plugin: 'pi',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pi',
    props: { title: 'PiAgent', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Button', key: `row-${R1}` })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: `row-${R2}` })).toBeFalsy()
  await ui.unmount()
})

test('/clear 换了 transcript id：记下别名，归属仍是原来的主会话', async ($: any, on: any) => {
  const store = new Map<string, unknown>()
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  let tid = 's1'
  on('session.id', () => ({ value: tid }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  const w = world(on, { customStore: true })
  await $.turn.start({ text: '第一轮', turnId: 't1' })
  tid = 't-after-clear'
  await $.turn.start({ text: '/clear 之后', turnId: 't2' })
  expect(store.get('alias:t-after-clear')).toBe('s1')
  await call($, { action: 'send', session: 'mine-s', message: 'hi' })
  expect(w.calls.at(-1)).toEqual(expect.arrayContaining(['--owner', 's1']))
})

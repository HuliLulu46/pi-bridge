import { expect, test } from 'claude-code/testing'

type Options = {
  tid?: string
  env?: string
  transcript?: string
  readError?: boolean
  store?: Record<string, unknown>
  holdRead?: boolean
}

function world(on: any, opts: Options = {}) {
  const tid = opts.tid ?? 'new-id'
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const keys: string[] = []
  const writes: string[] = []
  on('store.get', (_: any, e: any) => { keys.push(e.key); return { value: store.get(e.key) } })
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); writes.push(e.key); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: tid }))
  let infos = 0
  on('session.info', () => { infos += 1; return { value: { transcriptPath: '/w/current.jsonl' } } })
  let envReads = 0
  on('process.hookEnv', () => { envReads += 1; return { value: { CLAUDE_CODE_SESSION_ID: opts.env ?? 'env-id' } } })
  let reads = 0
  let release!: () => void
  let entered!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  on('fs.read', async (_: any, e: any) => {
    expect(e.path).toBe('/w/current.jsonl')
    reads += 1
    entered()
    if (opts.holdRead) await gate
    if (opts.readError) throw new Error('ENOENT')
    return { value: opts.transcript ?? '' }
  })
  const calls: string[][] = []
  on('process.run', (_: any, e: any) => {
    const args: string[] = e.argv.slice(2)
    calls.push(args)
    const out = args[0] === 'list'
      ? [{ name: 'restored-session', owner: 'old-id', status: 'idle' }]
      : { session: args[1], runId: 'r-abc123-123abc' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } }
  })
  on('clock.now', () => ({ value: 1000 }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  return { store, keys, writes, calls, reading, release, reads: () => reads, infos: () => infos, envReads: () => envReads }
}

const send = ($: any) => $.tool.call({ tool: 'PiAgent', session: 'restored-session', message: '任务' })
const line = (value: unknown) => JSON.stringify(value)

test('恢复归属：取最后一个不同的顶层 session_id，认回旧键并写当前 alias', async ($: any, on: any) => {
  const w = world(on, { store: { 'pending:old-id': [{ runId: 'r-old123-123abc', note: '旧通知', at: 0, sentAt: 1 }] }, transcript: [
    line({ session_id: 'earlier-id', sessionId: 'new-id' }),
    line({ session_id: 'old-id', sessionId: 'new-id' }),
    '{"session_id": broken',
    line({ session_id: 'new-id', sessionId: 'new-id' }),
    line({ session_id: '', nested: { session_id: 'nested-id' } }),
    line({ session_id: 123 }),
    line({ nested: { session_id: 'nested-id' } }),
    line({ sessionId: 'rewritten-id' }),
  ].join('\n') })
  await send($)
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'old-id']))
  expect(w.store.get('alias:new-id')).toBe('old-id')
  expect(w.store.has('runs:old-id')).toBe(true)
  expect(w.envReads()).toBe(0)
  const out = await $.tool.call({ tool: 'PiAgent', action: 'list' })
  expect(String(out.result)).toContain('restored-session')
  await $.turn.start({ text: '[pi mod notice] r-old123-123abc done', turnId: 't1' })
  expect(w.keys).toContain('pending:old-id')
  expect(w.store.has('pending:old-id')).toBe(false)
  expect(w.reads()).toBe(1)
})

test('恢复归属：前驱已有 alias 时认回最终归属键', async ($: any, on: any) => {
  const w = world(on, { transcript: line({ session_id: 'previous-clear-id' }), store: { 'alias:previous-clear-id': 'root-id' } })
  await send($)
  expect(w.store.get('alias:new-id')).toBe('root-id')
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'root-id']))
  expect(w.store.has('runs:root-id')).toBe(true)
  expect(w.envReads()).toBe(0)
})

test('已有当前 alias 时直接复用，不读 transcript 或环境', async ($: any, on: any) => {
  const w = world(on, { store: { 'alias:new-id': 'known-id' }, transcript: line({ session_id: 'wrong-id' }) })
  await send($)
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'known-id']))
  expect(w.infos()).toBe(0)
  expect(w.reads()).toBe(0)
  expect(w.envReads()).toBe(0)
})

test('没有前驱时保持 env 优先，不写 alias', async ($: any, on: any) => {
  const w = world(on, { transcript: line({ session_id: 'new-id', sessionId: 'old-id' }) })
  await send($)
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'env-id']))
  expect(w.store.has('alias:new-id')).toBe(false)
  expect(w.envReads()).toBe(1)
})

test('没有前驱且 env 为空时回退 transcript id', async ($: any, on: any) => {
  const w = world(on, { env: '', transcript: '' })
  await send($)
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'new-id']))
  expect(w.store.has('alias:new-id')).toBe(false)
})

test('读取 transcript 失败时静默回退原环境归属', async ($: any, on: any) => {
  const w = world(on, { readError: true })
  await send($)
  expect(w.calls[0]).toEqual(expect.arrayContaining(['--owner', 'env-id']))
  expect(w.store.has('alias:new-id')).toBe(false)
})

test('并发首次调用共享初始化 Promise：只读取一次 transcript、只写一次 alias', async ($: any, on: any) => {
  const w = world(on, { holdRead: true, transcript: line({ session_id: 'old-id' }) })
  const first = send($)
  await w.reading
  const second = $.tool.call({ tool: 'PiAgent', action: 'list' })
  w.release()
  await Promise.all([first, second])
  expect(w.reads()).toBe(1)
  expect(w.infos()).toBe(1)
  expect(w.writes.filter((key) => key === 'alias:new-id').length).toBe(1)
  expect(w.calls.find((args) => args[0] === 'send')).toEqual(expect.arrayContaining(['--owner', 'old-id']))
})

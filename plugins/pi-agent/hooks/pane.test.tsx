import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pi-agent',
  component: 'Pane',
  requestId: 'pi',
  props: { title: 'PiAgent', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('running tab draws list and detail', async ($, on) => {
  const now = Date.now()
  on('store.get', (_, e: any) => {
    const k = String((e as any).key ?? '')
    if (k.startsWith('runs:')) return { value: { 'r-x': { session: 'tab-test', role: 'advisor', summary: 'tab 测试', startedAt: now - 5000, status: 'running', model: 'codex/gpt-6-luna', thinking: 'high' } } }
    return { value: undefined }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('store.delete', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/x\n', stderr: '' } }))
  const ev = [
    { runId: 'r-x', type: 'tool', text: 'read {"path":"/a/b/cli.ts"}' },
    { runId: 'r-x', type: 'tool', text: 'read {"path":"/a/b/daemon.ts"}' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n'
  on('fs.stat', () => ({ value: { size: ev.length, kind: 'file' } }))
  on('fs.read', () => ({ value: ev }))
  on('clock.now', () => ({ value: now }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await ui.find({ type: 'Text', text: /tab-test/ })
  const last = await ui.find({ type: 'Text', text: /Recent/ })
  expect(last).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'abort-btn' })).toBeFalsy()
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Button', key: 'abort-btn' })).toBeTruthy()
  // 面板不再提供 steer / stop daemon / back 按钮；返回靠 Esc
  for (const key of ['steer-btn', 'stop-btn', 'back']) expect(await ui.find({ type: 'Button', key })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Esc back/ })).toBeTruthy()
  expect(all).toBeTruthy()
  await ui.unmount()
})

// 一个运行中 + 一个已完成：两个 tab 都有内容
async function tabsWorld($: any, on: any) {
  const now = Date.now()
  const DONE = 'r-aaa111-111111'
  on('store.get', (_: any, e: any) => {
    const k = String(e.key ?? '')
    if (k.startsWith('runs:')) return { value: { 'r-live': { session: 'live-s', role: 'advisor', summary: '', startedAt: now - 5000, status: 'running' } } }
    return { value: undefined }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('store.delete', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/x\n', stderr: '' } }))
  const file = (name: string) => [{ name, kind: 'file', size: 100, mtimeMs: 1000, isLink: false }]
  on('fs.list', (_: any, e: any) => ({ value: String(e.path).endsWith('/runs') ? file(`${DONE}.json`) : String(e.path).endsWith('/sessions') ? file('done-s.json') : [] }))
  on('fs.read', (_: any, e: any) => ({
    value: String(e.path).endsWith(`${DONE}.json`)
      ? JSON.stringify({ runId: DONE, session: 'done-s', status: 'done', reply: '完成了', endedAt: '2026-11-17T10:00:00.000Z' })
      : JSON.stringify({ name: 'done-s', owner: 's1' }),
  }))
  on('fs.stat', () => ({ value: { size: 0, kind: 'file' } }))
  on('clock.now', () => ({ value: now }))
  const landed: string[] = []
  on('ui.focus', { plugin: '*' }, (_: any, e: any) => { landed.push(String(e.element)); return { value: {} } })
  return { DONE, landed }
}

// 引擎的焦点环只说落点；这里按它会给出的落点喂 ui.focus，看钩子最终让焦点落在哪
const focus = ($: any, element: string) => $.ui.focus({ component: 'Pane', requestId: 'pi', element, origin: { kind: 'person' } })

const tabKeys = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k.startsWith('tab-'))

test('焦点只落在行上：首行 ↑ / 末行 ↓ 停住，从 ✕ 回首行', async ($, on) => {
  const { landed } = await tabsWorld($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = async () => (await ui.findAll({ type: 'Button' })).map((b: any) => b.key).filter((k: string) => k.startsWith('row-'))
  expect(await rows()).toEqual(['row-r-live'])

  await focus($, 'tab-done') // 环还不在任何控件上，第一次 ↓ 引擎给的是 tab：进首行
  expect(landed.at(-1)).toBe('row-r-live')
  const n = landed.length
  await focus($, 'tab-done') // 首行 ↑：引擎给 tab-done，停住不动
  await focus($, 'tab-running') // 末行 ↓ 环绕：同样停住
  expect(landed).toHaveLength(n)
  expect(await rows()).toEqual(['row-r-live'])

  await $.ui.focus({ component: 'Pane', requestId: 'pi', origin: { kind: 'person' } }) // Tab 走到引擎的关闭标记 ✕
  await focus($, 'tab-running') // 再 Tab 环绕到 tab-running：回首行
  expect(landed.at(-1)).toBe('row-r-live')
  await ui.unmount()
})

test('ToolUse：matcher 按 props.tool 只命中 PiAgent 的调用行', async ($) => {
  const row = (tool: string, input: unknown) => ({
    plugin: 'pi-agent',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: `t-${tool}`,
    props: { tool_use_id: `t-${tool}`, tool, input, isRunning: false, isErrored: false, isInterrupted: false },
  })
  const pi = await $.ui.mount(row('PiAgent', { action: 'send', session: 'demo', description: '修错字' }) as any)
  expect(await pi.find({ type: 'Text', text: /PiAgent\(send · demo · advisor · 修错字\)/ })).toBeTruthy()
  await pi.unmount()
  const bash = await $.ui.mount(row('Bash', { command: 'ls' }) as any)
  expect(await bash.find({ type: 'Text', text: /PiAgent\(/ })).toBeFalsy()
  await bash.unmount()
})

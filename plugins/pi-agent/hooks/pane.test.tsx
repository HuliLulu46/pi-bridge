import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pi',
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
  console.log('ROW', all?.text)
  const detail = await ui.find({ type: 'Text', text: /tab 测试/ })
  console.log('DETAIL', detail?.text)
  const stop = await ui.find({ type: 'Button', key: 'stop-btn' })
  console.log('STOPBTN', !!stop)
  const last = await ui.find({ type: 'Text', text: /最近/ })
  console.log('LAST', last?.text)
  expect(last).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'stop-btn' })).toBeFalsy()
  await ui.press({ key: 'row-r-x' })
  expect(await ui.find({ type: 'Button', key: 'stop-btn' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeTruthy()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Button', key: 'row-r-x' })).toBeTruthy()
  expect(all).toBeTruthy()
  await ui.unmount()
})

test('ToolUse：matcher 按 props.tool 只命中 PiAgent 的调用行', async ($) => {
  const row = (tool: string, input: unknown) => ({
    plugin: 'pi',
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

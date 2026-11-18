import { expect, mock, test } from 'claude-code/testing'
import { renderHistory } from './register'

const note = '以下是主 agent（Claude Code）与用户的对话记录'
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text', text }] })
const assistant = (content: Record<string, unknown>[]) => ({ role: 'assistant' as const, content })

test('fork 渲染：文本原样、工具调用与结果转文字，thinking 丢弃、媒体占位', () => {
  const history = renderHistory([
    user('  背景\n原样  '),
    assistant([
      { type: 'thinking', thinking: '不导出思考' },
      { type: 'redacted_thinking', data: 'secret' },
      { type: 'text', text: '  开始  ' },
      { type: 'tool_use', id: 'old', name: 'Read', input: { file_path: '/w/a.ts' } },
    ]),
    { role: 'user', content: [
      { type: 'tool_result', content: '普通结果' },
      { type: 'tool_result', is_error: true, content: [
        { type: 'text', text: '失败说明' },
        { type: 'image', source: { data: '不要导出图片' } },
        { type: 'document', source: { data: '不要导出文档' } },
      ] },
    ] },
  ])
  expect(history.length).toBe(3)
  expect(history[0]!.text).toContain(note)
  expect(history[0]!.text.endsWith('\n\n  背景\n原样  ')).toBe(true)
  expect(history[1]).toEqual({ role: 'assistant', text: '  开始  \n[调用工具 Read] {"file_path":"/w/a.ts"}' })
  expect(history[2]).toEqual({ role: 'user', text: '[工具结果] 普通结果\n[工具结果，出错] 失败说明\n[图片]\n[文档]' })
})

test('fork 渲染：每条工具结果正文超过 4000 字符截断，注明原长度，短结果保留', () => {
  const history = renderHistory([{ role: 'user', content: [
    { type: 'tool_result', content: '甲'.repeat(4001) },
    { type: 'tool_result', content: [{ type: 'text', text: '乙'.repeat(4000) }, { type: 'text', text: '丙' }] },
    { type: 'tool_result', content: '丁'.repeat(4000) },
  ] }])
  expect(history[0]!.text).toContain(`[工具结果] ${'甲'.repeat(4000)}…（已截断，原长度 4001 字符）`)
  expect(history[0]!.text).not.toContain('甲'.repeat(4001))
  expect(history[0]!.text).toContain(`[工具结果] ${'乙'.repeat(4000)}…（已截断，原长度 4002 字符）`)
  expect(history[0]!.text.endsWith(`[工具结果] ${'丁'.repeat(4000)}`)).toBe(true)
})

test('fork 渲染：只丢当前 tool_use，去空消息后合并连续同角色', () => {
  const history = renderHistory([
    user('背景'), user('补充'),
    assistant([{ type: 'tool_use', id: 'current', name: 'PiAgent', input: { message: '本次任务' } }]),
    user('继续'),
    assistant([
      { type: 'tool_use', id: 'old-pi', name: 'PiAgent', input: { message: '旧任务' } },
      { type: 'tool_use', id: 'current', name: 'PiAgent', input: { message: '本次任务' } },
      { type: 'text', text: '保留同条消息的文字' },
    ]),
    assistant([{ type: 'thinking', thinking: 'secret' }]),
    assistant([{ type: 'text', text: '下一条' }]),
    user('   '),
  ], 'current')
  expect(history.length).toBe(2)
  expect(history[0]!.text.endsWith('背景\n补充\n继续')).toBe(true)
  expect(history[1]).toEqual({ role: 'assistant', text: '[调用工具 PiAgent] {"message":"旧任务"}\n保留同条消息的文字\n下一条' })
  expect(JSON.stringify(history)).not.toContain('本次任务')
})

test('fork 渲染：首条 assistant 时补 user，空历史也保证首条 user', () => {
  for (const messages of [[], [assistant([{ type: 'text', text: '助手开场' }])]]) {
    const history = renderHistory(messages)
    expect(history[0]!.role).toBe('user')
    expect(history[0]!.text).toContain(note)
    expect(history[0]!.text).toContain('最后一条用户消息才是交给你的任务')
    if (messages.length) expect(history[1]).toEqual({ role: 'assistant', text: '助手开场' })
  }
})

function world(on: any, opts: { deny?: string; bridgeError?: string; includeCurrent?: boolean } = {}) {
  mock.store(on, {})
  on('session.id', () => ({ value: 's1' }))
  on('session.info', () => ({ value: { transcriptPath: '/w/transcript.jsonl' } }))
  const files = new Map<string, string>()
  let currentCall: string | undefined
  on('fs.read', () => ({ value: '' }))
  on('fs.write', (_: any, e: any) => {
    if (e.path === '/captured-tool-id') currentCall = e.text
    else files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  const reads: Record<string, unknown>[] = []
  on('session.messages', (_: any, e: any) => {
    reads.push(e)
    const content: Record<string, unknown>[] = [{ type: 'text', text: '已有结论' }]
    if (opts.includeCurrent) content.push({ type: 'tool_use', id: currentCall, name: 'PiAgent', input: { message: '当前调用不应进入历史' } })
    return { value: opts.deny ? { deny: opts.deny } : [user(e.agentId ? '子 agent 背景' : '主会话背景'), assistant(content)] }
  })
  const calls: { args: string[]; stdin: string }[] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'printenv') return { value: { exitCode: 0, stdout: '/h\n', stderr: '' } }
    const args: string[] = e.argv.slice(2)
    calls.push({ args, stdin: e.init?.stdin })
    return { value: opts.bridgeError
      ? { exitCode: 1, stdout: JSON.stringify({ error: opts.bridgeError }), stderr: '' }
      : { exitCode: 0, stdout: JSON.stringify({ session: args[1], runId: 'r-abc123-123abc' }), stderr: '' } }
  })
  return { files, reads, calls, currentCall: () => currentCall }
}

test('send fork=true：读取主会话 API 历史，写 JSON 并传 --history-file，任务仍走 stdin', async ($: any, on: any) => {
  const w = world(on)
  const r = await $.tool.call({ tool: 'PiAgent', session: 'fresh', message: '继续完成上面的修复', fork: true })
  expect(w.reads).toEqual([{ as: 'api' }])
  const call = w.calls[0]!
  const index = call.args.indexOf('--history-file')
  expect(index > 0).toBe(true)
  const path = call.args[index + 1]!
  expect(path.startsWith('/h/.pi-bridge/history/')).toBe(true)
  expect(call.args.at(-1)).toBe('-')
  expect(call.args).toEqual(expect.arrayContaining(['--owner', 's1']))
  expect(call.stdin).toBe('继续完成上面的修复')
  const history = JSON.parse(w.files.get(path)!)
  expect(history).toEqual({ messages: renderHistory([user('主会话背景'), assistant([{ type: 'text', text: '已有结论' }])]) })
  expect(String(r.result)).toContain('已 fork 当前对话（2 条消息）')
})

test('send fork=true：读取结果包含本次 tool_use 时按实际事件 id 排除', {
  plugins: [{ name: 'capture-call', tier: 'prepend', register(on) {
    on('tool.call', { tool: /^PiAgent$/ }, async ($, e, next) => {
      await $.fs.write('/captured-tool-id', e.tool_use_id)
      return next(e)
    })
  } }],
}, async ($: any, on: any) => {
  const w = world(on, { includeCurrent: true })
  await $.tool.call({ tool: 'PiAgent', session: 'fresh', message: '继续', fork: true })
  const callId = w.currentCall()
  expect(typeof callId).toBe('string')
  expect(String(callId).length > 0).toBe(true)
  expect([...w.files.values()][0]).not.toContain('当前调用不应进入历史')
  expect([...w.files.values()][0]).toContain('已有结论')
})

test('send fork=true：子 agent 只读取调用方 agentId 的历史', async ($: any, on: any) => {
  const w = world(on)
  const r = await $.tool.call({ tool: 'PiAgent', session: 'child', message: '继续', fork: true, agentId: 'agent-1' })
  expect(w.reads).toEqual([{ agentId: 'agent-1', as: 'api' }])
  expect([...w.files.values()][0]).toContain('子 agent 背景')
  expect(String(r.result)).toContain('已 fork 当前对话')
})

test('send fork=true：messages deny 时返回原因，不写文件也不派发', async ($: any, on: any) => {
  const w = world(on, { deny: 'agent-1 不可读取' })
  const r = await $.tool.call({ tool: 'PiAgent', session: 'fresh', message: '继续', fork: true, agentId: 'agent-1' })
  expect(r.deny).toBe('agent-1 不可读取')
  expect(w.files.size).toBe(0)
  expect(w.calls.length).toBe(0)
})

test('普通 send 不读取历史、不传 --history-file', async ($: any, on: any) => {
  const w = world(on)
  const r = await $.tool.call({ tool: 'PiAgent', session: 'normal', message: '独立任务' })
  expect(w.reads.length).toBe(0)
  expect(w.files.size).toBe(0)
  expect(w.calls[0]!.args).not.toContain('--history-file')
  expect(String(r.result)).not.toContain('已 fork 当前对话')
})

test('send fork=true：bridge 拒绝已有 session 时原样返回错误', async ($: any, on: any) => {
  const error = 'history-file requires a new session: existing'
  const w = world(on, { bridgeError: error })
  const r = await $.tool.call({ tool: 'PiAgent', session: 'existing', message: '继续', fork: true })
  expect(r.deny).toBe(error)
  expect(w.calls.length).toBe(1)
})

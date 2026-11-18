import { expect, mock, test } from 'claude-code/testing'

// 经符号链接加载时，按插件目录的真实路径找兄弟目录里的 pi-bridge
test('插件目录是符号链接：按 realPath 找 ../pi-bridge/src/cli.ts', async ($: any, on: any) => {
  const CLI = '/repo/plugins/pi-agent/../pi-bridge/src/cli.ts'
  mock.store(on, {})
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 's1' } }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: '/repo/plugins/pi-agent' } }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path === CLI }))
  const argvs: string[][] = []
  on('process.run', (_: any, e: any) => {
    argvs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'printenv' ? '/h\n' : '[]', stderr: '' } }
  })
  await $.tool.call({ tool: 'PiAgent', action: 'list', scope: 'all' })
  expect(argvs.find((a) => a[0] === 'node')?.[1]).toBe(CLI)
})

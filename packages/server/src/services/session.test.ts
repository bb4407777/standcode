import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import { test } from 'node:test'
import type { Session as SessionType } from './session'
import type { SpawnSpec } from './templates'

// session.ts 经 ESM 加载会撞上 @xterm/headless（UMD 包）无具名导出的限制，测试走 CJS require 绕过
const { Session } = createRequire(import.meta.url)('./session.ts') as typeof import('./session')

const STOP_GRACE_MS = 5000 // 与 session.ts 内部常量一致

function makeSession(): SessionType {
  return new Session({
    id: 'test-session',
    name: 'test',
    templateId: 'test',
    command: 'cat',
    args: [],
    cwd: os.tmpdir(),
    color: '#fff',
    claudeSessionId: null,
  })
}

const catSpec: SpawnSpec = { file: '/bin/cat', args: [], cwd: os.tmpdir(), env: {} }

test('sendline validates running state before marking working', () => {
  const session = makeSession()
  assert.equal(session.trafficState, 'exited')
  assert.throws(() => session.sendline('hello'), /会话未在运行/)
  // 已退出会话不得留下持久化的假 working 状态
  assert.equal(session.trafficState, 'exited')
})

test('repeated stop leaves no orphan SIGKILL timer behind', async () => {
  const session = makeSession()
  try {
    session.spawnProcess(catSpec)
    session.stop()
    session.stop() // 第二次 stop 覆盖句柄前必须清掉旧定时器
    await once(session, 'exit')
    assert.equal(session.exitReason, 'user-stop')
    // restart 出新进程后，孤定时器到点会 SIGKILL 新进程并记为 crash：
    // 真实等待超过兜底宽限期，确认新进程仍存活（不用 mock timers——会卡死 node-pty 内部定时器）
    session.spawnProcess(catSpec)
    await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 1000))
    assert.equal(session.isRunning, true)
  } finally {
    session.dispose()
  }
})

// ---- 输入框识别（2026-11-10 mcode 实测：提示符是 ›，空框显示占位提示语）----

const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')

/** 造一屏 mcode TUI 画面（144 列，够宽不折行） */
async function mcodeScreen(lines: string[]): Promise<InstanceType<typeof Terminal>> {
  const term = new Terminal({ cols: 144, rows: 31, allowProposedApi: true })
  term.write(lines.join('\r\n'))
  await new Promise((r) => setTimeout(r, 30))
  return term
}

const MCODE_HINT = '    Message · Enter send · Ctrl+J newline'
const MCODE_SEPARATOR = '    ──────────────────────────────────────────'
const MCODE_FOOTER = '  /private/tmp │ Full access │ ✦ M3.1-Flash · Effort default │ Context 512K'

test('inputBoxText：认得 mcode 的 › 提示符（U+203A），尾字能对上', async () => {
  const session = makeSession()
  ;(session as unknown as { shadow: unknown }).shadow = await mcodeScreen([
    MCODE_HINT,
    MCODE_SEPARATOR,
    '  ›  测试文字ABC',
    MCODE_SEPARATOR,
    '',
    MCODE_FOOTER,
  ])
  const box = (session as unknown as { inputBoxText: () => string | null }).inputBoxText()
  assert.notEqual(box, null)
  assert.equal(box?.replace(/\s+/g, ''), '测试文字ABC')
})

test('inputBoxText：claude 系 > 提示符仍认得（回归护栏）', async () => {
  const session = makeSession()
  ;(session as unknown as { shadow: unknown }).shadow = await mcodeScreen(['  >  hello world'])
  const box = (session as unknown as { inputBoxText: () => string | null }).inputBoxText()
  assert.equal(box?.replace(/\s+/g, ''), 'helloworld')
})

test('submitUntilAccepted：mcode 占位符空框不盲按回车（终端里打的字不会被自动发送）', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await mcodeScreen([
      MCODE_HINT,
      MCODE_SEPARATOR,
      '  ›  Ask Mcode to do anything',
      MCODE_SEPARATOR,
      '',
      MCODE_FOOTER,
    ])
    const writes: string[] = []
    ;(session as unknown as { pty: { write: (d: string) => void } }).pty.write = (d: string) => {
      writes.push(d)
    }
    const submit = (session as unknown as {
      submitUntilAccepted: (snippet: string, body: string, absent: boolean, boxBefore: string | null) => void
    }).submitUntilAccepted
    submit.call(session, '测试文字ABC', '测试文字ABC', false, 'Ask Mcode to do anything')
    await new Promise((r) => setTimeout(r, 3500))
    assert.equal(writes.filter((w) => w === '\r').length, 0)
  } finally {
    session.dispose()
  }
})

test('submitUntilAccepted：认得输入框且尾字在框里 → 补按回车提交', async () => {
  const session = makeSession()
  session.spawnProcess(catSpec)
  try {
    ;(session as unknown as { shadow: unknown }).shadow = await mcodeScreen([
      MCODE_HINT,
      MCODE_SEPARATOR,
      '  ›  测试文字ABC',
      MCODE_SEPARATOR,
      '',
      MCODE_FOOTER,
    ])
    const writes: string[] = []
    ;(session as unknown as { pty: { write: (d: string) => void } }).pty.write = (d: string) => {
      writes.push(d)
    }
    const submit = (session as unknown as {
      submitUntilAccepted: (snippet: string, body: string, absent: boolean, boxBefore: string | null) => void
    }).submitUntilAccepted
    submit.call(session, '测试文字ABC', '测试文字ABC', false, 'Ask Mcode to do anything')
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(writes.filter((w) => w === '\r').length >= 1)
  } finally {
    session.dispose()
  }
})

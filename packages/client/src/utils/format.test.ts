import assert from 'node:assert/strict'
import test from 'node:test'
import type { TranscriptMessage } from '../../../shared/protocol'
import { terminalInputStartsTask, trafficStateFromMessages } from '../../../shared/traffic'
import { statusTagText, trafficColor, chatCapable, sessionEntryPath } from './format'

function message(
  role: TranscriptMessage['role'],
  parts: TranscriptMessage['parts']
): TranscriptMessage {
  return { role, parts, timestamp: null }
}

test('traffic light is red while the agent is working', () => {
  const signal = trafficStateFromMessages([
    message('user', [{ kind: 'text', text: '处理这个任务' }]),
    message('assistant', [{ kind: 'tool_use', name: 'exec_command', input: '{}' }]),
  ])
  assert.equal(signal, 'working')
  assert.equal(trafficColor(signal), '#ef4444')
})

test('traffic light is green after a final assistant answer', () => {
  const signal = trafficStateFromMessages([
    message('user', [{ kind: 'text', text: '处理这个任务' }]),
    message('assistant', [{ kind: 'text', text: '已经完成，结论如下。' }]),
  ])
  assert.equal(signal, 'conclusion')
  assert.equal(trafficColor(signal), '#22c55e')
})

test('traffic light is yellow when AskUserQuestion needs input', () => {
  const signal = trafficStateFromMessages([
    message('assistant', [{ kind: 'tool_use', name: 'AskUserQuestion', input: '{}' }]),
  ])
  assert.equal(signal, 'needs-user')
  assert.equal(trafficColor(signal), '#eab308')
})

test('traffic light is yellow when Codex request_user_input needs input', () => {
  const signal = trafficStateFromMessages([
    message('assistant', [{ kind: 'tool_use', name: 'request_user_input', input: '{}' }]),
  ])
  assert.equal(signal, 'needs-user')
})

test('traffic light is gray after exit regardless of transcript', () => {
  assert.equal(trafficColor('exited'), '#6b7280')
})

test('traffic light stays compatible with a server that does not send trafficState yet', () => {
  assert.equal(trafficColor(undefined, 'exited'), '#6b7280')
  assert.equal(trafficColor(undefined, 'error'), '#6b7280')
  assert.equal(trafficColor(undefined, 'running'), '#ef4444')
})

test('terminal input only starts a task when the user submits a line', () => {
  assert.equal(terminalInputStartsTask('正在输入'), false)
  assert.equal(terminalInputStartsTask('\u001b[A'), false)
  assert.equal(terminalInputStartsTask('\r'), true)
  assert.equal(terminalInputStartsTask('处理这个任务\n'), true)
})

test('traffic light is yellow after a claude interrupt placeholder, not stuck red', () => {
  const signal = trafficStateFromMessages([
    message('user', [{ kind: 'text', text: '处理这个任务' }]),
    message('assistant', [{ kind: 'tool_use', name: 'Bash', input: '{}' }]),
    message('user', [{ kind: 'text', text: '[Request interrupted by user]' }]),
  ])
  assert.equal(signal, 'needs-user')
  assert.equal(trafficColor(signal), '#eab308')
})

test('traffic light is yellow when qclaw ask_user_question needs input', () => {
  const signal = trafficStateFromMessages([
    message('assistant', [{ kind: 'tool_use', name: 'ask_user_question', input: '{}' }]),
  ])
  assert.equal(signal, 'needs-user')
})

test('statusTagText：黄灯（needs-user）显示「有选项」，其余口径不变', () => {
  assert.equal(statusTagText({ status: 'running', trafficState: 'needs-user' }), '有选项')
  assert.equal(statusTagText({ status: 'running', trafficState: 'idle' }), '等待中')
  assert.equal(statusTagText({ status: 'running', trafficState: 'conclusion' }), '等待中')
  assert.equal(statusTagText({ status: 'running', trafficState: 'working' }), '运行中')
  assert.equal(statusTagText({ status: 'exited', trafficState: 'exited' }), '已退出')
})

test('chatCapable：dsh 壳会话可进对话模式（trae-cn 有对话视图入口）', () => {
  const templates: Array<{ id: string; claudeHome?: string }> = [{ id: 'trae-cn' }]
  const dsh = {
    claudeSessionId: null as string | null,
    transcriptDir: null,
    command: '/Users/gao/code/areco/bin/dsh-trae-chat',
    templateId: 'trae-cn',
  }
  assert.equal(chatCapable(dsh, templates), true)
  // 默认「对话模式」偏好 → 看板/侧栏点卡片路由到 chat 页
  assert.equal(sessionEntryPath('s1', dsh, templates, 'chat'), '/session/s1/chat')
  // 偏好为终端时仍回终端页（不受此改动影响）
  assert.equal(sessionEntryPath('s1', dsh, templates, 'terminal'), '/session/s1')
})

test('chatCapable：mcode 会话可进对话模式（正文在 MiniMax 本地库）', () => {
  const templates: Array<{ id: string; claudeHome?: string }> = [{ id: 'minimax-mcode' }]
  const mcode = {
    claudeSessionId: null as string | null,
    transcriptDir: null,
    command: '/Users/gao/.npm-global/bin/mcode',
    templateId: 'minimax-mcode',
  }
  assert.equal(chatCapable(mcode, templates), true)
  assert.equal(sessionEntryPath('s2', mcode, templates, 'chat'), '/session/s2/chat')
  assert.equal(sessionEntryPath('s2', mcode, templates, 'terminal'), '/session/s2')
})

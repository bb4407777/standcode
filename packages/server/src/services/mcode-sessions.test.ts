import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { trafficStateFromMessages } from '../../../shared/traffic'
import {
  claimMcodeSessionId,
  isMcodeSession,
  mcodeEntries,
  mcodeTrafficSnapshot,
  readMcdeTranscript,
  readMcodeLiveTranscript,
} from './mcode-sessions'

const SID = 'mvs_0123456789abcdef0123456789abcdef'

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-mcode-'))
  const file = path.join(dir, 'runtime-state.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER)`)
  db.exec(`CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    role TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL)`)
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?)').run(
    SID,
    '把中枢换到主板 ds',
    '/Users/example/project',
    1794000000000,
    1794000060000
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm1',
    'user',
    1794000000000,
    JSON.stringify({ msg_type: 1, msg_content: '把中枢换到主板 ds' })
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm2',
    'assistant',
    1794000030000,
    JSON.stringify({
      msg_type: 2,
      thinking_content: '先读配置',
      msg_content: '',
      tool_calls: [{ tool_name: 'read', tool_call_args: '{"path":"a.txt"}' }],
    })
  )
  db.prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)').run(
    SID,
    'm3',
    'assistant',
    1794000060000,
    JSON.stringify({ msg_type: 1, msg_content: '已切好' })
  )
  db.close()
  return file
}

test('mcode 列表：标题/工作目录/时间取 session 表', () => {
  const file = fixture()
  const prev = process.env.ARECO_MCODE_DB
  process.env.ARECO_MCODE_DB = file
  try {
    const entries = mcodeEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].source, 'mcode')
    assert.equal(entries[0].id, SID)
    assert.equal(entries[0].title, '把中枢换到主板 ds')
    assert.equal(entries[0].cwd, '/Users/example/project')
    assert.equal(entries[0].mtimeMs, 1794000060000)
  } finally {
    if (prev === undefined) delete process.env.ARECO_MCODE_DB
    else process.env.ARECO_MCODE_DB = prev
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

test('mcode 正文：思考/工具/正文按段还原，空消息跳过', () => {
  const file = fixture()
  const prev = process.env.ARECO_MCODE_DB
  process.env.ARECO_MCODE_DB = file
  try {
    const page = readMcdeTranscript(SID)
    assert.equal(page.messages.length, 3)
    assert.equal(page.messages[0].role, 'user')
    assert.deepEqual(page.messages[1].parts.map((p) => p.kind), ['thinking', 'tool_use'])
    assert.equal(page.messages[2].parts[0].kind, 'text')
    assert.throws(() => readMcdeTranscript('../x'), /不合法/)
  } finally {
    if (prev === undefined) delete process.env.ARECO_MCODE_DB
    else process.env.ARECO_MCODE_DB = prev
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
})

// ---- 座舱活会话（areco 起的 mcode 进程）----

const LIVE_SID = 'mvs_1111111111111111111111111111aaaa'
const OTHER_SID = 'mvs_2222222222222222222222222222bbbb'

interface LiveRow {
  id: string
  cwd: string
  createdAt: number
  prompt?: string
}

/** 活会话夹具：本地库 + （可选）可观测目录 */
function liveFixture(rows: LiveRow[]): { db: string; obs: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'areco-mcode-live-'))
  const db = path.join(dir, 'runtime-state.sqlite')
  const obs = path.join(dir, 'obs')
  fs.mkdirSync(obs)
  const conn = new DatabaseSync(db)
  conn.exec(`CREATE TABLE local_runtime_sessions (
    session_id TEXT PRIMARY KEY, title TEXT, workspace_dir TEXT, project_workspace_dir TEXT,
    created_at_ms INTEGER, updated_at_ms INTEGER)`)
  conn.exec(`CREATE TABLE local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
    role TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL)`)
  for (const row of rows) {
    conn
      .prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?,?)')
      .run(row.id, null, row.cwd, row.cwd, row.createdAt, row.createdAt)
    if (row.prompt !== undefined) {
      conn
        .prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)')
        .run(row.id, `m-${row.id}`, 'user', row.createdAt, JSON.stringify({ msg_content: row.prompt }))
    }
  }
  conn.close()
  return { db, obs }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(env)) {
      const old = prev[k]
      if (old === undefined) delete process.env[k]
      else process.env[k] = old
    }
  }
}

test('mcode 活会话认领：cwd + 启动时间窗命中，认领到的 id 写回绑定', () => {
  const startedAt = Date.now()
  const { db, obs } = liveFixture([{ id: LIVE_SID, cwd: '/Users/gao', createdAt: startedAt + 3000 }])
  try {
    withEnv({ ARECO_MCODE_DB: db, ARECO_MCODE_OBS_DIR: obs }, () => {
      let bound: string | null = null
      const page = readMcodeLiveTranscript(
        {
          agentSessionId: null,
          cwd: '/Users/gao',
          startedAt,
          createdAt: startedAt,
          pid: null,
          agentBindingHash: null,
          bindAgentSession: (id) => {
            bound = id
          },
        },
        { cursor: 0 },
      )
      assert.equal(bound, LIVE_SID)
      assert.equal(page.exists, true)
    })
  } finally {
    fs.rmSync(path.dirname(db), { recursive: true, force: true })
  }
})

test('mcode 活会话认领：cwd 不符 / 早于启动窗口 → 不认领', () => {
  const startedAt = Date.now()
  const { db, obs } = liveFixture([
    { id: LIVE_SID, cwd: '/Users/other', createdAt: startedAt + 3000 },
    { id: OTHER_SID, cwd: '/Users/gao', createdAt: startedAt - 600_000 },
  ])
  try {
    withEnv({ ARECO_MCODE_DB: db, ARECO_MCODE_OBS_DIR: obs }, () => {
      // cwd 是 /Users/gao 的那条创建于 10 分钟前 → 早于启动窗口，认不到
      assert.equal(claimMcodeSessionId({ cwd: '/Users/gao', startedAt }), null)
      // cwd 对得上、时间也在窗内 → 认到
      assert.equal(claimMcodeSessionId({ cwd: '/Users/other', startedAt }), LIVE_SID)
    })
  } finally {
    fs.rmSync(path.dirname(db), { recursive: true, force: true })
  }
})

test('mcode 活会话认领：同 cwd 两个候选时按首条输入哈希认人', () => {
  const startedAt = Date.now()
  const { db, obs } = liveFixture([
    { id: LIVE_SID, cwd: '/Users/gao', createdAt: startedAt + 2000, prompt: '第一条指令' },
    { id: OTHER_SID, cwd: '/Users/gao', createdAt: startedAt + 4000, prompt: '另一条指令' },
  ])
  try {
    withEnv({ ARECO_MCODE_DB: db, ARECO_MCODE_OBS_DIR: obs }, () => {
      const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
      assert.equal(
        claimMcodeSessionId({ cwd: '/Users/gao', startedAt, bindingHash: hash('另一条指令') }),
        OTHER_SID,
      )
      assert.equal(
        claimMcodeSessionId({ cwd: '/Users/gao', startedAt, bindingHash: hash('第一条指令') }),
        LIVE_SID,
      )
    })
  } finally {
    fs.rmSync(path.dirname(db), { recursive: true, force: true })
  }
})

test('mcode 活会话正文：cursor=0 尾页、cursor>0 增量、before 向前翻页', () => {
  const startedAt = Date.now()
  const { db, obs } = liveFixture([{ id: LIVE_SID, cwd: '/Users/gao', createdAt: startedAt }])
  try {
    const conn = new DatabaseSync(db)
    for (let i = 0; i < 3; i++) {
      conn
        .prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)')
        .run(LIVE_SID, `m${i}`, i % 2 === 0 ? 'user' : 'assistant', startedAt + i, JSON.stringify({ msg_content: `第${i}条` }))
    }
    conn.close()
    withEnv({ ARECO_MCODE_DB: db, ARECO_MCODE_OBS_DIR: obs }, () => {
      const base = {
        agentSessionId: LIVE_SID,
        cwd: '/Users/gao',
        startedAt,
        createdAt: startedAt,
        pid: null,
        agentBindingHash: null,
      }
      const first = readMcodeLiveTranscript(base, { cursor: 0 })
      assert.equal(first.messages.length, 3)
      assert.equal(first.cursor, 3)
      assert.equal(first.start, 0)
      const inc = readMcodeLiveTranscript(base, { cursor: 1 })
      assert.equal(inc.messages.length, 2)
      assert.equal(inc.start, undefined)
      const older = readMcodeLiveTranscript(base, { cursor: 0, before: 2 })
      assert.equal(older.messages.length, 2)
      assert.equal(older.start, 0)
      assert.equal(older.hasMore, false)
    })
  } finally {
    fs.rmSync(path.dirname(db), { recursive: true, force: true })
  }
})

test('isMcodeSession：认 mcode 命令与 harness', () => {
  assert.equal(isMcodeSession('/Users/gao/.npm-global/bin/mcode'), true)
  assert.equal(isMcodeSession('/Users/gao/.npm-global/bin/mcode', null), true)
  assert.equal(isMcodeSession('/bin/zsh'), false)
  assert.equal(isMcodeSession('/Users/gao/code/areco/bin/dsh-trae-chat'), false)
  assert.equal(isMcodeSession('/bin/zsh', 'mcode'), true)
})

test('mcode 红绿灯快照：末条 assistant 正文 = 已出结论，末条 user = 还在跑', () => {
  const startedAt = Date.now()
  const { db, obs } = liveFixture([{ id: LIVE_SID, cwd: '/Users/gao', createdAt: startedAt }])
  try {
    const conn = new DatabaseSync(db)
    const add = (role: string, content: string) =>
      conn
        .prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)')
        .run(LIVE_SID, `m${Math.random()}`, role, startedAt, JSON.stringify({ msg_content: content }))
    add('user', '第一句')
    add('assistant', '答完了')
    conn.close()
    withEnv({ ARECO_MCODE_DB: db, ARECO_MCODE_OBS_DIR: obs }, () => {
      // 空会话没有消息 → 不给快照（保持调用方当前状态，别把刚提交的红灯压成绿灯）
      const empty = mcodeTrafficSnapshot(OTHER_SID)
      assert.equal(empty, null)

      const snap = mcodeTrafficSnapshot(LIVE_SID)
      assert.ok(snap)
      assert.equal(snap.lastMessage?.role, 'assistant')
      assert.equal(trafficStateFromMessages([snap.lastMessage!]), 'conclusion')

      // 指纹随内容变化（行内容原地更新也要变，否则红绿灯不更新）
      const fp1 = snap.fingerprint
      const conn2 = new DatabaseSync(db)
      conn2
        .prepare('INSERT INTO local_runtime_message_rows (session_id,msg_id,role,created_at_ms,data_json) VALUES (?,?,?,?,?)')
        .run(LIVE_SID, 'mz', 'user', startedAt + 1, JSON.stringify({ msg_content: '又一句' }))
      conn2.close()
      const snap2 = mcodeTrafficSnapshot(LIVE_SID)
      assert.ok(snap2)
      assert.notEqual(snap2.fingerprint, fp1)
      assert.equal(snap2.lastMessage?.role, 'user')
      // 用户刚发消息 → 还在跑（红灯），不能被当成 assistant 判成绿灯
      assert.equal(trafficStateFromMessages([snap2.lastMessage!]), 'working')
    })
  } finally {
    fs.rmSync(path.dirname(db), { recursive: true, force: true })
  }
})

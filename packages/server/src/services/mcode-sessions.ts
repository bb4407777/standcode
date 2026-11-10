// MiniMax Code 历史源：只读 ~/.minimax/v2/sqlite/runtime-state.sqlite。
// mcode（CLI）与 MiniMax Code.app 共用这份本地库：会话在 local_runtime_sessions，
// 逐条消息在 local_runtime_message_rows（正文塞在 data_json 里）。
// 这里只 SELECT，不写库、不复制、不改 mcode 的目录结构——mcode 自己升级换 schema 时，
// 查不到表就整源返回空，不影响其他历史源。
//
// 座舱活会话（areco 起的 mcode 进程）也走这份库：mcode 没有可注入的会话 id
// （`mcode --session <新id>` 报 Session not found，只认已存在的 id），所以活会话↔原生会话
// 的对应关系靠「工作目录 + 进程启动时间窗」认领一次，认领到的 mvs id 落 session.agentSessionId，
// 之后只认这份确定性映射（同其他 agent 的 agentSessionId 口径）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  HistoryEntry,
  HistoryTranscriptPage,
  TranscriptMessage,
  TranscriptPage,
  TranscriptPart,
} from '../../../shared/protocol'

const MCODE_SESSION_ID = /^mvs_[0-9a-f]{32}$/
const TITLE_MAX = 80
/** 一页给多少条（与 agent-transcript 的分页口径一致） */
const PAGE_MESSAGES = 80
/** 会话启动到 mcode 建会话行的宽限（进程启动 → 本地库落行，实测 1～4 秒） */
const CLAIM_SLACK_MS = 60_000
/** 进程启动时刻与 mcode 建行时刻的允许偏差（同一 cwd 多开时用来认准自己那个进程） */
const CLAIM_PID_WINDOW_MS = 90_000

/** 会话库路径：env 覆盖仅为测试用；默认 mcode 自己的落点 */
export function mcodeDbPath(): string {
  return process.env.ARECO_MCODE_DB || path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')
}

/** mcode 的可观测目录：文件名带进程 pid，是活会话认领时的进程启动时刻锚点 */
function mcodeObservabilityDir(): string {
  return process.env.ARECO_MCODE_OBS_DIR || path.join(os.homedir(), '.minimax', 'v2', 'observability', 'mcode')
}

function openDb(): DatabaseSync | null {
  const file = mcodeDbPath()
  if (!fs.existsSync(file)) return null
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    return null
  }
}

interface SessionRow {
  session_id: string
  title: string | null
  workspace_dir: string | null
  created_at_ms: number | null
  updated_at_ms: number
}

/** 历史列表：只读 session 表，按最后活动倒序；标题空则退 id 前 12 位 */
export function mcodeEntries(): HistoryEntry[] {
  const db = openDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT session_id, title, workspace_dir, created_at_ms, updated_at_ms
           FROM local_runtime_sessions
          ORDER BY updated_at_ms DESC`
      )
      .all() as unknown as SessionRow[]
    const entries: HistoryEntry[] = []
    for (const row of rows) {
      const id = String(row.session_id ?? '')
      if (!MCODE_SESSION_ID.test(id)) continue
      const rawTitle = (row.title ?? '').replace(/\s+/g, ' ').trim()
      const title = rawTitle
        ? rawTitle.length > TITLE_MAX
          ? `${rawTitle.slice(0, TITLE_MAX - 1)}…`
          : rawTitle
        : id.slice(4, 16)
      entries.push({
        source: 'mcode',
        project: 'minimax',
        id,
        title,
        cwd: row.workspace_dir ?? '',
        mtimeMs: Number(row.updated_at_ms) || 0,
        createdMs: Number(row.created_at_ms) || 0,
        size: 0,
        liveSessionId: null,
        resumable: false, // mcode exec --resume 走原生会话，areco 不代起
      })
    }
    return entries
  } catch {
    return []
  } finally {
    safeClose(db)
  }
}

/** 历史正文：逐条消息拼 parts（思考/正文/工具调用），工具结果太重不入页 */
export function readMcdeTranscript(id: string): HistoryTranscriptPage {
  if (!MCODE_SESSION_ID.test(id)) throw new Error('会话 id 不合法')
  const db = openDb()
  if (!db) throw new Error('mcode 会话库不存在')
  try {
    const rows = db
      .prepare(
        `SELECT role, created_at_ms, data_json
           FROM local_runtime_message_rows
          WHERE session_id = ?
          ORDER BY id`
      )
      .all(id) as unknown as { role: string | null; created_at_ms: number; data_json: string }[]
    if (!rows.length) {
      const exists = db.prepare('SELECT 1 AS n FROM local_runtime_sessions WHERE session_id = ?').get(id)
      if (!exists) throw new Error('历史会话不存在')
    }
    const messages: TranscriptMessage[] = []
    for (const row of rows) {
      const msg = toMessage(row)
      if (msg) messages.push(msg)
    }
    return { messages, start: 0, end: messages.length, hasMore: false }
  } finally {
    safeClose(db)
  }
}

// ---- 座舱活会话（areco 起的 mcode 进程）----

/** 命令/模板是不是 mcode（/Users/gao/.npm-global/bin/mcode） */
export function isMcodeSession(command: string, harness?: string | null): boolean {
  if (harness === 'mcode') return true
  const base = path.basename(command || '')
  return base === 'mcode' || base.startsWith('mcode-')
}

/** 认领参数：活会话的身份线索（cwd + 启动时刻 + 进程 pid + 首条输入哈希） */
export interface McodeClaimRef {
  cwd: string
  /** 会话启动时刻（ms） */
  startedAt: number
  /** pty 子进程 pid（mcode 的可观测文件名带 pid，可作锚点） */
  pid?: number | null
  /** 首条用户输入的 sha256（与 session.agentBindingHash 同口径：空白折叠后取哈希） */
  bindingHash?: string | null
}

interface McodeSessionRow {
  session_id: string
  workspace_dir: string | null
  project_workspace_dir: string | null
  created_at_ms: number | null
}

/** 路径归一（realpath）：macOS 上 /tmp → /private/tmp，mcode 记的是 realpath */
function normalizePath(p: string): string {
  if (!p) return ''
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** 进程启动时刻：mcode 可观测文件名 mcode-observability-<epochms>-<pid>.jsonl */
function mcodeProcessStartMs(pid?: number | null): number | null {
  if (!pid) return null
  const suffix = `-${pid}.jsonl`
  try {
    for (const name of fs.readdirSync(mcodeObservabilityDir())) {
      if (!name.endsWith(suffix)) continue
      const m = /^mcode-observability-(\d+)-\d+\.jsonl$/.exec(name)
      if (m) return Number(m[1])
    }
  } catch {
    /* 目录不存在 = 没有锚点 */
  }
  return null
}

/** 会话首条用户输入的哈希（与 session.agentBindingHash 同口径：空白折叠后 sha256） */
function firstUserPromptHash(db: DatabaseSync, id: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT data_json FROM local_runtime_message_rows
          WHERE session_id = ? AND role = 'user'
          ORDER BY id LIMIT 1`
      )
      .get(id) as unknown as { data_json?: string } | undefined
    if (!row?.data_json) return null
    const data = JSON.parse(row.data_json) as { msg_content?: unknown }
    const text = typeof data.msg_content === 'string' ? data.msg_content : ''
    if (!text.trim()) return null
    return crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')
  } catch {
    return null
  }
}

/**
 * 认领活会话对应的 mcode 原生会话 id（mvs_…）。
 * 认领顺序：工作目录 + 启动时间窗 → 首条输入哈希 → 进程 pid 锚点 → 取最新。
 * 认不到返回 null（对话视图显示空白，等下一轮轮询再试）。
 */
export function claimMcodeSessionId(ref: McodeClaimRef): string | null {
  const db = openDb()
  if (!db) return null
  try {
    const now = Date.now()
    const rows = db
      .prepare(
        `SELECT session_id, workspace_dir, project_workspace_dir, created_at_ms
           FROM local_runtime_sessions
          WHERE created_at_ms <= ?
          ORDER BY created_at_ms DESC
          LIMIT 200`
      )
      .all(now + 5_000) as unknown as McodeSessionRow[]
    const cwd = normalizePath(ref.cwd)
    const since = ref.startedAt - CLAIM_SLACK_MS
    let candidates = rows.filter((row) => {
      const id = String(row.session_id ?? '')
      if (!MCODE_SESSION_ID.test(id)) return false
      const created = Number(row.created_at_ms) || 0
      if (created < since || created > now + 5_000) return false
      return (
        normalizePath(row.workspace_dir ?? '') === cwd ||
        normalizePath(row.project_workspace_dir ?? '') === cwd
      )
    })
    if (!candidates.length) return null
    // 同 cwd 多开时先按首条输入哈希认人（内容对上 = 铁证）
    if (candidates.length > 1 && ref.bindingHash) {
      const hashed = candidates.filter(
        (row) => firstUserPromptHash(db, String(row.session_id)) === ref.bindingHash,
      )
      if (hashed.length) candidates = hashed
    }
    // 再按进程启动时刻认人（同一 cwd 两个 mcode 进程时，pid 锚点最准）
    if (candidates.length > 1) {
      const anchor = mcodeProcessStartMs(ref.pid)
      if (anchor) {
        const near = candidates.filter(
          (row) => Math.abs((Number(row.created_at_ms) || 0) - anchor) <= CLAIM_PID_WINDOW_MS,
        )
        if (near.length) {
          near.sort(
            (a, b) =>
              Math.abs((Number(a.created_at_ms) || 0) - anchor) -
              Math.abs((Number(b.created_at_ms) || 0) - anchor),
          )
          return String(near[0]?.session_id ?? '')
        }
      }
    }
    // 兜底取最新（rows 已按 created_at_ms 倒序）
    return String(candidates[0]?.session_id ?? '') || null
  } catch {
    return null
  } finally {
    safeClose(db)
  }
}

/** 活会话正文：按消息行解析（与历史正文同一套 parts 还原） */
function readMcodeMessages(id: string): TranscriptMessage[] {
  const db = openDb()
  if (!db) return []
  try {
    return readMcodeMessagesFrom(db, id)
  } finally {
    safeClose(db)
  }
}

function readMcodeMessagesFrom(db: DatabaseSync, id: string): TranscriptMessage[] {
  try {
    const rows = db
      .prepare(
        `SELECT role, created_at_ms, data_json
           FROM local_runtime_message_rows
          WHERE session_id = ?
          ORDER BY id`
      )
      .all(id) as unknown as { role: string | null; created_at_ms: number; data_json: string }[]
    const messages: TranscriptMessage[] = []
    for (const row of rows) {
      const msg = toMessage(row)
      if (msg) messages.push(msg)
    }
    return messages
  } catch {
    return []
  }
}

/** 红绿灯快照：正文条数 + 末行指纹（行内容原地更新时指纹也要变） */
export interface McodeTrafficSnapshot {
  fingerprint: string
  /** 末条消息（红绿灯判定只看末条，不需要整份正文） */
  lastMessage: TranscriptMessage | null
}

/**
 * 红绿灯判定源：读本地库正文，按末条消息判状态（与 agent-transcript 同口径）。
 * mcode 的 TUI 空闲时仍持续重绘（状态行刷新，实测空闲 30 秒仍输出 464 字节），
 * 「终端静默 15 秒即闲」兜底因此永不触发 → 红灯卡死（2026-11-10 报障）。
 * 一条消息都没有时不返回快照（保持调用方当前状态，别把刚提交的红灯压成绿灯）。
 */
export function mcodeTrafficSnapshot(id: string): McodeTrafficSnapshot | null {
  if (!MCODE_SESSION_ID.test(id)) return null
  const db = openDb()
  if (!db) return null
  try {
    const stat = db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(id) AS max_id
           FROM local_runtime_message_rows
          WHERE session_id = ?`
      )
      .get(id) as unknown as { n: number; max_id: number } | undefined
    if (!stat || !stat.n) return null
    const last = db
      .prepare(
        `SELECT id, role, created_at_ms, data_json
           FROM local_runtime_message_rows
          WHERE session_id = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(id) as unknown as { id: number; role: string | null; created_at_ms: number; data_json: string } | undefined
    const tail = last ? crypto.createHash('sha1').update(last.data_json).digest('hex').slice(0, 12) : ''
    // role 必须带出来：末行是 user 时要判成「刚提交、还在跑」（红灯），不能当 assistant 判成绿灯
    const lastMessage = last ? toMessage(last) : null
    return { fingerprint: `${stat.n}:${stat.max_id}:${tail}`, lastMessage }
  } catch {
    return null
  } finally {
    safeClose(db)
  }
}

/** 会话是否还在 mcode 库里（认领到的 id 可能已被 mcode 自己清掉） */
function mcodeSessionExists(id: string): boolean {
  const db = openDb()
  if (!db) return false
  try {
    return Boolean(db.prepare('SELECT 1 AS n FROM local_runtime_sessions WHERE session_id = ?').get(id))
  } catch {
    return false
  } finally {
    safeClose(db)
  }
}

/**
 * 游标语义＝消息序号（与 agent-transcript 的消息序号游标同口径，客户端只当不透明单调游标用）：
 *  cursor=0 → 尾页（带 start，整页替换）；cursor>0 → 增量追加；before=N → 更早一页。
 */
function paginateMcode(messages: TranscriptMessage[], opts: { cursor: number; before?: number }): TranscriptPage {
  const total = messages.length
  if (opts.before !== undefined) {
    const end = Math.max(0, Math.min(opts.before, total))
    const start = Math.max(0, end - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start, end), cursor: end, start, hasMore: start > 0 }
  }
  if (opts.cursor === 0 || total < opts.cursor) {
    const start = Math.max(0, total - PAGE_MESSAGES)
    return { exists: true, messages: messages.slice(start), cursor: total, start, hasMore: start > 0 }
  }
  return { exists: true, messages: messages.slice(opts.cursor), cursor: total }
}

/**
 * 座舱活会话的对话正文：优先用已认领并持久化的 agentSessionId（确定性映射），
 * 没有才认领一次并回写（bindAgentSession）。认不到返回空页（对话视图空白，等下一轮）。
 */
export function readMcodeLiveTranscript(
  session: {
    agentSessionId: string | null
    cwd: string
    startedAt: number | null
    createdAt: number
    pid: number | null
    agentBindingHash: string | null
    bindAgentSession?: (id: string) => void
  },
  opts: { cursor: number; before?: number },
): TranscriptPage {
  let id = session.agentSessionId && MCODE_SESSION_ID.test(session.agentSessionId) ? session.agentSessionId : ''
  if (!id) {
    id =
      claimMcodeSessionId({
        cwd: session.cwd,
        startedAt: session.startedAt ?? session.createdAt,
        pid: session.pid,
        bindingHash: session.agentBindingHash,
      }) ?? ''
    if (id) session.bindAgentSession?.(id)
  }
  if (!id) return { exists: false, messages: [], cursor: 0 }
  const messages = readMcodeMessages(id)
  if (!messages.length && !mcodeSessionExists(id)) return { exists: false, messages: [], cursor: 0 }
  return paginateMcode(messages, opts)
}

function toMessage(row: { role: string | null; created_at_ms: number; data_json: string }): TranscriptMessage | null {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(row.data_json) as Record<string, unknown>
  } catch {
    return null
  }
  const parts: TranscriptPart[] = []
  const thinking = typeof data.thinking_content === 'string' ? data.thinking_content.trim() : ''
  if (thinking) parts.push({ kind: 'thinking', text: thinking })

  const content = typeof data.msg_content === 'string' ? data.msg_content.trim() : ''
  if (content) parts.push({ kind: 'text', text: content })

  const calls = Array.isArray(data.tool_calls) ? data.tool_calls : []
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const c = call as { tool_name?: unknown; tool_call_args?: unknown }
    const name = typeof c.tool_name === 'string' ? c.tool_name : 'tool'
    const input = typeof c.tool_call_args === 'string' ? c.tool_call_args : JSON.stringify(c.tool_call_args ?? {})
    parts.push({ kind: 'tool_use', name, input })
  }
  if (!parts.length) return null

  const ts = Number(row.created_at_ms)
  return {
    role: row.role === 'user' ? 'user' : 'assistant',
    parts,
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
  }
}

function safeClose(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* 已关闭 */
  }
}

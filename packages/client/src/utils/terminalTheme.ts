// 终端配色判定（会话展示判断的公共出处，客户端与服务端各自引用同一口径）：
// 只渲染深色配色的 agent（mcode）落在浅色终端底上几乎看不见——真机抓色：
// 正文浅灰 rgb(214,214,214) 在白底 #ffffff 上对比度仅 1.45，强调蓝 rgb(104,192,255) 仅 1.99
// （深底 #101014 上分别是 13.06 / 9.56）。这类会话终端底强制深色，与 agent 自绘配色一致。

/** 只渲染深色配色的 agent 命令 basename */
export const DARK_ONLY_TERMINAL_COMMANDS = new Set(['mcode'])

/**
 * 该会话的终端底该用深色还是浅色。
 * @param command 会话命令（取 basename 判定）
 * @param mode areco 全局主题偏好（浅色/深色）
 */
export function terminalThemeFor(
  command: string | null | undefined,
  mode: 'dark' | 'light',
): 'dark' | 'light' {
  const base = (command ?? '').split('/').pop() ?? ''
  if (DARK_ONLY_TERMINAL_COMMANDS.has(base)) return 'dark'
  return mode
}

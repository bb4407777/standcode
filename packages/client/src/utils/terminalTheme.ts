// 终端配色判定（会话展示判断的公共出处，客户端与服务端各自引用同一口径）：
// mcode 自绘配色由服务端 spawn 时注入的 COLORFGBG 决定（恒定浅底方案），
// 客户端终端底必须跟着它走，否则字看不清——真机抓色：
//   浅色配色正文 rgb(48,48,48) 在白底 #ffffff 上对比度 13.2（清晰），在深底上只有 1.44；
//   深色配色正文 rgb(214,214,214) 在白底上只有 1.45（几乎不可见）。
// 所以 mcode 会话终端底恒定浅色，不跟 areco 全局浅/深主题变（两边恒定一致，不会错配）。

/** 配色固定为浅底方案的 agent 命令 basename */
export const FIXED_LIGHT_TERMINAL_COMMANDS = new Set(['mcode'])

/**
 * 该会话的终端底该用深色还是浅色。
 * @param command 会话命令（取 basename 判定）
 * @param mode areco 全局主题偏好（浅色/深色）——只对跟随全局的 agent 生效
 */
export function terminalThemeFor(
  command: string | null | undefined,
  mode: 'dark' | 'light',
): 'dark' | 'light' {
  const base = (command ?? '').split('/').pop() ?? ''
  if (FIXED_LIGHT_TERMINAL_COMMANDS.has(base)) return 'light'
  return mode
}

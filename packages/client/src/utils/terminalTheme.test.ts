import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalThemeFor } from './terminalTheme'

test('terminalThemeFor：mcode 恒定浅底（服务端按浅底配色注入 COLORFGBG，两边必须一致）', () => {
  assert.equal(terminalThemeFor('/Users/gao/.npm-global/bin/mcode', 'light'), 'light')
  assert.equal(terminalThemeFor('/Users/gao/.npm-global/bin/mcode', 'dark'), 'light')
})

test('terminalThemeFor：其他 agent 跟随 areco 全局主题', () => {
  assert.equal(terminalThemeFor('/bin/zsh', 'light'), 'light')
  assert.equal(terminalThemeFor('/bin/zsh', 'dark'), 'dark')
  assert.equal(terminalThemeFor('/Applications/WorkBuddy.app/.../codebuddy', 'light'), 'light')
  assert.equal(terminalThemeFor(undefined, 'light'), 'light')
  assert.equal(terminalThemeFor('', 'dark'), 'dark')
})

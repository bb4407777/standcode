import assert from 'node:assert/strict'
import test from 'node:test'
import { terminalThemeFor } from './terminalTheme'

test('terminalThemeFor：mcode 强制深色终端底（白底上正文对比度仅 1.45，看不清）', () => {
  assert.equal(terminalThemeFor('/Users/gao/.npm-global/bin/mcode', 'light'), 'dark')
  assert.equal(terminalThemeFor('/Users/gao/.npm-global/bin/mcode', 'dark'), 'dark')
})

test('terminalThemeFor：其他 agent 跟随 areco 全局主题', () => {
  assert.equal(terminalThemeFor('/bin/zsh', 'light'), 'light')
  assert.equal(terminalThemeFor('/bin/zsh', 'dark'), 'dark')
  assert.equal(terminalThemeFor('/Applications/WorkBuddy.app/.../codebuddy', 'light'), 'light')
  assert.equal(terminalThemeFor(undefined, 'light'), 'light')
  assert.equal(terminalThemeFor('', 'dark'), 'dark')
})

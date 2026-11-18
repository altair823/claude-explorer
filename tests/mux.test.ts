import { expect, test } from 'claude-code/testing'

import { focusSteps, hereOf, launchArgv, newTabSteps, resumeArgv, zellijTabOf } from '../hooks/mux'

const z = { kind: 'zellij' as const, session: 'hb', pane: 11 }
test('focus in same zellij session', () => {
  expect(focusSteps(z, { kind: 'zellij', session: 'hb' }, 7)).toEqual([['zellij', 'action', 'go-to-tab-by-id', '7'], ['zellij', 'action', 'focus-pane-id', 'terminal_11']])
})
test('focus in another zellij session switches last', () => {
  const steps = focusSteps(z, { kind: 'zellij', session: 'work' }, 7) as string[][]
  expect(steps.at(-1)).toEqual(['zellij', 'action', 'switch-session', 'hb'])
  expect(steps[0]!.slice(0, 3)).toEqual(['zellij', '--session', 'hb'])
  expect(steps).toHaveLength(3)
})
test('focus across kinds is an error with the location', () => {
  const r = focusSteps(z, { kind: 'tmux', socket: '/tmp/tmux-1000/default' })
  expect(r).toEqual({ error: expect.stringContaining('hb') })
  expect(focusSteps(z, undefined)).toHaveProperty('error')
})
test('tmux focus', () => {
  expect(focusSteps({ kind: 'tmux', socket: '/s', pane: '%4' }, { kind: 'tmux', socket: '/s' })).toEqual([
    ['tmux', '-S', '/s', 'select-window', '-t', '%4'], ['tmux', '-S', '/s', 'select-pane', '-t', '%4'], ['tmux', '-S', '/s', 'switch-client', '-t', '%4']])
  // 다른 tmux 서버의 창은 이 클라이언트로 옮길 수 없다
  expect(focusSteps({ kind: 'tmux', socket: '/other', pane: '%4' }, { kind: 'tmux', socket: '/s' })).toHaveProperty('error')
})
test('new tab commands', () => {
  expect(newTabSteps({ kind: 'zellij', session: 'hb' }, '/p/app', 'app', resumeArgv('claude', 'df37'))).toEqual([['zellij', 'action', 'new-tab', '--cwd', '/p/app', '--name', 'app', '--', 'claude', '--resume', 'df37']])
  expect(newTabSteps({ kind: 'zellij', session: 'hb' }, '/p/app', 'app', launchArgv('t'))).toEqual([['zellij', 'action', 'new-tab', '--cwd', '/p/app', '--name', 'app']])
  expect(newTabSteps({ kind: 'tmux', socket: '/s' }, '/p/app', 'app', resumeArgv('codex', 'c1'))).toEqual([['tmux', '-S', '/s', 'new-window', '-c', '/p/app', '-n', 'app', 'codex resume c1']])
  expect(newTabSteps(undefined, '/p/app', 'app', ['claude'])).toEqual({ error: expect.stringContaining('cd /p/app && claude') })
  expect(newTabSteps(undefined, '/p/my app', 'app', [])).toEqual({ error: expect.stringContaining("cd '/p/my app'") })
})
test('finds tab of pane', () => {
  // zellij 0.45.1 `list-panes -t -j` 출력에서 줄인 입력. 터미널 창 id와 플러그인 창 id는 겹칠 수 있다.
  const json = JSON.stringify([{ id: 0, is_plugin: true, tab_id: 0 }, { id: 0, is_plugin: false, tab_id: 0 }, { id: 11, is_plugin: false, tab_id: 7 }])
  expect(zellijTabOf(json, 11)).toBe(7)
  expect(zellijTabOf(json, 99)).toBeUndefined()
  expect(zellijTabOf('깨진 출력', 11)).toBeUndefined()
})
test('here comes from the own session entry', () => {
  expect(hereOf({ kind: 'zellij', session: 'hb', pane: 3 })).toEqual({ kind: 'zellij', session: 'hb' })
  expect(hereOf({ kind: 'tmux', socket: '/s', pane: '%1' })).toEqual({ kind: 'tmux', socket: '/s' })
  expect(hereOf(undefined)).toBeUndefined()
})

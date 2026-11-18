import { expect, test } from 'claude-code/testing'

import { memState } from './state'
import { world } from './world'
import type { World } from './world'

// 시험 환경에는 있지만 타입 정의(lib)에는 없는 전역 함수
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const PANE = {
  plugin: 'session-explorer', surface: 'terminal', component: 'Pane', requestId: 'session-explorer',
  props: { title: '탐색기', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const settle = () => new Promise(r => setTimeout(r, 30))
const SELF_PROBE = '100\tclaude\tS1\t/home/u/p\t/dev/pts/1\tclaude\tse-test\t3\t\t\t\n'
const SELF_REG = '{"pid":100,"sessionId":"self","cwd":"/home/u/p","status":"busy","name":"explorer","procProcess":"x","procStart":"S1"}'
const view = (o: object = {}) => ({ top: '/home/u/p', open: [], cur: '', more: [], hidden: false, start: 0, ...o })
const emptyData = { live: [], past: {}, lists: {}, git: {} }

// 환경과 저장된 값을 준비하고 패널을 그린다
async function setup($: any, on: any, wo: Partial<World> = {}, v: object = view(), d: object = emptyData) {
  const w = world(on, { dirs: { '/': [{ name: 'home', kind: 'dir' }], '/home': [{ name: 'u', kind: 'dir' }], '/home/u': [{ name: 'p', kind: 'dir' }], '/home/u/p': [] }, ...wo })
  const mem = memState(on)
  mem.put('view', 'view-2', v)
  mem.put('data', 'data-1', d)
  const ui = await $.ui.mount(PANE)
  return { w, mem, ui }
}
// 커서를 그 줄에 두고(저장된 값을 바꿔 다시 그린다) 줄 버튼을 누른다. 커서 줄을 누르는 것이므로 연다.
async function openRow(ui: any, mem: any, key: string) {
  mem.put('view', 'view-2', { ...mem.get('view'), cur: key })
  await ui.redraw()
  await settle()
  await ui.press({ key: `r:${key}` })
  await settle()
}
// 커서를 그 줄에 두고 단축키 버튼을 누른다
async function hot(ui: any, mem: any, key: string, hotkey: string) {
  mem.put('view', 'view-2', { ...mem.get('view'), cur: key })
  await ui.redraw()
  await settle()
  await ui.press({ key: `act:${hotkey}` })
  await settle()
}

test('pane shows top folder and buttons', async ($, on) => {
  // 홈 밖의 폴더는 그대로 쓴다
  const { ui } = await setup($, on, {}, view({ top: '/srv/p' }))
  expect(await ui.find({ type: 'Text', text: '/srv/p' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /위로/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /세션/ })).toBeDefined()
  await ui.unmount()
})

test('home folder is shortened and outside sessions are counted', async ($, on) => {
  const live = [{ agent: 'claude', pid: 1, cwd: '/home/u/other', name: 'x', state: 'idle' }]
  const { ui } = await setup($, on, {}, view(), { ...emptyData, live })
  expect(await ui.find({ type: 'Text', text: '~/p' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '트리 밖 세션 1' })).toBeDefined()
  await ui.unmount()
})

test('h moves top', async ($, on) => {
  const { ui, mem } = await setup($, on)
  await ui.press({ key: 'act:h' })
  await settle()
  expect(mem.get('view')).toMatchObject({ top: '/home/u', cur: 'd:/home/u/p' })
  await ui.unmount()
})

const MANY_PAST = Array.from({ length: 7 }, (_, i) => ({ agent: 'claude', id: `s${i}`, cwd: '/home/u/p', title: `대화 ${i}`, mtime: 1000 - i }))

test('more row expands past', async ($, on) => {
  const { ui, mem } = await setup($, on, {}, view(), { ...emptyData, past: { '/home/u/p': MANY_PAST } })
  await openRow(ui, mem, 'm:/home/u/p')
  expect(mem.get('view').more).toEqual(['/home/u/p'])
  await ui.unmount()
})

test('pressing another row only selects it, pressing the cursor row opens it', async ($, on) => {
  const { ui, mem } = await setup($, on, {}, view(), { ...emptyData, past: { '/home/u/p': MANY_PAST } })
  await ui.press({ key: 'r:p:claude:s1' })
  await settle()
  expect(mem.get('view').cur).toBe('p:claude:s1')
  expect(mem.get('view').more).toEqual([])
  await ui.press({ key: 'r:m:/home/u/p' })
  await settle()
  expect(mem.get('view')).toMatchObject({ cur: 'm:/home/u/p', more: [] })
  await ui.press({ key: 'r:m:/home/u/p' })
  await settle()
  expect(mem.get('view').more).toEqual(['/home/u/p'])
  await ui.unmount()
})

test('l expands and collapses the cursor folder, a toggles hidden files', async ($, on) => {
  const d = { ...emptyData, lists: { '/home/u/p': [{ name: 'src', dir: true }, { name: '.env', dir: false }] } }
  const { ui, mem } = await setup($, on, { dirs: { '/': [{ name: 'home', kind: 'dir' }], '/home': [{ name: 'u', kind: 'dir' }], '/home/u': [{ name: 'p', kind: 'dir' }], '/home/u/p': [{ name: 'src', kind: 'dir' }], '/home/u/p/src': [] } }, view(), d)
  await hot(ui, mem, 'd:/home/u/p/src', 'l')
  expect(mem.get('view').open).toEqual(['/home/u/p/src'])
  await hot(ui, mem, 'd:/home/u/p/src', 'l')
  expect(mem.get('view').open).toEqual([])
  await ui.press({ key: 'act:a' })
  await settle()
  expect(mem.get('view').hidden).toBe(true)
  await ui.unmount()
})

test('rows beyond the window are cut with edge lines', async ($, on) => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `f${String(i).padStart(2, '0')}`, dir: false }))
  const { ui } = await setup($, on, {}, view(), { ...emptyData, lists: { '/home/u/p': many } })
  const rowButtons = (await ui.findAll({ type: 'Button' })).filter((b: any) => b.key?.startsWith('r:'))
  expect(rowButtons.length).toBeGreaterThan(5)
  expect(rowButtons.length).toBeLessThan(25)
  expect(await ui.find({ type: 'Text', text: /▼ 아래로 \d+줄/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▲/ })).toBeUndefined()
  await ui.unmount()
})

test('top folder removed', async ($, on) => {
  // 맨 위 폴더가 지워졌다. 남아 있는 가장 가까운 상위 폴더로 옮긴다.
  const { w, mem, ui } = await setup($, on, { dirs: { '/': [], '/home': [], '/home/u': [] } }, view({ top: '/home/u/gone/deep' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(mem.get('view').top).toBe('/home/u')
  expect(w.cmds.some(c => c[0] === 'zellij')).toBe(false)
  await ui.unmount()
})

test('unreadable folder shows a note and no repeated toast', async ($, on) => {
  const { w, mem, ui } = await setup($, on, { dirs: { '/home/u': [{ name: 'p', kind: 'dir' }] } }, view({ top: '/home/u/p' }))
  // /home/u/p는 stat으로는 보이지만 목록을 읽을 수 없다
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(mem.get('data').lists['/home/u/p']).toEqual({ error: '읽을 수 없습니다' })
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

test('refresh reads sessions, folder lists, git marks and past conversations', async ($, on) => {
  const dir = '/home/u/p'
  const proj = '/home/u/.claude/projects/-home-u-p'
  const { w, mem, ui } = await setup($, on, {
    probe: SELF_PROBE,
    files: { '/home/u/.claude/sessions/100.json': SELF_REG },
    dirs: {
      '/': [{ name: 'home', kind: 'dir' }], '/home': [{ name: 'u', kind: 'dir' }], '/home/u': [{ name: 'p', kind: 'dir' }],
      [dir]: [{ name: 'a.ts', kind: 'file' }, { name: 'src', kind: 'dir' }, { name: 'ln', kind: 'other', isLink: true } as any],
      [`${dir}/ln`]: [],
      [proj]: [{ name: 'a1.jsonl', kind: 'file', mtimeMs: 2000 }, { name: 'b2.jsonl', kind: 'file', mtimeMs: 1000 }, { name: 'self.jsonl', kind: 'file', mtimeMs: 3000 }],
    },
    repos: { [dir]: ' M a.ts\0?? src/\0' },
    replies: [
      { when: a => a[0] === 'grep' && a.some(x => x.includes('aiTitle')), stdout: `${proj}/a1.jsonl:"aiTitle":"탐색기 설계"\n` },
      { when: a => a[0] === 'git' && a.includes('--show-toplevel'), stdout: `${dir}\n` },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  const d = mem.get('data')
  expect(d.live).toEqual([{ agent: 'claude', pid: 100, cwd: dir, name: 'explorer', state: 'busy', id: 'self', mux: { kind: 'zellij', session: 'se-test', pane: 3 }, self: true }])
  expect(d.lists[dir]).toEqual([{ name: 'a.ts', dir: false }, { name: 'src', dir: true }, { name: 'ln', dir: true }])
  expect(d.git).toEqual({ [`${dir}/a.ts`]: 'M', [`${dir}/src`]: '?' })
  // 실행 중인 세션(self)의 대화는 끝난 대화에서 빼고, 제목이 없는 대화는 id 앞부분으로 부른다
  expect(d.past[dir].map((p: any) => [p.id, p.title])).toEqual([['a1', '탐색기 설계'], ['b2', 'b2']])
  expect(w.cmds.every(c => c[0] !== 'zellij' && c[0] !== 'tmux')).toBe(true)
  await ui.unmount()
})

test('a failing git status leaves marks as they were and does not toast', async ($, on) => {
  const { w, mem, ui } = await setup($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(mem.get('data').git).toEqual({})
  expect(w.toasts).toEqual([])
  await ui.unmount()
})

// 실행 중인 세션과 끝난 대화가 보이는 상태
const LIVE_STATE = (mux?: object, self = true) => ({
  ...emptyData,
  lists: { '/home/u/p': [{ name: 'a.ts', dir: false }] },
  live: [
    ...(self ? [{ agent: 'claude', pid: 100, cwd: '/home/u/p', name: 'explorer', state: 'busy', id: 'self', self: true, mux: { kind: 'zellij', session: 'hb', pane: 3 } }] : []),
    { agent: 'claude', pid: 200, cwd: '/home/u/p', name: 'other', state: 'idle', id: 'o1', ...(mux && { mux }) },
  ],
  past: { '/home/u/p': [{ agent: 'claude', id: 'c1', cwd: '/home/u/p', title: '옛 대화', mtime: 1000 }, { agent: 'codex', id: 'x1', cwd: '/home/u/p', title: '코덱스 대화', mtime: 500 }] },
})

test('open on a live session in the same zellij session focuses its pane', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {
    replies: [{ when: a => a[0] === 'zellij' && a.includes('list-panes'), stdout: JSON.stringify([{ id: 0, is_plugin: true, tab_id: 0 }, { id: 5, is_plugin: false, tab_id: 4 }]) }],
  }, view(), LIVE_STATE({ kind: 'zellij', session: 'hb', pane: 5 }))
  await openRow(ui, mem, 'l:200')
  expect(w.cmds.filter(c => c[0] === 'zellij')).toEqual([
    ['zellij', '--session', 'hb', 'action', 'list-panes', '-t', '-j'],
    ['zellij', 'action', 'go-to-tab-by-id', '4'],
    ['zellij', 'action', 'focus-pane-id', 'terminal_5'],
  ])
  await ui.unmount()
})

test('open on a live session outside any multiplexer explains where it runs', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE())
  await openRow(ui, mem, 'l:200')
  expect(w.toasts).toEqual(['zellij나 tmux 밖에서 실행 중입니다: /home/u/p (pid 200)'])
  expect(w.cmds.filter(c => c[0] === 'zellij' || c[0] === 'tmux')).toEqual([])
  await ui.unmount()
})

test('open on this session does nothing', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE())
  await openRow(ui, mem, 'l:100')
  expect(w.toasts).toEqual([])
  expect(w.cmds.filter(c => c[0] === 'zellij' || c[0] === 'tmux')).toEqual([])
  await ui.unmount()
})

test('open on a past conversation resumes it in a new tab', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE())
  await openRow(ui, mem, 'p:claude:c1')
  await openRow(ui, mem, 'p:codex:x1')
  expect(w.cmds.filter(c => c[0] === 'zellij')).toEqual([
    ['zellij', 'action', 'new-tab', '--cwd', '/home/u/p', '--name', 'p', '--', 'claude', '--resume', 'c1'],
    ['zellij', 'action', 'new-tab', '--cwd', '/home/u/p', '--name', 'p', '--', 'codex', 'resume', 'x1'],
  ])
  await ui.unmount()
})

test('t, c and x open a new tab in the cursor folder', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE())
  await hot(ui, mem, 'f:/home/u/p/a.ts', 't')
  await hot(ui, mem, 'l:200', 'c')
  await hot(ui, mem, 'u:', 'x')
  expect(w.cmds.filter(c => c[0] === 'zellij')).toEqual([
    ['zellij', 'action', 'new-tab', '--cwd', '/home/u/p', '--name', 'p'],
    ['zellij', 'action', 'new-tab', '--cwd', '/home/u/p', '--name', 'p', '--', 'claude'],
    ['zellij', 'action', 'new-tab', '--cwd', '/home/u', '--name', 'u', '--', 'codex'],
  ])
  await ui.unmount()
})

test('a new tab outside a multiplexer shows the command instead', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE(undefined, false))
  await openRow(ui, mem, 'p:claude:c1')
  expect(w.toasts[0]).toContain('cd /home/u/p && claude --resume c1')
  expect(w.cmds.filter(c => c[0] === 'zellij' || c[0] === 'tmux')).toEqual([])
  await ui.unmount()
})

test('a failing command stops and shows the first stderr line', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {
    replies: [{ when: a => a[0] === 'zellij' && a.includes('go-to-tab-by-id'), exitCode: 1, stderr: 'tab 4 not found\n더 있는 줄\n' }, { when: a => a[0] === 'zellij' && a.includes('list-panes'), stdout: JSON.stringify([{ id: 5, is_plugin: false, tab_id: 4 }]) }],
  }, view(), LIVE_STATE({ kind: 'zellij', session: 'hb', pane: 5 }))
  await openRow(ui, mem, 'l:200')
  expect(w.toasts).toEqual(['tab 4 not found'])
  expect(w.cmds.some(c => c.includes('focus-pane-id'))).toBe(false)
  await ui.unmount()
})

test('open on a file puts @path into the prompt', async ($, on) => {
  const { w, mem, ui } = await setup($, on, {}, view(), LIVE_STATE())
  await openRow(ui, mem, 'f:/home/u/p/a.ts')
  expect(w.filled).toEqual(['@a.ts '])
  await ui.unmount()
})

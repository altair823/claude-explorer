import { expect, test } from 'claude-code/testing'

import { isDouble } from '../hooks/list'
import { memState } from './state'
import { world } from './world'
import type { Data, View } from '../types'

// 시험 환경에는 있지만 타입 정의(lib)에는 없는 전역 함수
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const PANE = {
  plugin: 'session-explorer', surface: 'terminal', component: 'Pane', requestId: 'session-explorer',
  props: { title: '탐색기', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const stateOf = (v: Partial<View>, d: Partial<Data>) => ({ view: { top: '/p', open: [], cur: '', more: [], hidden: false, ...v }, data: { live: [], past: {}, lists: {}, git: {}, ...d } })
// 줄 넷: .., app/(M1 ●1), 그 아래 세션 app-1, a.md(M)
const BASIC = stateOf({ open: ['/p/app'] }, {
  lists: { '/p': [{ name: 'app', dir: true }, { name: 'a.md', dir: false }], '/p/app': [] },
  live: [{ agent: 'claude', pid: 7, cwd: '/p/app', name: 'app-1', state: 'busy' }],
  git: { '/p/app/x.ts': 'M', '/p/a.md': 'M' },
})

// 플러그인의 패널을 그린다. 보낸 값은 ui.message 시험 처리기로 모은다.
async function mount($: any, on: any, st: ReturnType<typeof stateOf>, size = { columns: 40, rows: 6 }) {
  const posts: unknown[] = []
  on('ui.message', (_: unknown, e: { data: unknown }) => (posts.push(e.data), {}))
  // 보기를 바꾸는 키 뒤에 갱신이 돌아도 같은 목록이 읽히도록 가짜 환경에 같은 폴더를 둔다
  world(on, { root: '/p', dirs: { '/': [{ name: 'p', kind: 'dir' }], '/p': [{ name: 'app', kind: 'dir' }, { name: 'a.md', kind: 'file' }], '/p/app': [] } })
  const mem = memState(on)
  mem.put('view', 'view-1', st.view)
  mem.put('data', 'data-1', st.data)
  const ui = await $.ui.mount(PANE)
  await ui.resize({ ...size, in: 'tree' })
  return { ui, posts, mem }
}
const lines = async (ui: any): Promise<string[]> => (await ui.findAll({ type: 'Text', in: 'tree' })).filter((t: any) => t.children.length > 1).map((t: any) => t.text as string)
const settle = () => new Promise(r => setTimeout(r, 30))

const at = (cur: string) => ({ ...BASIC, view: { ...BASIC.view, cur } })

test('moves and opens with keys', async ($, on) => {
  const { ui, mem } = await mount($, on, at('u:'))
  await ui.key({ key: 'down' })
  expect(mem.get('view').cur).toBe('d:/p/app')
  await ui.key({ key: 'return' })
  expect(mem.get('view')).toMatchObject({ top: '/p/app', cur: '', open: [] })
  await ui.unmount()
})

test('backspace goes up', async ($, on) => {
  const { ui, mem } = await mount($, on, at('f:/p/a.md'))
  await ui.key({ key: 'backspace' })
  expect(mem.get('view')).toMatchObject({ top: '/', cur: 'd:/p' })
  await ui.unmount()
})

test('other keys change the view', async ($, on) => {
  const { ui, mem } = await mount($, on, at('d:/p/app'))
  await ui.key({ key: 'left' })
  expect(mem.get('view').open).toEqual([])
  // 시험 환경은 값이 바뀌어도 다시 그리지 않으므로 직접 다시 그린다
  await ui.redraw()
  await settle()
  await ui.key({ key: 'right' })
  expect(mem.get('view').open).toEqual(['/p/app'])
  await ui.key({ key: '.' })
  expect(mem.get('view').hidden).toBe(true)
  await ui.key({ key: 's' })
  expect(mem.get('view')).toMatchObject({ top: '/p', cur: 'l:7' })
  await ui.unmount()
})

test('left on a child goes to its folder row', async ($, on) => {
  const { ui, mem } = await mount($, on, at('l:7'))
  await ui.key({ key: 'left' })
  expect(mem.get('view').cur).toBe('d:/p/app')
  await ui.unmount()
})

test('double click opens, slow second click only moves', async ($, on) => {
  const { ui, mem } = await mount($, on, at('u:'))
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left' })
  expect(mem.get('view')).toMatchObject({ top: '/p', cur: 'd:/p/app' })
  await ui.pointer({ type: 'down', x: 3, y: 1, button: 'left' })
  expect(mem.get('view')).toMatchObject({ top: '/p/app', cur: '' })
  // 폴더로 들어가면 줄이 바뀐다. 보기와 목록을 처음 상태로 돌려 놓는다.
  await settle()
  mem.put('view', 'view-1', at('u:').view)
  mem.put('data', 'data-1', at('u:').data)
  await ui.redraw()
  await settle()
  await ui.pointer({ type: 'down', x: 3, y: 3, button: 'left' })
  await new Promise(r => setTimeout(r, 450))
  await ui.pointer({ type: 'down', x: 3, y: 3, button: 'left' })
  expect(mem.get('view')).toMatchObject({ top: '/p', cur: 'f:/p/a.md' })
  await ui.unmount()
})

test('isDouble uses 400ms and the same row', () => {
  expect(isDouble({ key: 'a', t: 1000 }, 'a', 1300)).toBe(true)
  expect(isDouble({ key: 'a', t: 1000 }, 'a', 1500)).toBe(false)
  expect(isDouble({ key: 'a', t: 1000 }, 'b', 1100)).toBe(false)
  expect(isDouble(undefined, 'a', 1100)).toBe(false)
})

test('fits narrow width', async ($, on) => {
  const long = '가'.repeat(30) + 'x'.repeat(30)
  const st = stateOf({ open: [`/p/${long}`], cur: `d:/p/${long}` }, {
    lists: { '/p': [{ name: long, dir: true }], [`/p/${long}`]: [] },
    live: [{ agent: 'codex', pid: 1, cwd: `/p/${long}`, name: long, state: 'running', self: true }],
    git: { [`/p/${long}/f`]: 'M', [`/p/${long}/g`]: 'M' },
  })
  const { ui } = await mount($, on, st, { columns: 40, rows: 4 })
  const out = await lines(ui)
  const width = (s: string) => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0xac00 && (ch.codePointAt(0) ?? 0) <= 0xd7a3 ? 2 : 1), 0)
  expect(out.length).toBeGreaterThanOrEqual(3)
  for (const l of out) expect(width(l)).toBeLessThanOrEqual(40)
  expect(out[1]).toContain('…')
  expect(out[2]).toContain('…')
  await ui.unmount()
})

test('follows cursor from props', async ($, on) => {
  const { ui, mem } = await mount($, on, { ...BASIC, view: { ...BASIC.view, cur: 'u:' } })
  const inverse = async () => (await ui.findAll({ type: 'Text', in: 'tree' })).filter((t: any) => t.props.inverse).map((t: any) => t.text as string)
  expect((await inverse()).join('')).toContain('..')
  mem.put('view', 'view-1', { ...BASIC.view, cur: 'f:/p/a.md' })
  await ui.redraw()
  await settle()
  expect((await inverse()).join('')).toContain('a.md')
  await ui.unmount()
})

test('draws marks, counts and glyphs', async ($, on) => {
  const { ui } = await mount($, on, { ...BASIC, view: { ...BASIC.view, cur: 'u:' } }, { columns: 40, rows: 6 })
  const out = await lines(ui)
  expect(out.find(l => l.includes('app/'))).toMatch(/^ *▾ app\/ +M1 ●1 *$/)
  expect(out.find(l => l.includes('app-1'))).toMatch(/^ +● app-1 +작업 중 *$/)
  expect(out.find(l => l.includes('a.md'))).toMatch(/a\.md +M *$/)
  await ui.unmount()
})

test('cursor returns to its row after the list is read again', async ($, on) => {
  const { ui, mem } = await mount($, on, at('l:7'))
  const inverse = async () => (await ui.findAll({ type: 'Text', in: 'tree' })).filter((t: any) => t.props.inverse).map((t: any) => t.text as string).join('')
  expect(await inverse()).toContain('app-1')
  // 폴더가 바뀐 직후처럼 목록이 아직 비어 있는 동안에는 첫 줄이 커서다
  mem.put('data', 'data-1', { live: [], past: {}, lists: {}, git: {} })
  await ui.redraw()
  await settle()
  expect(await inverse()).toContain('..')
  mem.put('data', 'data-1', BASIC.data)
  await ui.redraw()
  await settle()
  expect(await inverse()).toContain('app-1')
  await ui.unmount()
})

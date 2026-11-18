import { expect, test } from 'claude-code/testing'

import { buildRows, dirCounts, fold, nextSessionView, outsideCount, parseStatus, step } from '../hooks/tree'
import type { Data, View } from '../types'

const home = '/home/u'
const data = (o: Partial<Data> = {}): Data => ({ live: [], past: {}, lists: {}, git: {}, ...o })
const view = (o: Partial<View> = {}): View => ({ top: '/home/u/p', open: [], cur: '', more: [], hidden: false, ...o })

test('parses porcelain -z', () => {
  const z = ' M hooks/a.ts\0?? new dir/\0R  b.ts\0old b.ts\0D  gone.md\0A  added.ts\0UU conflict.ts\0'
  expect(parseStatus(z, '/r')).toEqual({ '/r/hooks/a.ts': 'M', '/r/new dir': '?', '/r/b.ts': 'R', '/r/gone.md': 'D', '/r/added.ts': 'A', '/r/conflict.ts': 'M' })
})
test('counts changes up the tree', () => {
  expect(dirCounts({ '/r/hooks/a.ts': 'M', '/r/hooks/b.ts': '?' })['/r/hooks']).toBe(2)
  expect(dirCounts({ '/r/hooks/a.ts': 'M' })['/r']).toBe(1)
})
test('sessions sit under their folder', () => {
  const rows = buildRows(view({ open: ['/home/u/p/app'] }), data({
    lists: { '/home/u/p': [{ name: 'app', dir: true }, { name: 'README.md', dir: false }], '/home/u/p/app': [{ name: 'main.ts', dir: false }] },
    live: [{ agent: 'claude', pid: 7, cwd: '/home/u/p/app', name: 'app-1', state: 'busy' }],
    git: { '/home/u/p/app/main.ts': 'M' },
  }), home)
  expect(rows.map(r => [r.key, r.depth])).toEqual([['u:', 0], ['d:/home/u/p/app', 0], ['l:7', 1], ['f:/home/u/p/app/main.ts', 1], ['f:/home/u/p/README.md', 0]])
  expect(rows[1]).toMatchObject({ mark: 'M1', count: 1, open: true })
  expect(rows[2]!.note).toBe('작업 중')
})
test('shows five past sessions then more', () => {
  const past = Array.from({ length: 8 }, (_, i) => ({ agent: 'claude' as const, id: `s${i}`, cwd: '/home/u/p', title: `대화 ${i}`, mtime: Date.parse('2026-11-17T00:00:00Z') - i }))
  const rows = buildRows(view(), data({ lists: { '/home/u/p': [] }, past: { '/home/u/p': past } }), home)
  expect(rows.filter(r => r.kind === 'past')).toHaveLength(5)
  expect(rows.at(-1)).toMatchObject({ key: 'm:/home/u/p', text: '… 끝난 대화 3개 더 보기' })
  expect(buildRows(view({ more: ['/home/u/p'] }), data({ lists: { '/home/u/p': [] }, past: { '/home/u/p': past } }), home).filter(r => r.kind === 'past')).toHaveLength(8)
})
test('caps entries at 500', () => {
  const many = Array.from({ length: 1200 }, (_, i) => ({ name: `f${i}`, dir: false }))
  const rows = buildRows(view(), data({ lists: { '/home/u/p': many } }), home)
  expect(rows.filter(r => r.kind === 'file')).toHaveLength(500)
  expect(rows.at(-1)).toMatchObject({ kind: 'note', text: '… 700개 더' })
})
test('hides dotfiles and .git', () => {
  const lists = { '/home/u/p': [{ name: '.git', dir: true }, { name: '.env', dir: false }, { name: 'a', dir: false }] }
  expect(buildRows(view(), data({ lists }), home).map(r => r.key)).toEqual(['u:', 'f:/home/u/p/a'])
  expect(buildRows(view({ hidden: true }), data({ lists }), home).map(r => r.key)).toEqual(['u:', 'f:/home/u/p/.env', 'f:/home/u/p/a'])
})
test('no git marks outside repo', () => {
  const rows = buildRows(view(), data({ lists: { '/home/u/p': [{ name: 'a', dir: false }] } }), home)
  expect(rows[1]!.mark).toBeUndefined()
})
test('read failure becomes a note row', () => {
  const rows = buildRows(view(), data({ lists: { '/home/u/p': { error: '읽을 수 없습니다' } } }), home)
  expect(rows.at(-1)).toMatchObject({ kind: 'note', text: '읽을 수 없습니다' })
})
test('s cycles running sessions', () => {
  const live = [
    { agent: 'claude' as const, pid: 2, cwd: '/home/u/p/b', name: 'b', state: 'idle' as const },
    { agent: 'claude' as const, pid: 1, cwd: '/home/u/p/a', name: 'a', state: 'busy' as const },
  ]
  const v1 = nextSessionView(view({ top: '/' }), live)
  expect(v1).toMatchObject({ top: '/home/u/p', cur: 'l:1' })
  expect(v1.open).toContain('/home/u/p/a')
  expect(nextSessionView(v1, live).cur).toBe('l:2')
  expect(nextSessionView(nextSessionView(v1, live), live).cur).toBe('l:1')
  expect(outsideCount('/home/u/p/a', live)).toBe(1)
})
test('folds home', () => {
  expect(fold('/home/u/p', home)).toBe('~/p')
  expect(fold('/home/u', home)).toBe('~')
  expect(fold('/home/user/p', home)).toBe('/home/user/p')
})

test('step changes only the view', () => {
  const v = view({ open: ['/home/u/p/app'] })
  const d = data({ lists: { '/home/u/p': [{ name: 'app', dir: true }] }, past: { '/home/u/p': Array.from({ length: 7 }, (_, i) => ({ agent: 'claude' as const, id: `s${i}`, cwd: '/home/u/p', title: `t${i}`, mtime: i })) } })
  const rows = buildRows(v, d, home)
  expect(step(v, { act: 'up' }, rows, [])).toMatchObject({ top: '/home/u', cur: 'd:/home/u/p' })
  expect(step(view({ top: '/' }), { act: 'up' }, [], [])).toMatchObject({ top: '/' })
  expect(step(v, { act: 'open', key: 'u:' }, rows, [])).toMatchObject({ top: '/home/u' })
  expect(step(v, { act: 'open', key: 'd:/home/u/p/app' }, rows, [])).toEqual(view({ top: '/home/u/p/app', open: [], cur: '' }))
  expect(step(v, { act: 'open', key: 'm:/home/u/p' }, rows, [])!.more).toEqual(['/home/u/p'])
  expect(step(v, { act: 'open', key: 'f:/home/u/p/x' }, rows, [])).toBeUndefined()
  expect(step(v, { act: 'collapse', key: 'd:/home/u/p/app' }, rows, [])!.open).toEqual([])
  expect(step(view(), { act: 'expand', key: 'd:/home/u/p/app' }, rows, [])!.open).toEqual(['/home/u/p/app'])
  expect(step(v, { act: 'hidden' }, rows, [])!.hidden).toBe(true)
  expect(step(v, { act: 'tab', kind: 't', key: 'd:/home/u/p' }, rows, [])).toBeUndefined()
})

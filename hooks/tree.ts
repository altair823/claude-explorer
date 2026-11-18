import type { Data, Live, View } from '../types'

export type RowKind = 'up' | 'dir' | 'file' | 'live' | 'past' | 'more' | 'note'
// key: 'u:' 상위, 'd:<abs>' 폴더, 'f:<abs>' 파일, 'l:<pid>' 실행 중 세션,
// 'p:<agent>:<id>' 끝난 대화, 'm:<abs>' 더 보기, 'n:<abs>:<i>' 안내 줄(누를 수 없음)
export type Row = { key: string; kind: RowKind; depth: number; text: string; open?: boolean; mark?: string; count?: number; note?: string; dim?: boolean }

// 한 폴더에서 그리는 항목 수 상한과 끝난 대화 기본 표시 수
const MAX_ENTRIES = 500
const PAST_SHOWN = 5

// porcelain v1 -z 출력. 항목은 `XY 경로\0`이고 R과 C는 뒤에 옛 경로 항목이 하나 더 붙는다.
export function parseStatus(z: string, root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const items = z.split('\0')
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.length < 4) continue
    const xy = it.slice(0, 2)
    if (/[RC]/.test(xy[0]!) || /[RC]/.test(xy[1]!)) i++
    const mark = xy === '??' ? '?' : xy.includes('R') ? 'R' : xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : 'M'
    out[`${root}/${it.slice(3).replace(/\/$/, '')}`] = mark
  }
  return out
}

// 경로의 모든 상위 폴더(`/`까지)에 1을 더한다
function bump(counts: Record<string, number>, path: string) {
  for (let p = path; p !== '/' && p !== ''; ) {
    const i = p.lastIndexOf('/')
    p = i <= 0 ? '/' : p.slice(0, i)
    counts[p] = (counts[p] ?? 0) + 1
  }
}

export function dirCounts(git: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const path of Object.keys(git)) bump(counts, path)
  return counts
}

// 세션의 작업 폴더 자체도 센다
export function liveCounts(live: Live[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const l of live) {
    counts[l.cwd] = (counts[l.cwd] ?? 0) + 1
    bump(counts, l.cwd)
  }
  return counts
}

export function fold(path: string, home: string): string {
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const parentOf = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const pad = (n: number) => String(n).padStart(2, '0')
const STATE = { busy: '작업 중', idle: '대기', running: '실행 중' }

export function buildRows(view: View, data: Data, home: string): Row[] {
  const rows: Row[] = []
  const changed = dirCounts(data.git)
  const running = liveCounts(data.live)

  const sessions = (dir: string, depth: number) => {
    for (const l of data.live.filter(x => x.cwd === dir)) {
      const note = `${STATE[l.state]}${l.agent === 'codex' ? ' codex' : ''}${l.self ? ' 이 세션' : ''}`
      rows.push({ key: `l:${l.pid}`, kind: 'live', depth, text: l.name || (l.id ?? '').slice(0, 8) || l.agent, note })
    }
    const past = data.past[dir] ?? []
    const all = view.more.includes(dir)
    for (const p of all ? past : past.slice(0, PAST_SHOWN)) {
      const d = new Date(p.mtime)
      rows.push({ key: `p:${p.agent}:${p.id}`, kind: 'past', depth, text: p.title, dim: true, note: `${pad(d.getMonth() + 1)}-${pad(d.getDate())}` })
    }
    if (!all && past.length > PAST_SHOWN) rows.push({ key: `m:${dir}`, kind: 'more', depth, text: `… 끝난 대화 ${past.length - PAST_SHOWN}개 더 보기`, dim: true })
  }

  const entries = (dir: string, depth: number) => {
    const list = data.lists[dir]
    if (!list) return
    if ('error' in list) return void rows.push({ key: `n:${dir}:0`, kind: 'note', depth, text: list.error, dim: true })
    const shown = list
      .filter(e => e.name !== '.git' && (view.hidden || !e.name.startsWith('.')))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    for (const e of shown.slice(0, MAX_ENTRIES)) {
      const path = join(dir, e.name)
      if (!e.dir) {
        const mark = data.git[path]
        rows.push({ key: `f:${path}`, kind: 'file', depth, text: e.name, ...(mark && { mark }) })
        continue
      }
      const open = view.open.includes(path)
      const mark = data.git[path] ?? (changed[path] ? `M${changed[path]}` : undefined)
      rows.push({ key: `d:${path}`, kind: 'dir', depth, text: `${e.name}/`, open, ...(mark && { mark }), ...(running[path] && { count: running[path] }) })
      if (open) {
        sessions(path, depth + 1)
        entries(path, depth + 1)
      }
    }
    if (shown.length > MAX_ENTRIES) rows.push({ key: `n:${dir}:1`, kind: 'note', depth, text: `… ${shown.length - MAX_ENTRIES}개 더`, dim: true })
  }

  if (view.top !== '/') rows.push({ key: 'u:', kind: 'up', depth: 0, text: '..' })
  sessions(view.top, 0)
  entries(view.top, 0)
  return rows
}

const inside = (cwd: string, top: string) => cwd === top || cwd.startsWith(top === '/' ? '/' : `${top}/`)

export const outsideCount = (top: string, live: Live[]): number => live.filter(l => !inside(l.cwd, top)).length

// 실행 중 세션을 cwd, pid 순으로 놓고 커서가 가리키는 다음 것(마지막이면 처음)으로 옮긴다
export function nextSessionView(view: View, live: Live[]): View {
  const sorted = [...live].sort((a, b) => a.cwd.localeCompare(b.cwd) || a.pid - b.pid)
  if (!sorted.length) return view
  const at = sorted.findIndex(l => `l:${l.pid}` === view.cur)
  const next = sorted[(at + 1) % sorted.length]!
  return { ...view, top: parentOf(next.cwd), open: [...new Set([...view.open, next.cwd])], cur: `l:${next.pid}` }
}

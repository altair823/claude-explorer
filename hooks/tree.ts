import type { Data, Live, View } from '../types'
import { clip, width } from './text'

export type RowKind = 'up' | 'dir' | 'file' | 'live' | 'past' | 'more' | 'note'
// key: 'u:' 상위, 'd:<abs>' 폴더, 'f:<abs>' 파일, 'l:<pid>' 실행 중 세션,
// 'p:<agent>:<id>' 끝난 대화, 'm:<abs>' 더 보기, 'n:<abs>:<i>' 안내 줄(누를 수 없음)
export type Row = { key: string; kind: RowKind; depth: number; text: string; open?: boolean; mark?: string; count?: number; note?: string; dim?: boolean }

// 줄과 단축키 버튼이 hooks 모듈의 동작 함수에 보내는 요청
export type Msg =
  | { act: 'move' | 'open' | 'expand' | 'collapse'; key: string }
  | { act: 'tab'; kind: 't' | 'c' | 'x'; key: string }
  | { act: 'up' | 'next' | 'hidden' }

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
  if (!home) return path
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

// 보기 상태만 바꾸는 동작. 프로세스나 입력창이 필요한 동작(세션 이동, 새 탭, 파일 입력)은 undefined를 돌려준다.
// 키의 폴더 경로는 없는 곳이어도 받아들인다. 갱신이 가장 가까운 상위 폴더로 맞춘다.
export function step(view: View, msg: Msg, live: Live[]): View | undefined {
  const up = (): View => (view.top === '/' ? view : { ...view, top: parentOf(view.top), cur: `d:${view.top}` })
  switch (msg.act) {
    case 'move': return { ...view, cur: msg.key }
    case 'expand': return msg.key.startsWith('d:') ? { ...view, open: [...new Set([...view.open, msg.key.slice(2)])] } : view
    case 'collapse': return { ...view, open: view.open.filter(p => `d:${p}` !== msg.key) }
    case 'up': return up()
    case 'hidden': return { ...view, hidden: !view.hidden }
    case 'next': return nextSessionView(view, live)
    case 'open':
      if (msg.key === 'u:') return up()
      if (msg.key.startsWith('d:')) return { ...view, top: msg.key.slice(2), open: [], cur: '' }
      if (msg.key.startsWith('m:')) return { ...view, more: [...new Set([...view.more, msg.key.slice(2)])] }
      return undefined
    default: return undefined
  }
}

// ---- 줄 글자 맞춤 ----

export type Seg = { t: string; color?: string; dim?: boolean }
const MARK_COLOR: Record<string, string> = { M: 'yellow', A: 'green', '?': 'green', D: 'red', R: 'cyan' }

// 줄 앞 기호와 색: 폴더 ▸ ▾, 실행 중 세션 ● ○ ◆, 끝난 대화 ·
function glyph(r: Row): Seg {
  switch (r.kind) {
    case 'dir': return { t: r.open ? '▾' : '▸' }
    case 'live': return r.note?.startsWith('작업 중') ? { t: '●', color: 'green' } : r.note?.startsWith('실행 중') ? { t: '◆', color: 'cyan' } : { t: '○' }
    case 'past': return { t: '·', dim: true }
    default: return { t: ' ' }
  }
}

// 오른쪽 열 후보. 폭이 모자라면 note, count 순으로 뺀다.
function rightColumns(r: Row): Seg[][] {
  const mark: Seg[] = r.mark ? [{ t: r.mark, color: MARK_COLOR[r.mark[0]!] }] : []
  const count: Seg[] = r.count ? [{ t: `●${r.count}`, color: 'green' }] : []
  const note: Seg[] = r.note ? [{ t: r.note, dim: true }] : []
  return [[...mark, ...count, ...note], [...mark, ...count], mark, []]
}
const sep = (cols: Seg[]): Seg[] => cols.flatMap((s, i) => (i ? [{ t: ' ' }, s] : [s]))
const MIN_NAME = 6

// 한 줄을 width칸에 맞춘다: 들여쓰기, 기호, 이름 / 빈칸 / 오른쪽 열. 조각의 표시 폭 합은 늘 width다.
export function fitRow(row: Row, w: number): Seg[] {
  const head = '  '.repeat(row.depth)
  const prefixW = width(head) + 2
  for (const cand of rightColumns(row)) {
    const right = sep(cand)
    const rw = right.reduce((n, s) => n + width(s.t), 0)
    const room = w - rw - (rw ? 1 : 0)
    if (cand.length && room < prefixW + Math.min(width(row.text), MIN_NAME)) continue
    const name = clip(row.text, Math.max(1, room - prefixW))
    const used = prefixW + width(name)
    return [{ t: head }, glyph(row), { t: ` ${name}`, dim: row.dim }, { t: ' '.repeat(Math.max(0, w - used - rw)) }, ...right]
  }
  return [{ t: ' '.repeat(w) }]
}

// ---- 누름 판단 ----

export type PressState = { cur: string; focusedAt: number; lastPress?: { key: string; t: number } }
// 2026-11-19 Claude Code 2.1.327에서 tmux(SGR 마우스)로 확인한 결과, 마우스 클릭은 ui.press만 보내고 사람의 ui.focus는 보내지 않는다.
// 방향키 이동은 사람의 ui.focus를 보낸다. 그래서 클릭 판단은 "커서가 아닌 줄이면 선택"이면 충분하고, 이 시간은 같은 입력이 둘로 겹쳐 올 때를
// 위한 아주 짧은 여유다(방향키 직후의 Enter는 보통 100ms 이상 뒤에 온다).
export const CLICK_MS = 30
const AGAIN_MS = 400

// 커서가 아닌 줄을 누르면 select, 커서 줄을 누르면 open이다. 방금 클릭이 커서를 이 줄로 옮겼으면(직전 누름이 같은 줄이 아니면) select다.
export function pressKind(state: PressState, key: string, now: number): 'select' | 'open' {
  if (key !== state.cur) return 'select'
  const last = state.lastPress
  if (last?.key === key && now - last.t <= AGAIN_MS) return 'open'
  if (last?.key !== key && now - state.focusedAt <= CLICK_MS) return 'select'
  return 'open'
}

// ---- 스크롤 창 ----

type Win = Pick<View, 'cur' | 'start'>
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// 줄이 창보다 많을 때 보이는 첫 줄 번호. 커서 줄이 창 밖이면 커서가 끝에 보이도록 옮긴다.
export function windowStart(rows: Row[], v: Win, height: number): number {
  const s = clamp(v.start, 0, Math.max(0, rows.length - height))
  const i = rows.findIndex(r => r.key === v.cur)
  if (i < 0) return s
  return i < s ? i : i >= s + height ? i - height + 1 : s
}

// 방향키로 창 끝에서 더 나가려 할 때: 다음(dir 1) 또는 이전(dir -1) 줄이 창 끝에 보이도록 창을 옮기고 커서를 그 줄로 옮긴다.
// 더 갈 줄이 없으면 undefined.
export function stepped(rows: Row[], v: Win, height: number, dir: 1 | -1): Win | undefined {
  const i = rows.findIndex(r => r.key === v.cur)
  const j = i + dir
  if (i < 0 || j < 0 || j >= rows.length) return undefined
  const s = windowStart(rows, v, height)
  return { cur: rows[j]!.key, start: clamp(dir > 0 ? Math.max(s, j - height + 1) : Math.min(s, j), 0, Math.max(0, rows.length - height)) }
}

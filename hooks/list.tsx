import type { ClientModule } from 'claude-code'

import type { Row } from './tree'

export type ListProps = { rows: Row[]; cur: string }
export type Msg =
  | { act: 'move' | 'open' | 'expand' | 'collapse'; key: string }
  | { act: 'tab'; kind: 't' | 'c' | 'x'; key: string }
  | { act: 'up' | 'next' | 'hidden' }

type Last = { key: string; t: number }
// ctl은 매번 그릴 때 최신 props로 고치는 참조다. 키와 마우스 처리기는 처음 그릴 때 한 번만 등록되므로 이것으로 최신 줄 목록을 본다.
// posted는 우리가 보낸 move의 키로, hooks가 돌려준 같은 값(props.cur)을 커서 이동 명령으로 착각하지 않게 한다.
type St = { cur: string; top: number; propCur: string; last?: Last; ctl: { props: ListProps; posted: string[] } }

const DOUBLE_MS = 400

// 같은 줄을 400ms 안에 다시 누르면 더블클릭이다
export const isDouble = (last: Last | undefined, key: string, t: number): boolean => !!last && last.key === key && t - last.t <= DOUBLE_MS

// 칸 폭: 한글과 이모지는 두 칸
const cw = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    ? 2
    : 1
}
const width = (s: string) => [...s].reduce((n, ch) => n + cw(ch), 0)

// cols칸에 들어가도록 끝을 …로 자른다
function clip(s: string, cols: number): string {
  if (width(s) <= cols) return s
  let t = ''
  for (const ch of s) {
    if (width(t) + cw(ch) > cols - 1) break
    t += ch
  }
  return `${t}…`
}

type Seg = { t: string; color?: string; dim?: boolean }
const MARK_COLOR: Record<string, string> = { M: 'yellow', A: 'green', '?': 'green', D: 'red', R: 'cyan' }
const LIVE_GLYPH = (r: Row) => (r.note?.startsWith('작업 중') ? '●' : r.note?.includes('codex') && r.note.startsWith('실행 중') ? '◆' : '○')

// 줄 앞의 기호와 색
function glyph(r: Row): Seg {
  switch (r.kind) {
    case 'dir': return { t: r.open ? '▾' : '▸' }
    case 'live': return { t: LIVE_GLYPH(r), color: r.note?.startsWith('작업 중') ? 'green' : r.note?.startsWith('실행 중') ? 'cyan' : undefined }
    case 'past': return { t: '·', dim: true }
    default: return { t: ' ' }
  }
}

// 오른쪽 열 후보. 폭이 모자라면 note부터 뺀다.
function rights(r: Row): Seg[][] {
  const all: Seg[] = [
    ...(r.mark ? [{ t: r.mark, color: MARK_COLOR[r.mark[0]!] }] : []),
    ...(r.count ? [{ t: `●${r.count}`, color: 'green' }] : []),
    ...(r.note ? [{ t: r.note, dim: true }] : []),
  ]
  const noNote = all.filter(s => s.t !== r.note || !r.note)
  const out = [all, noNote, noNote.slice(0, 1), []]
  return out.filter((c, i) => i === 0 || c.length < out[i - 1]!.length)
}
const join = (cols: Seg[]) => cols.flatMap((s, i) => (i ? [{ t: ' ' }, s] : [s]))
const MIN_NAME = 6

// 한 줄을 cols칸에 맞춘다: 왼쪽(들여쓰기, 기호, 이름), 빈칸, 오른쪽 열
function line(r: Row, cols: number): Seg[] {
  const g = glyph(r)
  const head = `${'  '.repeat(r.depth)}`
  const prefixW = width(head) + 2
  for (const cand of rights(r)) {
    const right = join(cand)
    const rw = right.reduce((n, s) => n + width(s.t), 0)
    const room = cols - rw - (rw ? 1 : 0)
    if (cand.length && room < prefixW + Math.min(width(r.text), MIN_NAME)) continue
    const name = clip(r.text, Math.max(1, room - prefixW))
    const left: Seg[] = [{ t: head }, g, { t: ` ${name}`, dim: r.dim }]
    const used = prefixW + width(name)
    return [...left, { t: ' '.repeat(Math.max(0, cols - used - rw)) }, ...right]
  }
  return []
}

const List: ClientModule<ListProps, St> = (props, s) => {
  const { Box, Text } = s.elements
  const fresh = s.state === undefined
  const st: St = s.state ?? { cur: props.cur, top: 0, propCur: props.cur, ctl: { props, posted: [] } }
  st.ctl.props = props
  const rows = props.rows

  if (fresh) {
    const send = (m: Msg) => s.post(m)
    const patch = (p: Partial<St>) => s.setState({ ...(s.state ?? st), ...p })
    const now = () => s.state ?? st
    const move = (i: number) => {
      const rs = now().ctl.props.rows
      const r = rs[Math.max(0, Math.min(rs.length - 1, i))]
      if (!r) return
      const c = now().ctl
      c.posted = [...c.posted, r.key].slice(-8)
      patch({ cur: r.key })
      send({ act: 'move', key: r.key })
    }
    // 커서 이동이 아닌 동작은 hooks가 커서를 옮길 수 있으므로 기록해 둔 값을 비운다
    const act = (m: Msg) => {
      now().ctl.posted = []
      send(m)
    }
    s.onKey(k => {
      const cur = now()
      const rs = cur.ctl.props.rows
      const i = rs.findIndex(r => r.key === cur.cur)
      const r = rs[i]
      const page = Math.max(1, s.rows - 1)
      switch (k.key) {
        case 'up': case 'k': return move(i - 1)
        case 'down': case 'j': return move(i + 1)
        case 'pageup': return move(i - page)
        case 'pagedown': return move(i + page)
        case 'home': return move(0)
        case 'end': return move(rs.length - 1)
        case 'return': return r && act({ act: 'open', key: r.key })
        case 'backspace': case 'h': return act({ act: 'up' })
        case 'right': return r?.kind === 'dir' && !r.open ? act({ act: 'expand', key: r.key }) : undefined
        case 'left': {
          if (r?.kind === 'dir' && r.open) return act({ act: 'collapse', key: r.key })
          // 닫혀 있거나 폴더가 아니면 부모 폴더 줄로 올라간다
          for (let j = i - 1; j >= 0 && r; j--) if (rs[j]!.kind === 'dir' && rs[j]!.depth < r.depth) return move(j)
          return
        }
        case 't': case 'c': case 'x': return r && act({ act: 'tab', kind: k.key, key: r.key })
        case 's': return act({ act: 'next' })
        case '.': return act({ act: 'hidden' })
      }
    })
    s.onPointer(p => {
      if (p.type !== 'down' || p.button !== 'left') return
      const cur = now()
      const r = cur.ctl.props.rows[cur.top + p.y]
      if (!r) return
      const t = Date.now()
      if (isDouble(cur.last, r.key, t)) {
        patch({ cur: r.key, last: undefined })
        return act({ act: 'open', key: r.key })
      }
      patch({ last: { key: r.key, t } })
      move(cur.top + p.y)
    })
    s.setState(st)
  }

  // hooks가 커서를 옮겼으면 그 값을 따른다. 우리가 보낸 move가 돌아온 것은 따르지 않는다.
  if (props.cur !== st.propCur) {
    st.propCur = props.cur
    if (!st.ctl.posted.includes(props.cur)) st.cur = props.cur
  }
  let at = rows.findIndex(r => r.key === st.cur)
  if (at < 0) {
    at = 0
    st.cur = rows[0]?.key ?? ''
  }
  // 커서 줄이 항상 보이도록 맨 위 줄을 맞춘다
  const height = s.rows > 0 ? s.rows : Math.max(1, rows.length)
  st.top = Math.max(0, Math.min(st.top, rows.length - height))
  if (at < st.top) st.top = at
  if (at >= st.top + height) st.top = at - height + 1

  const cols = s.columns > 0 ? s.columns : 40
  return (
    <Box flexDirection="column">
      {rows.slice(st.top, st.top + height).map((r, i) => {
        const on = st.top + i === at
        return (
          <Text key={r.key} wrap="truncate-end">
            {line(r, cols).map(g => <Text color={g.color} dimColor={g.dim && !on} inverse={on}>{g.t}</Text>)}
          </Text>
        )
      })}
    </Box>
  )
}
export default List

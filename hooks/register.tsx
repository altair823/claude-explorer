import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Data, Entry, Live, Past, View } from '../types'
import type { Msg } from './list'
import { focusSteps, hereOf, launchArgv, newTabSteps, resumeArgv, zellijTabOf } from './mux'
import { PROBE, codexCwd, codexIdOf, liveSessions, parseCodexIndex, parseProbe, parseRegistry, parseTitles, slug } from './sessions'
import type { Reg } from './sessions'
import { clip, width } from './text'
import { buildRows, fold, outsideCount, parseStatus, step } from './tree'
import { applyUpgrade, checkUpgrade, readVersion, upgradeLabel } from './upgrade'

const PANE = 'session-explorer'
const EMPTY_VIEW: View = { top: '', open: [], cur: '', more: [], hidden: false }
const EMPTY_DATA: Data = { live: [], past: {}, lists: {}, git: {} }
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const view = atom({ plugin: 'session-explorer', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-1' })
const data = atom({ plugin: 'session-explorer', key: 'data' } as const, EMPTY_DATA, { shape: 'data-1' })

// 사람이 패널을 직접 닫았는지, Codex 대화 파일별 작업 폴더 색인($.store)
const CLOSED = 'closed'
const CODEX_CWD = 'codex-cwd'
// 주기(ms). 세션 목록, 파일 목록, git 상태는 3초, 끝난 대화는 30초. 느린 저장소의 git 상태도 30초.
const FAST_MS = 3000
const PAST_MS = 30_000
const SLOW_GIT_MS = 30_000
const GIT_SLOW = 1000
// 인증이 없을 때 입력을 기다리며 멈추지 않게 한다.
const QUIET = { GIT_TERMINAL_PROMPT: '0' }
const SHOWN = 5
const TITLE_PATTERN = (key: string) => `"${key}":"(\\\\.|[^"\\\\])*"`

let home = ''
let ticker: { cancel: () => void } | undefined
let upgradeTicker: { cancel: () => void } | undefined
let lastFast = 0
let lastPast = 0
let lastRoot = ''

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const parentOf = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || '/'
const relTo = (from: string, to: string) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to)

async function homeDir($: EngineInterface): Promise<string> {
  if (!home) home = (await $.env.get('HOME').catch(() => undefined)) || ''
  return home
}

// ---- 조회 ----

// 실행 중인 Claude와 Codex 세션. 조회에 실패하면 undefined로 지난 값을 둔다.
async function readLive($: EngineInterface): Promise<Live[] | undefined> {
  const probe = await $.process.run(['sh', '-c', PROBE], { timeoutMs: 10_000 }).catch(() => undefined)
  if (!probe || probe.exitCode !== 0) return undefined
  const procs = parseProbe(probe.stdout)
  const h = await homeDir($)
  // 기록 파일 이름이 <pid>.json이다. 실행 중인 claude 프로세스의 것만 읽는다.
  const regs = (
    await Promise.all(procs.filter(p => p.comm === 'claude').map(p => $.fs.read(`${h}/.claude/sessions/${p.pid}.json`).then(parseRegistry, () => undefined)))
  ).filter((r): r is Reg => !!r)
  return liveSessions(regs, procs, await $.session.id().catch(() => ''))
}

async function listDir($: EngineInterface, dir: string): Promise<Entry[] | { error: string }> {
  try {
    const out: Entry[] = []
    for (const e of await $.fs.list(dir)) {
      if (e.kind !== 'other') out.push({ name: e.name, dir: e.kind === 'dir' })
      else if (e.isLink) {
        // 링크는 가리키는 대상으로 판단한다. 끊어진 링크는 뺀다.
        const st = await $.fs.stat(join(dir, e.name)).catch(() => undefined)
        if (st) out.push({ name: e.name, dir: st.kind === 'dir' })
      }
    }
    return out
  } catch {
    return { error: '읽을 수 없습니다' }
  }
}

// 맨 위 폴더가 지워졌으면 남아 있는 가장 가까운 상위 폴더
async function existingTop($: EngineInterface, top: string): Promise<string> {
  let t = top
  while (t !== '/' && !(await $.fs.stat(t).then(s => s.kind === 'dir', () => false))) t = parentOf(t)
  return t
}

// git 저장소의 최상위. 저장소가 아니면 undefined. 폴더마다 30초 동안 기억한다.
const roots = new Map<string, { root: string | undefined; at: number }>()
async function repoRoot($: EngineInterface, dir: string, now: number): Promise<string | undefined> {
  const hit = roots.get(dir)
  if (hit && now - hit.at < 30_000) return hit.root
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, env: QUIET, timeoutMs: 5000 }).catch(() => undefined)
  const root = r?.exitCode === 0 ? r.stdout.trim() || undefined : undefined
  roots.set(dir, { root, at: now })
  return root
}

// 저장소마다 마지막 상태와 읽은 시각. 1초 넘게 걸린 저장소는 30초마다만 읽는다.
const gitMemo = new Map<string, { marks: Record<string, string>; at: number; slow: boolean }>()
async function gitMarks($: EngineInterface, v: View, now: number): Promise<Record<string, string>> {
  const dirs = [v.top, ...v.open]
  const top = await repoRoot($, v.top, now)
  // 맨 위가 저장소 안이면 그 저장소 하나, 밖이면 펼친 폴더 가운데 저장소의 최상위인 것마다
  const targets = top ? [top] : (await Promise.all(dirs.slice(1).map(async d => ((await repoRoot($, d, now)) === d ? d : undefined)))).filter((d): d is string => !!d)
  const out: Record<string, string> = {}
  for (const root of targets) {
    const memo = gitMemo.get(root)
    if (!memo || now - memo.at >= (memo.slow ? SLOW_GIT_MS : FAST_MS) - 100) {
      const r = await $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v1', '-z'], { cwd: root, env: QUIET, timeoutMs: 20_000 }).catch(() => undefined)
      const done = await $.clock.now()
      // 실패는 표시 없이 넘어간다(지난 표시를 그대로 둔다)
      if (r?.exitCode === 0) gitMemo.set(root, { marks: parseStatus(r.stdout, root), at: now, slow: done - now > GIT_SLOW })
      else if (memo) memo.at = now
    }
    Object.assign(out, gitMemo.get(root)?.marks)
  }
  return out
}

// 파일 이름 끝 UUID 앞쪽 8자. 제목을 찾지 못한 대화의 이름이다.
const shortId = (id: string) => id.slice(0, 8)

// 파일 경로와 수정 시각별 제목. 같은 파일은 바뀌지 않으면 다시 읽지 않는다.
const titleMemo = new Map<string, string>()
async function claudeTitles($: EngineInterface, files: { path: string; mtime: number; id: string }[]) {
  if (titleMemo.size > 2000) titleMemo.clear()
  const todo = files.filter(f => !titleMemo.has(`${f.path}@${f.mtime}`))
  if (!todo.length) return
  // grep은 처음 일치에서 멈추므로 큰 대화 파일도 부담이 작다. 사용자가 정한 이름을 먼저 쓴다.
  const grep = (key: string) => $.process.run(['grep', '-H', '-m1', '-o', '-E', TITLE_PATTERN(key), ...todo.map(f => f.path)], { timeoutMs: 20_000 }).then(r => parseTitles(r.stdout), () => ({}) as Record<string, string>)
  const [custom, ai] = [await grep('customTitle'), await grep('aiTitle')]
  for (const f of todo) titleMemo.set(`${f.path}@${f.mtime}`, custom[f.path] ?? ai[f.path] ?? shortId(f.id))
}

let codexIndex: Record<string, string> | undefined
let codexNames: { mtime: number; names: Record<string, string> } = { mtime: -1, names: {} }

async function codexPast($: EngineInterface, dirs: string[], skip: Set<string>): Promise<Record<string, Past[]>> {
  const h = await homeDir($)
  const found = await $.process.run(['find', `${h}/.codex/sessions`, '-name', 'rollout-*.jsonl', '-printf', '%T@ %p\\n'], { timeoutMs: 20_000 }).catch(() => undefined)
  if (!found) return {}
  const files = found.stdout.split('\n').flatMap(l => {
    const i = l.indexOf(' ')
    return i > 0 ? [{ path: l.slice(i + 1), mtime: Math.round(Number(l.slice(0, i)) * 1000) }] : []
  })
  codexIndex ??= ((await $.store.get(CODEX_CWD).catch(() => undefined)) as Record<string, string> | undefined) ?? {}
  // 파일 앞부분의 작업 폴더는 바뀌지 않으므로 새 파일만 읽는다
  const next: Record<string, string> = {}
  let changed = Object.keys(codexIndex).length !== files.length
  for (const f of files) {
    const known = codexIndex[f.path]
    if (known !== undefined) next[f.path] = known
    else {
      const cwd = await $.fs.read(f.path, { length: 2048 }).then(codexCwd, () => undefined)
      if (cwd) next[f.path] = cwd
      changed = true
    }
  }
  codexIndex = next
  if (changed) await $.store.set(CODEX_CWD, next).catch(() => {})
  const stat = await $.fs.stat(`${h}/.codex/session_index.jsonl`).catch(() => undefined)
  if (stat && stat.mtimeMs !== codexNames.mtime) codexNames = { mtime: stat.mtimeMs, names: await $.fs.read(`${h}/.codex/session_index.jsonl`).then(parseCodexIndex, () => ({})) }
  const out: Record<string, Past[]> = {}
  for (const f of files) {
    const cwd = next[f.path]
    const id = codexIdOf(f.path)
    if (!cwd || !id || skip.has(id) || !dirs.includes(cwd)) continue
    ;(out[cwd] ??= []).push({ agent: 'codex', id, cwd, title: codexNames.names[id] ?? shortId(id), mtime: f.mtime })
  }
  return out
}

// 보이는 폴더(맨 위와 펼친 폴더)의 끝난 대화. 제목은 화면에 나오는 대화에서만 읽는다.
async function readPast($: EngineInterface, v: View, live: Live[]): Promise<Record<string, Past[]>> {
  const h = await homeDir($)
  const dirs = [...new Set([v.top, ...v.open])]
  const skip = new Set(live.flatMap(l => (l.id ? [l.id] : [])))
  const out: Record<string, Past[]> = {}
  for (const dir of dirs) {
    const files = (await $.fs.list(`${h}/.claude/projects/${slug(dir)}`).catch(() => []))
      .filter(e => e.kind === 'file' && e.name.endsWith('.jsonl'))
      .map(e => ({ path: `${h}/.claude/projects/${slug(dir)}/${e.name}`, id: e.name.slice(0, -6), mtime: e.mtimeMs }))
      .filter(f => !skip.has(f.id))
      .sort((a, b) => b.mtime - a.mtime)
    await claudeTitles($, v.more.includes(dir) ? files : files.slice(0, SHOWN))
    out[dir] = files.map(f => ({ agent: 'claude' as const, id: f.id, cwd: dir, title: titleMemo.get(`${f.path}@${f.mtime}`) ?? shortId(f.id), mtime: f.mtime }))
  }
  const codex = await codexPast($, dirs, skip).catch(() => ({}) as Record<string, Past[]>)
  for (const [dir, list] of Object.entries(codex)) out[dir] = [...(out[dir] ?? []), ...list]
  for (const list of Object.values(out)) list.sort((a, b) => b.mtime - a.mtime)
  return out
}

// ---- 갱신 ----

// 갱신이 겹치면 하나로 합친다. 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽는다.
let busy = false
let again = false
let wantPast = false
async function refresh($: EngineInterface, withPast = true) {
  wantPast ||= withPast
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      const past = wantPast
      wantPast = false
      let v = await read($, view)
      // 처음 열었거나 메인 세션의 프로젝트 폴더가 /cd로 바뀌었으면 트리의 맨 위를 새 폴더로 옮긴다
      const root = await $.session.root().catch(() => '')
      // 처음 읽을 때(lastRoot가 빔)는 이미 있는 맨 위 폴더를 그대로 둔다. 플러그인을 다시 불러온 뒤에도 탐색 위치가 유지된다.
      if (root && (!v.top || (lastRoot && root !== lastRoot))) {
        lastRoot = root
        v = { ...EMPTY_VIEW, ...(v.top && { hidden: v.hidden }), top: root }
        await update($, view, () => v)
      }
      if (!v.top) continue
      lastRoot ||= root
      const top = await existingTop($, v.top)
      if (top !== v.top) {
        v = { ...v, top, open: v.open.filter(p => p.startsWith(`${top}/`)), cur: '' }
        await update($, view, () => v)
      }
      const now = await $.clock.now()
      const prev = await read($, data)
      const live = (await readLive($)) ?? prev.live
      const dirs = [...new Set([v.top, ...v.open])]
      const lists: Data['lists'] = {}
      await Promise.all(dirs.map(async d => void (lists[d] = await listDir($, d))))
      const git = await gitMarks($, v, now).catch(() => prev.git)
      const pastNow = past ? await readPast($, v, live).catch(() => prev.past) : Object.fromEntries(dirs.map(d => [d, prev.past[d] ?? []]))
      await update($, data, () => ({ live, past: pastNow, lists, git }))
      lastFast = now
      if (past) lastPast = now
    } while (again)
  } finally {
    busy = false
  }
}

const isShown = async ($: EngineInterface) => (await $.ui.panes()).find(p => p.id === PANE)?.isShown === true

// 1초마다 깨어나 패널이 보일 때만 주기가 된 조회를 한다
async function tick($: EngineInterface) {
  if (!(await isShown($))) return
  const now = await $.clock.now()
  const root = await $.session.root().catch(() => '')
  if (now - lastFast >= FAST_MS - 100 || (root && lastRoot && root !== lastRoot)) await refresh($, now - lastPast >= PAST_MS - 100)
}

const open = ($: EngineInterface, focus?: true) => $.ui.open({ id: PANE, title: '탐색기', ...(focus && { focus }) })

// 클릭으로도 패널에 키보드가 들어오게 한다. 입력창이 비어 있을 때만 받아들여지는 요청이다.
async function focusPane($: EngineInterface) {
  await open($, true)
}

// ---- 동작 ----

async function perform($: EngineInterface, steps: string[][] | { error: string }) {
  if (!Array.isArray(steps)) return void $.ui.toast(steps.error)
  for (const argv of steps) {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode !== 0) return void $.ui.toast(r.stderr.trim().split('\n')[0] || `${argv[0]} 명령이 실패했습니다`)
  }
}

// 커서 줄이 가리키는 폴더. 새 탭을 열 폴더다.
function folderOf(key: string, v: View, d: Data): string {
  const path = key.slice(2)
  if (key.startsWith('d:') || key.startsWith('m:')) return path
  if (key.startsWith('f:')) return parentOf(path)
  if (key.startsWith('l:')) return d.live.find(l => `l:${l.pid}` === key)?.cwd ?? v.top
  if (key.startsWith('p:')) return Object.values(d.past).flat().find(p => `p:${p.agent}:${p.id}` === key)?.cwd ?? v.top
  if (key.startsWith('n:')) return path.slice(0, path.lastIndexOf(':'))
  return key === 'u:' ? parentOf(v.top) : v.top
}

// 줄의 기본 동작(Enter, 더블클릭)
async function openRow($: EngineInterface, key: string, v: View, d: Data) {
  const here = hereOf(d.live.find(l => l.self)?.mux)
  if (key.startsWith('f:')) {
    const cwd = await $.session.cwd().catch(() => v.top)
    const filled = await $.prompt.fill({ text: `@${relTo(cwd, key.slice(2))} `, mode: 'insert' })
    return void $.ui.toast(filled.isFilled ? '입력창에 넣었습니다. Esc로 입력창에 돌아가 보내세요' : '입력창에 넣지 못했습니다')
  }
  if (key.startsWith('l:')) {
    const live = d.live.find(l => `l:${l.pid}` === key)
    if (!live || live.self) return
    if (!live.mux) return void $.ui.toast(`zellij나 tmux 밖에서 실행 중입니다: ${live.cwd} (pid ${live.pid})`)
    let tab: number | undefined
    if (live.mux.kind === 'zellij') {
      const r = await $.process.run(['zellij', '--session', live.mux.session, 'action', 'list-panes', '-t', '-j'], { timeoutMs: 10_000 }).catch(() => undefined)
      tab = r?.exitCode === 0 ? zellijTabOf(r.stdout, live.mux.pane) : undefined
    }
    return perform($, focusSteps(live.mux, here, tab))
  }
  if (key.startsWith('p:')) {
    const past = Object.values(d.past).flat().find(p => `p:${p.agent}:${p.id}` === key)
    if (past) return perform($, newTabSteps(here, past.cwd, baseName(past.cwd), resumeArgv(past.agent, past.id)))
  }
}

// Client의 메시지와 아래 단축키 버튼이 함께 쓴다
async function dispatch($: EngineInterface, msg: Msg) {
  const [v, d] = await Promise.all([read($, view), read($, data)])
  if (msg.act === 'tab') {
    const dir = folderOf(msg.key, v, d)
    return perform($, newTabSteps(hereOf(d.live.find(l => l.self)?.mux), dir, baseName(dir), launchArgv(msg.kind)))
  }
  const next = step(v, msg, d.live)
  if (next) {
    await update($, view, () => next)
    // 보이는 폴더가 바뀌었으면 목록과 끝난 대화를 바로 읽는다
    if (msg.act !== 'move' && msg.act !== 'hidden') void refresh($).catch(() => {})
    return
  }
  if (msg.act === 'open') await openRow($, msg.key, v, d)
}

// Client가 보낸 값은 입력이므로 모양을 확인한다
function parseMsg(x: unknown): Msg | undefined {
  const m = x as { act?: unknown; key?: unknown; kind?: unknown } | null
  const key = typeof m?.key === 'string'
  switch (m?.act) {
    case 'move': case 'open': case 'expand': case 'collapse': return key ? (m as Msg) : undefined
    case 'tab': return key && (m.kind === 't' || m.kind === 'c' || m.kind === 'x') ? (m as Msg) : undefined
    case 'up': case 'next': case 'hidden': return m as Msg
    default: return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'session-explorer', description: '파일 트리와 세션 탐색기 패널 열기' })
    await homeDir($)
    lastFast = lastPast = 0
    if ((await $.store.get(CLOSED).catch(() => undefined)) !== true) void open($).catch(() => {})
    void refresh($).catch(() => {})
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($).catch(() => {}))
    // 새 버전은 세션을 시작할 때와 6시간마다 확인한다. 끝을 기다리지 않는다.
    await readVersion($)
    void checkUpgrade($).catch(() => {})
    upgradeTicker?.cancel()
    upgradeTicker = $.clock.every(6 * 3600_000, () => void checkUpgrade($).catch(() => {}))
    return started
  })

  on('command.run', { command: 'session-explorer' }, async $ => {
    await $.store.set(CLOSED, false).catch(() => {})
    void refresh($).catch(() => {})
    await open($, true)
    return { text: '탐색기 패널을 열었습니다. 트리를 한 번 클릭하면 방향키와 Enter를 쓸 수 있고, Esc로 입력창에 돌아옵니다.' }
  })

  // 사람이 직접 닫으면 다음 세션에는 열지 않는다
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set(CLOSED, true).catch(() => {})
    return next(e)
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const msg = parseMsg(e.data)
    if (msg) await dispatch($, msg).catch(() => {})
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Client는 터미널과 데스크톱 화면에만 있다
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Client } = $.ui.resolve(e)
    const [v, d, upLabel] = await Promise.all([read($, view), read($, data), upgradeLabel($)])
    await homeDir($)
    const cols = Math.max(20, e.props.bodyColumns - 1)
    const total = Math.max(5, e.props.scroll.bodyRows)
    const outside = outsideCount(v.top, d.live)
    const right = outside > 0 ? `트리 밖 세션 ${outside}` : ''
    const title = clip(v.top ? fold(v.top, home) : '불러오는 중', Math.max(5, cols - (right ? width(right) + 1 : 0)))
    const act = (hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} hotkey={hotkey} onPress={() => void focusPane($).catch(() => {}).then(() => onPress())}>
        <Text color="suggestion" weight="bold">{hotkey}</Text>
        <Text>{` ${label}`}</Text>
      </Button>
    )
    // 단축키는 커서 줄에 대해 동작한다
    const onCursor = (kind: 't' | 'c' | 'x') => () => dispatch($, { act: 'tab', kind, key: v.cur || 'd:' + v.top }).catch(() => {})
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text weight="bold">{title}</Text>
          {right && <Text color="cyan">{right}</Text>}
        </Box>
        <Client key="tree" module="./list.tsx" props={{ rows: buildRows(v, d, home), cur: v.cur }} width={cols} height={Math.max(3, total - 3)} />
        <Text dimColor>{'─'.repeat(cols)}</Text>
        <Box flexDirection="row">
          {act('h', '위로', () => dispatch($, { act: 'up' }).catch(() => {}))}<Text> </Text>
          {act('s', '세션', () => dispatch($, { act: 'next' }).catch(() => {}))}<Text> </Text>
          {act('t', '셸', onCursor('t'))}<Text> </Text>
          {act('c', 'Claude', onCursor('c'))}<Text> </Text>
          {act('x', 'Codex', onCursor('x'))}
          {upLabel && (
            <Box flexDirection="row">
              <Text> </Text>
              <Button key="act:u" plain hotkey="u" onPress={() => void applyUpgrade($).catch(() => {})}>
                <Text color="cyan">{upLabel}</Text>
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}

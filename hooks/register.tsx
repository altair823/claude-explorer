import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Data, Entry, Live, Past, View } from '../types'
import type { Here } from './mux'
import { focusSteps, hereOf, launchArgv, newTabSteps, resumeArgv, zellijTabOf } from './mux'
import { PROBE, codexCwd, codexIdOf, liveSessions, parseCodexIndex, parseProbe, parseRegistry, parseTitles, slug } from './sessions'
import type { Reg } from './sessions'
import { clip, width } from './text'
import { PAST_SHOWN, buildRows, fitRow, fold, join, outsideCount, parentOf, parseStatus, pressKind, scrolled, step, stepped, windowStart } from './tree'
import type { Msg, Row, Seg } from './tree'
import { QUIET, applyUpgrade, checkUpgrade, readVersion, upgradeLabel } from './upgrade'

const PANE = 'explorer'
const EMPTY_VIEW: View = { top: '', open: [], cur: '', more: [], hidden: false, start: 0 }
const EMPTY_DATA: Data = { live: [], past: {}, lists: {}, git: {} }
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const view = atom({ plugin: 'explorer', key: 'view' } as const, EMPTY_VIEW, { shape: 'view-2' })
const data = atom({ plugin: 'explorer', key: 'data' } as const, EMPTY_DATA, { shape: 'data-1' })

// 사람이 패널을 직접 닫았는지, Codex 대화 파일별 작업 폴더 색인($.store)
const CLOSED = 'closed'
const CODEX_CWD = 'codex-cwd'
// 주기(ms). 세션 목록, 파일 목록, git 상태는 3초, 끝난 대화는 30초. 느린 저장소의 git 상태도 30초.
const FAST_MS = 3000
const PAST_MS = 30_000
const SLOW_GIT_MS = 30_000
const GIT_SLOW = 1000
const TITLE_PATTERN = (key: string) => `"${key}":"(\\\\.|[^"\\\\])*"`

let home = ''
let ticker: { cancel: () => void } | undefined
let upgradeTicker: { cancel: () => void } | undefined
let lastFast = 0
let lastPast = 0
let lastRoot = ''

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || '/'
// @경로: 공백이 있으면 따옴표로 감싼다
const mention = (from: string, to: string) => {
  const p = to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to
  return /\s/.test(p) ? `@"${p}"` : `@${p}`
}

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

// 폴더 먼저, 이름순으로 정렬해 저장한다. 그리는 쪽은 다시 정렬하지 않는다.
async function listDir($: EngineInterface, dir: string): Promise<Entry[] | { error: string }> {
  try {
    const found = await Promise.all(
      (await $.fs.list(dir)).map(async (e): Promise<Entry | undefined> => {
        if (e.kind !== 'other') return { name: e.name, dir: e.kind === 'dir' }
        if (!e.isLink) return undefined
        // 링크는 가리키는 대상으로 판단한다. 끊어진 링크는 뺀다.
        const st = await $.fs.stat(join(dir, e.name)).catch(() => undefined)
        return st && { name: e.name, dir: st.kind === 'dir' }
      }),
    )
    return found.filter((e): e is Entry => !!e).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
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
      // 실패와 타임아웃은 표시 없이 넘어가고(지난 표시를 그대로 둔다) 느린 저장소처럼 30초 뒤에 다시 읽는다
      gitMemo.set(root, r?.exitCode === 0 ? { marks: parseStatus(r.stdout, root), at: now, slow: done - now > GIT_SLOW } : { marks: memo?.marks ?? {}, at: now, slow: true })
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
  // 실패나 타임아웃이면 undefined를 돌려주고, 그때는 캐시에 저장하지 않아 다음에 다시 읽는다.
  const grep = (key: string) =>
    $.process.run(['grep', '-H', '-m1', '-o', '-E', TITLE_PATTERN(key), ...todo.map(f => f.path)], { timeoutMs: 20_000 }).then(
      r => (r.exitCode === 0 || r.exitCode === 1 ? parseTitles(r.stdout) : undefined),
      () => undefined,
    )
  const [custom, ai] = [await grep('customTitle'), await grep('aiTitle')]
  if (!custom || !ai) return
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
      // 읽지 못했거나 작업 폴더가 없는 파일은 빈 문자열로 표시해 한 번만 읽는다
      next[f.path] = (await $.fs.read(f.path, { length: 2048 }).then(codexCwd, () => undefined)) ?? ''
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
    await claudeTitles($, v.more.includes(dir) ? files : files.slice(0, PAST_SHOWN))
    out[dir] = files.map(f => ({ agent: 'claude' as const, id: f.id, cwd: dir, title: titleMemo.get(`${f.path}@${f.mtime}`) ?? shortId(f.id), mtime: f.mtime }))
  }
  const codex = await codexPast($, dirs, skip).catch(() => ({}) as Record<string, Past[]>)
  for (const [dir, list] of Object.entries(codex)) out[dir] = [...(out[dir] ?? []), ...list]
  for (const list of Object.values(out)) list.sort((a, b) => b.mtime - a.mtime)
  return out
}

// ---- 갱신 ----

// 갱신이 겹치면 하나로 합친다. 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽는다.
let running: Promise<void> | undefined
let again = false
let wantPast = false
// 끝나면 풀리는 약속을 돌려준다. 이미 도는 중이면 그 갱신이 끝난 뒤 한 번 더 읽고, 같은 약속을 돌려준다.
function refresh($: EngineInterface, withPast = true): Promise<void> {
  wantPast ||= withPast
  if (running) {
    again = true
    return running
  }
  running = (async () => {
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
          // 링크가 풀린 경로로 맞춘다. /proc의 cwd와 git이 돌려주는 경로가 그 값이다.
          const real = await $.fs.stat(root, { resolve: true }).then(st => st.realPath ?? root, () => root)
          v = { ...EMPTY_VIEW, ...(v.top && { hidden: v.hidden }), top: real }
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
      running = undefined
    }
  })()
  return running
}

const isShown = async ($: EngineInterface) => (await $.ui.panes()).find(p => p.id === PANE)?.isShown === true

// 1초마다 깨어나 패널이 보일 때만 주기가 된 조회를 한다
async function tick($: EngineInterface) {
  // 갱신이 도는 중이면 겹쳐 요청하지 않는다. 겹친 요청(again)은 사용자 동작만 쓴다.
  if (running || !(await isShown($))) return
  const now = await $.clock.now()
  const root = await $.session.root().catch(() => '')
  if (now - lastFast >= FAST_MS - 100 || (root && lastRoot && root !== lastRoot)) await refresh($, now - lastPast >= PAST_MS - 100)
}

const open = ($: EngineInterface, focus?: true) => $.ui.open({ id: PANE, title: '탐색기', ...(focus && { focus }) })

// 행동 뒤에도 키보드가 패널에 남도록 패널과 커서 줄에 초점을 다시 준다. 입력창이 비어 있을 때만 받아들여지는 요청이다.
async function focusPane($: EngineInterface, key?: string) {
  await open($, true)
  if (key) await $.ui.focus({ requestId: PANE, key }).catch(() => {})
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

// 이 Claude 세션이 있는 multiplexer. tmux면 창이 속한 세션 id도 물어서 명령에 명시한다(환경 상속에 기대지 않는다).
async function hereNow($: EngineInterface, d: Data): Promise<Here> {
  const mux = d.live.find(l => l.self)?.mux
  const here = hereOf(mux)
  if (mux?.kind === 'tmux' && here?.kind === 'tmux') {
    const r = await $.process.run(['tmux', '-S', mux.socket, 'display-message', '-p', '-t', mux.pane, '#{session_id}'], { timeoutMs: 5000 }).catch(() => undefined)
    const session = r?.exitCode === 0 ? r.stdout.trim() : ''
    if (session) here.session = session
  }
  return here
}

// 줄의 기본 동작(Enter, 더블클릭)
async function openRow($: EngineInterface, key: string, v: View, d: Data) {
  const here = await hereNow($, d)
  if (key.startsWith('f:')) {
    const cwd = await $.session.cwd().catch(() => v.top)
    const filled = await $.prompt.fill({ text: `${mention(cwd, key.slice(2))} `, mode: 'insert' })
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

// 트리 창에 보이는 줄 수. 그릴 때마다 정해지고, 방향키로 창 끝을 넘을 때 쓴다.
let lastRows = 20
// 사람이 커서를 이 줄로 옮긴 시각과 직전 줄 누름. 클릭 한 번이 선택인지 열기인지 가린다.
let focusedAt = 0
let lastPress: { key: string; t: number } | undefined

// 커서를 key 줄로 두고, 그 줄이 보이도록 창을 맞춘다
async function setCursor($: EngineInterface, key: string) {
  const [v, d] = await Promise.all([read($, view), read($, data)])
  const start = windowStart(buildRows(v, d, home), { cur: key, start: v.start }, lastRows)
  await update($, view, x => ({ ...x, cur: key, start }))
}

// 줄 버튼과 단축키 버튼이 함께 쓰는 동작
async function act($: EngineInterface, msg: Msg) {
  const [v, d] = await Promise.all([read($, view), read($, data)])
  if (msg.act === 'tab') {
    const dir = folderOf(msg.key, v, d)
    await perform($, newTabSteps(await hereNow($, d), dir, baseName(dir), launchArgv(msg.kind)))
    return focusPane($, v.cur && `r:${v.cur}`)
  }
  const next = step(v, msg, d.live)
  if (next) {
    await update($, view, () => next)
    // 보이는 폴더가 바뀌었으면 목록과 끝난 대화를 읽은 뒤에 커서를 맞춘다(커서 줄이 아직 없으면 초점을 줄 수 없다)
    if (next.top !== v.top || next.open.length > v.open.length || next.more.length !== v.more.length) await refresh($).catch(() => {})
    const [v2, d2] = await Promise.all([read($, view), read($, data)])
    const rows = buildRows(v2, d2, home)
    const cur = rows.some(r => r.key === v2.cur) ? v2.cur : (rows[0]?.key ?? '')
    if (cur !== v2.cur || windowStart(rows, v2, lastRows) !== v2.start) await update($, view, x => ({ ...x, cur, start: windowStart(rows, { cur, start: x.start }, lastRows) }))
    return focusPane($, cur && `r:${cur}`)
  }
  if (msg.act === 'open') await openRow($, msg.key, v, d)
  return focusPane($, v.cur && `r:${v.cur}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'explorer', description: '파일 트리와 세션 탐색기 패널 열기' })
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

  on('command.run', { command: 'explorer' }, async $ => {
    await $.store.set(CLOSED, false).catch(() => {})
    void refresh($).catch(() => {})
    await open($, true)
    return { text: '탐색기 패널을 열었습니다. 방향키로 줄을 옮기고 Enter로 열고, Esc로 입력창에 돌아옵니다.' }
  })

  // 사람이 직접 닫으면 다음 세션에는 열지 않는다
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.set(CLOSED, true).catch(() => {})
    return next(e)
  })

  // 방향키나 클릭으로 커서가 움직이면 기록한다. 창 끝에서 더 나가려 하면 창을 한 줄 옮긴다.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const el = e.element
    const person = e.origin.kind === 'person'
    // 방향키와 Tab이 아래 단축키 버튼으로 넘어가지 않게 한다. 단축키는 글자 키나 클릭으로 누른다.
    if (el?.startsWith('act:') && person) return {}
    // 창 위아래 경계 줄로 가려는 이동은 막고, 그 방향에 줄이 더 있으면 창을 한 줄 옮긴다.
    if (el?.startsWith('edge:')) {
      if (person) {
        const [v, d] = await Promise.all([read($, view), read($, data)])
        const w = stepped(buildRows(v, d, home), v, lastRows, el === 'edge:bottom' ? 1 : -1)
        if (w) {
          await update($, view, x => ({ ...x, ...w }))
          void $.ui.focus({ requestId: PANE, key: `r:${w.cur}` }).catch(() => {})
        }
      }
      return {}
    }
    const done = await next(e)
    // 사람이 옮긴 것만 기록한다. 다시 그린 뒤 엔진이 첫 줄에 초점을 되돌리는 알림이 방금 고른 커서를 덮지 않게 한다.
    if (person && el?.startsWith('r:')) {
      focusedAt = await $.clock.now()
      await setCursor($, el.slice(2))
    }
    return done
  })

  // 마우스 휠. 패널은 보이는 줄만 그려서 엔진이 옮길 내용이 없으므로, 창을 직접 옮기고 엔진의 이동은 막는다.
  // 휠이 아닌 스크롤 키(pointer 없음)는 엔진에 맡긴다. 키보드 초점은 옮기지 않는다.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!e.pointer) return next(e)
    const [v, d] = await Promise.all([read($, view), read($, data)])
    const w = scrolled(buildRows(v, d, home), v, lastRows, e.by)
    if (!w) return {}
    await update($, view, x => ({ ...x, ...w }))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [v, d, upLabel] = await Promise.all([read($, view), read($, data), upgradeLabel($)])
    await homeDir($)
    // 마지막 칸에 글자를 쓰면 줄이 넘어갈 수 있어 한 칸 남긴다.
    const cols = Math.max(20, e.props.bodyColumns - 1)
    const total = Math.max(6, e.props.scroll.bodyRows)
    // 머리 1줄, 창 위아래 경계 줄 2줄, 구분선 1줄, 단축키 2줄(좁으면 줄이 바뀐다)
    lastRows = Math.max(1, total - 6)
    const rows = buildRows(v, d, home)
    const start = windowStart(rows, v, lastRows)
    const shown = rows.slice(start, start + lastRows)
    const below = Math.max(0, rows.length - start - lastRows)
    const outside = outsideCount(v.top, d.live)
    const right = outside > 0 ? `트리 밖 세션 ${outside}` : ''
    const title = clip(v.top ? fold(v.top, home) : '불러오는 중', Math.max(5, cols - (right ? width(right) + 1 : 0)))
    const ring = shown.some(r => r.key === v.cur) ? v.cur : shown[0]?.key

    const press = async (row: Row) => {
      const [now, cur] = await Promise.all([$.clock.now(), read($, view)])
      const kind = pressKind({ cur: cur.cur, focusedAt, ...(lastPress && { lastPress }) }, row.key, now)
      lastPress = { key: row.key, t: now }
      if (kind === 'open') return act($, { act: 'open', key: row.key })
      await setCursor($, row.key)
      await focusPane($, `r:${row.key}`)
    }
    const scroll = async (dir: 1 | -1) => {
      const [vv, dd] = await Promise.all([read($, view), read($, data)])
      const w = scrolled(buildRows(vv, dd, home), vv, lastRows, dir * Math.max(1, lastRows - 1))
      if (w) await update($, view, x => ({ ...x, ...w }))
      await focusPane($, `r:${w?.cur ?? vv.cur}`)
    }
    const edge = (key: string, label: string, dir: 1 | -1) => (
      <Button key={key} plain onPress={() => void scroll(dir).catch(() => {})}>
        <Text dimColor>{label || ' '}</Text>
      </Button>
    )
    const seg = (s: Seg, isCur: boolean) => <Text color={s.color} dimColor={s.dim && !isCur} backgroundColor={isCur ? 'subtle' : undefined}>{s.t}</Text>
    const act1 = (hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} hotkey={hotkey} onPress={() => void focusPane($).catch(() => {}).then(() => onPress())}>
        <Text color="suggestion" weight="bold">{hotkey}</Text>
        <Text>{` ${label}`}</Text>
      </Button>
    )
    // 단축키는 커서 줄에 대해 동작한다
    const onCursor = async (m: (key: string) => Msg) => {
      const vv = await read($, view)
      await act($, m(vv.cur || `d:${vv.top}`))
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text weight="bold">{title}</Text>
          {right && <Text color="cyan">{right}</Text>}
        </Box>
        {edge('edge:top', start ? `▲ 위로 ${start}줄` : '', -1)}
        {shown.map(row => (
          <Button key={`r:${row.key}`} plain autoFocus={row.key === ring || undefined} onPress={() => void press(row).catch(() => {})}>
            {fitRow(row, cols).map(s => seg(s, row.key === v.cur))}
          </Button>
        ))}
        {Array.from({ length: Math.max(0, lastRows - shown.length) }, () => <Text> </Text>)}
        {edge('edge:bottom', below ? `▼ 아래로 ${below}줄` : '', 1)}
        <Text dimColor>{'─'.repeat(cols)}</Text>
        <Box flexDirection="row" flexWrap="wrap" width={cols}>
          {act1('h', '위로', () => act($, { act: 'up' }))}<Text> </Text>
          {act1('l', '펼치기', () => onCursor(key => ((buildRows(v, d, home).find(r => r.key === key)?.open ? { act: 'collapse', key } : { act: 'expand', key }) as Msg)))}<Text> </Text>
          {act1('s', '세션', () => act($, { act: 'next' }))}<Text> </Text>
          {act1('t', '셸', () => onCursor(key => ({ act: 'tab', kind: 't', key })))}<Text> </Text>
          {act1('c', 'Claude', () => onCursor(key => ({ act: 'tab', kind: 'c', key })))}<Text> </Text>
          {act1('x', 'Codex', () => onCursor(key => ({ act: 'tab', kind: 'x', key })))}<Text> </Text>
          {act1('a', '숨김', () => act($, { act: 'hidden' }))}
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

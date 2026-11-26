import type { EngineInterface } from 'claude-code'

import type { Entry, Live, Past, View } from '../types'
import { PROBE, codexCwd, codexIdOf, liveSessions, parseCodexIndex, parseProbe, parseRegistry, parseTitles, slug } from './sessions'
import type { Reg } from './sessions'
import { PAST_SHOWN, join, parentOf, parseStatus } from './tree'
import { QUIET } from './upgrade'

// 화면에 보이는 폴더와 세션을 읽는 함수 모음. 읽은 결과를 저장하는 일은 register.tsx가 한다.

// Codex 대화 파일별 작업 폴더 색인을 담는 $.store 키
const CODEX_CWD = 'codex-cwd'
// 갱신 주기(ms). 세션 목록, 파일 목록, git 상태는 3초, 느린 저장소의 git 상태는 30초.
export const FAST_MS = 3000
const SLOW_GIT_MS = 30_000
const GIT_SLOW = 1000
const TITLE_PATTERN = (key: string) => `"${key}":"(\\\\.|[^"\\\\])*"`

// register.tsx가 경로를 줄여 보일 때 쓰므로 내보낸다. homeDir를 부른 뒤에 값이 채워진다.
export let home = ''

export async function homeDir($: EngineInterface): Promise<string> {
  if (!home) home = (await $.env.get('HOME').catch(() => undefined)) || ''
  return home
}

// ---- 조회 ----

// 실행 중인 Claude와 Codex 세션. 조회에 실패하면 undefined로 지난 값을 둔다.
export async function readLive($: EngineInterface): Promise<Live[] | undefined> {
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
export async function listDir($: EngineInterface, dir: string): Promise<Entry[] | { error: string }> {
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
export async function existingTop($: EngineInterface, top: string): Promise<string> {
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
export async function gitMarks($: EngineInterface, v: View, now: number): Promise<Record<string, string>> {
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
      // 종료 코드 2는 파일 일부를 읽지 못했다는 뜻이다. 일치한 출력이 있으면 그 제목은 저장한다.
      r => (r.exitCode === 0 || r.exitCode === 1 || (r.exitCode === 2 && r.stdout) ? parseTitles(r.stdout) : undefined),
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
export async function readPast($: EngineInterface, v: View, live: Live[]): Promise<Record<string, Past[]>> {
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

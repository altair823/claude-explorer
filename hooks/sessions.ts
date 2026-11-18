import type { Agent, Live, Mux } from '../types'

// /proc에서 claude와 codex 프로세스를 한 번에 조회하는 POSIX sh 스크립트.
// 필드는 탭으로 구분한다: pid, comm, start, cwd, fd0, cmd, ZELLIJ_SESSION_NAME, ZELLIJ_PANE_ID, TMUX, TMUX_PANE, rollout
// environ을 읽을 수 없는 프로세스(다른 사용자)는 줄을 내지 않는다.
export const PROBE = String.raw`
for d in /proc/[0-9]*; do
  pid=\${d#/proc/}
  comm=$(cat "$d/comm" 2>/dev/null) || continue
  case "$comm" in claude|codex) ;; *) continue ;; esac
  stat=$(cat "$d/stat" 2>/dev/null) || continue
  # comm에 공백이나 괄호가 있을 수 있어 마지막 ")" 뒤에서 센다. 그 뒤 첫 값이 3번째 필드이므로 22번째는 20번째다.
  rest=\${stat##*) }
  start=$(printf '%s\n' "$rest" | cut -d' ' -f20)
  [ -r "$d/environ" ] || continue
  env=$(tr '\0' '\n' 2>/dev/null < "$d/environ" | awk '
    function v(s) { return substr($0, length(s) + 2) }
    index($0, "ZELLIJ_SESSION_NAME=") == 1 { a = v("ZELLIJ_SESSION_NAME") }
    index($0, "ZELLIJ_PANE_ID=") == 1 { b = v("ZELLIJ_PANE_ID") }
    index($0, "TMUX=") == 1 { c = v("TMUX") }
    index($0, "TMUX_PANE=") == 1 { e = v("TMUX_PANE") }
    END { printf "%s\t%s\t%s\t%s", a, b, c, e }')
  cwd=$(readlink "$d/cwd" 2>/dev/null)
  fd0=$(readlink "$d/fd/0" 2>/dev/null)
  cmd=$(tr '\0\t\n' '   ' 2>/dev/null < "$d/cmdline" | cut -c1-200)
  rollout=
  for f in "$d"/fd/*; do
    t=$(readlink "$f" 2>/dev/null)
    case "$t" in */rollout-*.jsonl) rollout=$t; break ;; esac
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$comm" "$start" "$cwd" "$fd0" "$cmd" "$env" "$rollout"
done
`.replace(/\\\$/g, '$')

export type Proc = {
  pid: number
  comm: string
  start: string
  cwd: string
  fd0: string
  cmd: string
  env: { zellijSession?: string; zellijPane?: string; tmux?: string; tmuxPane?: string }
  rollout?: string
}

export function parseProbe(out: string): Proc[] {
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const f = line.split('\t')
    const pid = Number(f[0])
    if (f.length < 10 || !Number.isInteger(pid)) continue
    const env: Proc['env'] = {}
    if (f[6]) env.zellijSession = f[6]
    if (f[7]) env.zellijPane = f[7]
    if (f[8]) env.tmux = f[8]
    if (f[9]) env.tmuxPane = f[9]
    procs.push({ pid, comm: f[1]!, start: f[2]!, cwd: f[3]!, fd0: f[4]!, cmd: f[5]!, env, ...(f[10] && { rollout: f[10] }) })
  }
  return procs
}

export function muxOf(env: Proc['env']): Mux | undefined {
  const pane = Number(env.zellijPane)
  if (env.zellijSession && env.zellijPane && Number.isInteger(pane)) return { kind: 'zellij', session: env.zellijSession, pane }
  if (env.tmux && env.tmuxPane) return { kind: 'tmux', socket: env.tmux.split(',')[0]!, pane: env.tmuxPane }
  return undefined
}

export type Reg = { pid: number; sessionId: string; cwd: string; status: string; name: string; procStart: string }

// 쓰는 도중이라 깨졌거나 세션 기록이 아닌 JSON이면 undefined
export function parseRegistry(text: string): Reg | undefined {
  try {
    const j = JSON.parse(text)
    if (typeof j?.pid !== 'number' || typeof j.cwd !== 'string') return undefined
    const s = (v: unknown) => (typeof v === 'string' ? v : '')
    return { pid: j.pid, sessionId: s(j.sessionId), cwd: j.cwd, status: s(j.status), name: s(j.name), procStart: s(j.procStart) }
  } catch {
    return undefined
  }
}

export function codexIdOf(path: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path)?.[1]
}

export function liveSessions(regs: Reg[], procs: Proc[], selfId: string): Live[] {
  const out: Live[] = []
  const byPid = new Map(procs.map(p => [p.pid, p]))
  for (const r of regs) {
    const p = byPid.get(r.pid)
    // pid가 다른 프로세스에 다시 쓰인 경우를 시작 시각으로 거른다
    if (!p || p.comm !== 'claude' || p.start !== r.procStart) continue
    const mux = muxOf(p.env)
    out.push({ agent: 'claude', pid: r.pid, cwd: r.cwd, name: r.name, state: r.status === 'busy' ? 'busy' : 'idle', id: r.sessionId, ...(mux && { mux }), ...(r.sessionId === selfId && { self: true as const }) })
  }
  for (const p of procs) {
    if (p.comm !== 'codex' || !p.fd0.startsWith('/dev/pts/') || p.cmd.includes('app-server')) continue
    const id = p.rollout && codexIdOf(p.rollout)
    const mux = muxOf(p.env)
    out.push({ agent: 'codex', pid: p.pid, cwd: p.cwd, name: 'codex', state: 'running', ...(id && { id }), ...(mux && { mux }) })
  }
  return out.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.pid - b.pid)
}

export const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

const unquote = (s: string): string | undefined => {
  try {
    return JSON.parse(s) as string
  } catch {
    return undefined
  }
}

// grep -H -m1 -o 출력 한 줄은 `<경로>:"aiTitle":"..."`. 같은 경로가 먼저 나온 것이 이긴다.
export function parseTitles(out: string): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(.*):"(?:customTitle|aiTitle)":("(?:\\.|[^"\\])*")$/.exec(line)
    const t = m && unquote(m[2]!)
    if (m && t && !(m[1]! in titles)) titles[m[1]!] = t
  }
  return titles
}

export function codexCwd(head: string): string | undefined {
  const m = /"cwd":("(?:\\.|[^"\\])*")/.exec(head)
  return m ? unquote(m[1]!) : undefined
}

// 같은 id는 뒤 줄이 이긴다. 깨진 줄은 건너뛴다.
export function parseCodexIndex(text: string): Record<string, string> {
  const names: Record<string, string> = {}
  for (const line of text.split('\n')) {
    try {
      const j = JSON.parse(line)
      if (typeof j?.id === 'string' && typeof j.thread_name === 'string') names[j.id] = j.thread_name
    } catch {}
  }
  return names
}

export type { Agent }

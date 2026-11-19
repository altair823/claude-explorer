export type Agent = 'claude' | 'codex'
// socket은 $TMUX의 첫 쉼표 앞
export type Mux =
  | { kind: 'zellij'; session: string; pane: number }
  | { kind: 'tmux'; socket: string; pane: string }
// running은 상태를 알 수 없는 Codex
export type LiveState = 'busy' | 'idle' | 'running'
export type Live = { agent: Agent; pid: number; cwd: string; name: string; state: LiveState; id?: string; mux?: Mux; self?: true }
export type Past = { agent: Agent; id: string; cwd: string; title: string; mtime: number }
export type Entry = { name: string; dir: boolean }
export type Data = {
  live: Live[]
  // 폴더 절대 경로별, 최신순, 전부
  past: Record<string, Past[]>
  // 펼친 폴더와 맨 위 폴더만
  lists: Record<string, Entry[] | { error: string }>
  // 바뀐 파일 절대 경로별 한 글자: M A D R ?
  git: Record<string, string>
}
// start: 트리 창의 첫 줄 번호
export type View = { top: string; open: string[]; cur: string; more: string[]; hidden: boolean; start: number }
// latest: 확인한 가장 높은 릴리스 버전, ready: 그 버전을 이미 받아 두었는지
export type Upgrade = { latest: string; ready: boolean }

declare module 'claude-code' {
  interface PluginState {
    'explorer': { view: Shaped<View>; data: Shaped<Data>; upgrade: Shaped<Upgrade> }
  }
}

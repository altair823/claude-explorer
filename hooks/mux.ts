import type { Agent, Mux } from '../types'

// tmux의 session은 Claude 창이 속한 세션 id(`$3`). 알 수 없으면 비어 있다.
export type Here = { kind: 'zellij'; session: string } | { kind: 'tmux'; socket: string; session?: string } | undefined
type Steps = string[][] | { error: string }

// 이 Claude 세션이 있는 multiplexer. 이 세션의 실행 중 세션 항목(self)의 mux에서 만든다.
export function hereOf(self: Mux | undefined): Here {
  if (!self) return undefined
  return self.kind === 'zellij' ? { kind: 'zellij', session: self.session } : { kind: 'tmux', socket: self.socket }
}

// `zellij action list-panes -t -j` 출력에서 터미널 창이 속한 탭 id. 플러그인 창은 id가 겹칠 수 있어 뺀다.
export function zellijTabOf(listPanesJson: string, pane: number): number | undefined {
  try {
    const list = JSON.parse(listPanesJson) as { id: number; is_plugin: boolean; tab_id: number }[]
    return list.find(p => p.id === pane && p.is_plugin === false)?.tab_id
  } catch {
    return undefined
  }
}

const where = (t: Mux) => (t.kind === 'zellij' ? `zellij 세션 ${t.session}의 창 ${t.pane}` : `tmux 창 ${t.pane}`)

export function focusSteps(target: Mux, here: Here, tab?: number): Steps {
  const at = `이 세션은 ${where(target)}에서 실행 중입니다`
  if (!here) return { error: `${at}. 이 Claude 세션이 zellij나 tmux 안에 있지 않아 이동할 수 없습니다` }
  if (target.kind === 'zellij' && here.kind === 'zellij') {
    const same = target.session === here.session
    // 환경 변수에 기대지 않도록 대상 세션을 늘 명시한다
    const pre = ['zellij', '--session', target.session, 'action']
    const steps = [...(tab === undefined ? [] : [[...pre, 'go-to-tab-by-id', String(tab)]]), [...pre, 'focus-pane-id', `terminal_${target.pane}`]]
    // 사용자가 보는 화면은 마지막 단계에서만 바뀐다
    return same ? steps : [...steps, ['zellij', 'action', 'switch-session', target.session]]
  }
  if (target.kind === 'tmux' && here.kind === 'tmux') {
    // 다른 tmux 서버의 창은 이 클라이언트를 옮길 수 없다
    if (target.socket !== here.socket) return { error: `${at}. 다른 tmux 서버라 이동할 수 없습니다` }
    const t = ['tmux', '-S', target.socket]
    return [[...t, 'select-window', '-t', target.pane], [...t, 'select-pane', '-t', target.pane], [...t, 'switch-client', '-t', target.pane]]
  }
  return { error: `${at}. 지금 쓰는 ${here.kind}와 달라 이동할 수 없습니다` }
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

// argv는 resumeArgv, launchArgv의 고정 값(명령 이름, 옵션, UUID)만 들어오므로 공백 연결로 충분하다
export function newTabSteps(here: Here, cwd: string, name: string, argv: string[]): Steps {
  if (!here) return { error: `zellij나 tmux 안이 아니라 새 탭을 열 수 없습니다. 직접 실행하세요: ${['cd', quote(cwd)].join(' ')}${argv.length ? ` && ${argv.join(' ')}` : ''}` }
  // 값이 -로 시작해도 옵션으로 읽히지 않도록 --name=값 형태로 넘긴다
  if (here.kind === 'zellij') return [['zellij', '--session', here.session, 'action', 'new-tab', `--cwd=${cwd}`, `--name=${name}`, ...(argv.length ? ['--', ...argv] : [])]]
  // tmux는 -n 값의 #을 서식으로 읽으므로 ##로 바꾼다
  return [['tmux', '-S', here.socket, 'new-window', ...(here.session ? ['-t', `${here.session}:`] : []), '-c', cwd, '-n', name.replace(/#/g, '##'), ...(argv.length ? [argv.join(' ')] : [])]]
}

export const resumeArgv = (agent: Agent, id: string): string[] => (agent === 'claude' ? ['claude', '--resume', id] : ['codex', 'resume', id])

export const launchArgv = (kind: 't' | 'c' | 'x'): string[] => (kind === 't' ? [] : kind === 'c' ? ['claude'] : ['codex'])

import type { EngineInterface } from 'claude-code'

import type { Data, View } from '../types'
import type { Here } from './mux'
import { focusSteps, hereOf, launchArgv, newTabSteps, resumeArgv, zellijTabOf } from './mux'
import { parentOf } from './tree'

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || '/'
// @경로: 공백이 있으면 따옴표로 감싼다
const mention = (from: string, to: string) => {
  const p = to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to
  return /\s/.test(p) ? `@"${p}"` : `@${p}`
}

export async function perform($: EngineInterface, steps: string[][] | { error: string }) {
  if (!Array.isArray(steps)) return void $.ui.toast(steps.error)
  for (const argv of steps) {
    const r = await $.process.run(argv, { timeoutMs: 15_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode !== 0) return void $.ui.toast(r.stderr.trim().split('\n')[0] || `${argv[0]} 명령이 실패했습니다`)
  }
}

// 커서 줄이 가리키는 폴더. 새 탭을 열 폴더다.
export function folderOf(key: string, v: View, d: Data): string {
  const path = key.slice(2)
  if (key.startsWith('d:') || key.startsWith('m:')) return path
  if (key.startsWith('f:')) return parentOf(path)
  if (key.startsWith('l:')) return d.live.find(l => `l:${l.pid}` === key)?.cwd ?? v.top
  if (key.startsWith('p:')) return Object.values(d.past).flat().find(p => `p:${p.agent}:${p.id}` === key)?.cwd ?? v.top
  if (key.startsWith('n:')) return path.slice(0, path.lastIndexOf(':'))
  return key === 'u:' ? parentOf(v.top) : v.top
}

// 이 Claude 세션이 있는 multiplexer. tmux면 창이 속한 세션 id도 물어서 명령에 명시한다(환경 상속에 기대지 않는다).
export async function hereNow($: EngineInterface, d: Data): Promise<Here> {
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
export async function openRow($: EngineInterface, key: string, v: View, d: Data) {
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

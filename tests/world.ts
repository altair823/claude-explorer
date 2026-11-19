// 시험용 가짜 환경. 엔진 호출(파일, 프로세스, 세션 정보)을 메모리 값으로 받아 주고, 실행하려던 명령은 실제로 실행하지 않고 기록만 한다.
export type World = {
  toasts: string[]
  filled: string[]
  cmds: string[][]
  opened: number
  closed: boolean
  shown: boolean
  store: Record<string, unknown>
  home: string
  root: string
  cwd: string
  id: string
  // 폴더 경로별 항목, 파일 경로별 내용
  dirs: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs?: number }[]>
  files: Record<string, string>
  // sh -c PROBE의 출력. undefined면 실패한다.
  probe: string | undefined
  // git 저장소로 보이는 폴더(경로)와 그 status 출력
  repos: Record<string, string>
  // when이 참인 첫 항목의 출력을 돌려준다. 일치하는 것이 없으면 성공과 빈 출력(grep과 find는 일치 없음).
  replies: { when: (argv: string[]) => boolean; exitCode?: number; stdout?: string; stderr?: string }[]
  now: number
  // true면 시계를 직접 다루지 않는다(시험이 mock.clock을 쓴다)
  timers?: boolean
  // 명령이 늦게 끝나는 시간(ms)과 그 동안 기다리는 방법(mock.clock의 sleep)
  delay?: (argv: string[]) => number
  sleep?: (ms: number) => Promise<void>
  // true를 돌려주는 명령은 실행하지 못한 것처럼 거절한다
  reject?: (argv: string[]) => boolean
  // fs.read로 읽은 경로
  reads: string[]
  // 링크가 풀린 실제 경로(경로별). 있으면 그 경로는 폴더이고 resolve 요청에 realPath를 돌려준다.
  real?: Record<string, string>
}

export function world(on: any, o: Partial<World> = {}): World {
  const w: World = { toasts: [], filled: [], cmds: [], opened: 0, closed: false, shown: true, store: {}, home: '/home/u', root: '/home/u/p', cwd: '/home/u/p', id: 'self', dirs: {}, files: {}, probe: undefined, repos: {}, replies: [], reads: [], now: Date.parse('2026-11-19T09:00:00Z'), ...o }
  const res = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  const dirOf = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
  on('ui.panes', () => ({ value: w.closed ? [] : [{ id: 'explorer', title: '탐색기', isShown: w.shown, isFocused: false }] }))
  on('session.root', () => ({ value: w.root }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: w.id }))
  on('env.get', (_: unknown, e: { name?: string; key?: string }) => ({ value: (e.name ?? e.key) === 'HOME' ? w.home : undefined }))
  on('fs.list', (_: unknown, e: { path: string }) => (w.dirs[e.path] ? { value: w.dirs[e.path]!.map(x => ({ size: 0, mtimeMs: 0, isLink: false, ...x })) } : { deny: 'ENOENT' }))
  on('fs.stat', (_: unknown, e: { path: string; resolve?: boolean }) => {
    if (w.real && e.path in w.real) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: true, ...(e.resolve && { realPath: w.real[e.path] }) } }
    if (w.dirs[e.path]) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    if (e.path in w.files) return { value: { kind: 'file', size: w.files[e.path]!.length, mtimeMs: 1, isLink: false } }
    // 목록에는 있지만 dirs에 없는 폴더(읽기 권한이 없는 폴더)
    const parent = w.dirs[dirOf(e.path)]
    return parent?.some(x => x.kind === 'dir' && `${dirOf(e.path) === '/' ? '' : dirOf(e.path)}/${x.name}` === e.path) ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }
  })
  on('fs.read', (_: unknown, e: { path: string }) => (w.reads.push(e.path), e.path in w.files ? { value: w.files[e.path] } : { deny: 'ENOENT' }))
  on('process.run', async (_: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
    w.cmds.push(e.argv)
    if (w.reject?.(e.argv)) return { deny: '실행하지 못했습니다' }
    const wait = w.delay?.(e.argv) ?? 0
    if (wait && w.sleep) await w.sleep(wait)
    const cwd = e.init?.cwd
    const [a, b] = e.argv
    if (a === 'sh') return w.probe === undefined ? res(1) : res(0, w.probe)
    if (a === 'git' && b === 'rev-parse') return cwd !== undefined && cwd in w.repos ? res(0, `${cwd}\n`) : res(128, '', 'fatal: not a git repository')
    if (a === 'git' && e.argv.includes('status')) return cwd !== undefined && cwd in w.repos ? res(0, w.repos[cwd]) : res(128)
    const hit = w.replies.find(r => r.when(e.argv))
    if (hit) return res(hit.exitCode ?? 0, hit.stdout, hit.stderr)
    return res(a === 'grep' || a === 'find' ? 1 : 0)
  })
  on('store.get', (_: unknown, e: { key: string }) => ({ value: w.store[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => ((w.store[e.key] = e.value), { value: undefined }))
  on('command.register', () => ({ value: { command: 'explorer' } }))
  on('ui.open', () => (w.opened++, { value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_: unknown, e: { text?: string }) => (w.toasts.push(typeof e === 'string' ? e : String(e.text ?? JSON.stringify(e))), { value: undefined }))
  on('prompt.fill', (_: unknown, e: { text: string }) => (w.filled.push(e.text), { isFilled: true }))
  if (!w.timers) {
    on('clock.now', () => ({ value: w.now }))
    on('clock.every', () => ({ value: undefined }))
    on('clock.after', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  }
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return w
}

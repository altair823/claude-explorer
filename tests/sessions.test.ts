import { expect, test } from 'claude-code/testing'

import { codexCwd, codexIdOf, liveSessions, parseCodexIndex, parseProbe, parseRegistry, parseTitles, slug } from '../hooks/sessions'

test('parses probe lines', () => {
  const out = '2276787\tclaude\t62605918\t/home/u/projects\t/dev/pts/11\tclaude\thb\t11\t\t\t\n'
    + '1875\tcodex\t1502\t/home/u/projects\t/dev/null\t/home/u/.codex/packages/app-server-daemon/releases/0 app-server\thb\t1\t\t\t\n'
  const [a, b] = parseProbe(out)
  expect(a).toEqual({ pid: 2276787, comm: 'claude', start: '62605918', cwd: '/home/u/projects', fd0: '/dev/pts/11', cmd: 'claude', env: { zellijSession: 'hb', zellijPane: '11' } })
  expect(b!.fd0).toBe('/dev/null')
})
test('rejects reused pid', () => {
  const reg = parseRegistry('{"pid":2276787,"sessionId":"df37","cwd":"/home/u/projects","status":"busy","name":"projects-3b","procStart":"62605918"}')!
  const proc = parseProbe('2276787\tclaude\t99999999\t/home/u/projects\t/dev/pts/11\tclaude\thb\t11\t\t\t\n')
  expect(liveSessions([reg], proc, 'x')).toEqual([])
})
test('skips broken registry', () => {
  expect(parseRegistry('{"pid":12,"cwd":"/a"')).toBeUndefined()
  expect(parseRegistry('{"sessionId":"a"}')).toBeUndefined()
  // 세션이 아닌 파일(peerToken만 있는 JSON)도 건너뛴다
  expect(parseRegistry('{"peerToken":"x","procStart":"1"}')).toBeUndefined()
})
test('joins claude registry and marks self', () => {
  const reg = parseRegistry('{"pid":2276787,"sessionId":"df37","cwd":"/home/u/projects","status":"busy","name":"projects-3b","procStart":"62605918"}')!
  const live = liveSessions([reg], parseProbe('2276787\tclaude\t62605918\t/home/u/projects\t/dev/pts/11\tclaude\thb\t11\t\t\t\n'), 'df37')
  expect(live).toEqual([{ agent: 'claude', pid: 2276787, cwd: '/home/u/projects', name: 'projects-3b', state: 'busy', id: 'df37', mux: { kind: 'zellij', session: 'hb', pane: 11 }, self: true }])
})
test('keeps only interactive codex', () => {
  const out = '1875\tcodex\t1502\t/p\t/dev/null\tcodex app-server\thb\t1\t\t\t\n'
    + '1885334\tcodex\t602\t/home/u\tpipe:[36009017]\tcodex app-server proxy\t\t\t\t\t\n'
    + '4242\tcodex\t700\t/p/sci\t/dev/pts/3\tcodex\t\t\t/tmp/tmux-1000/default,123,0\t%4\t/home/u/.codex/sessions/2026/11/15/rollout-2026-11-15T00-53-05-01a1dac3-26fa-7e53-9a7f-a93d3c9865d2.jsonl\n'
  expect(liveSessions([], parseProbe(out), 'x')).toEqual([{ agent: 'codex', pid: 4242, cwd: '/p/sci', name: 'codex', state: 'running', id: '01a1dac3-26fa-7e53-9a7f-a93d3c9865d2', mux: { kind: 'tmux', socket: '/tmp/tmux-1000/default', pane: '%4' } }])
})
test('slug matches claude projects folder', () => {
  expect(slug('/home/altair823/projects')).toBe('-home-altair823-projects')
  expect(slug('/home/u/my_app.v2')).toBe('-home-u-my-app-v2')
})
test('parses grep title output', () => {
  const out = '/c/a.jsonl:"aiTitle":"Gitea runner 구성 검토"\n/c/b.jsonl:"customTitle":"따옴표 \\"포함\\" 제목"\n'
  expect(parseTitles(out)).toEqual({ '/c/a.jsonl': 'Gitea runner 구성 검토', '/c/b.jsonl': '따옴표 "포함" 제목' })
})
test('reads codex meta and index', () => {
  expect(codexCwd('{"timestamp":"2026-11-14T15:53:31.512Z","type":"session_meta","payload":{"id":"01a1","cwd":"/home/u/projects/sci-hub-crawler","originator":"codex-tui"')).toBe('/home/u/projects/sci-hub-crawler')
  expect(codexIdOf('/x/rollout-2026-11-15T00-53-05-01a1dac3-26fa-7e53-9a7f-a93d3c9865d2.jsonl')).toBe('01a1dac3-26fa-7e53-9a7f-a93d3c9865d2')
  expect(parseCodexIndex('{"id":"a","thread_name":"첫 이름","updated_at":"2026-11-11T14:28:34Z"}\n깨진 줄\n{"id":"a","thread_name":"바뀐 이름","updated_at":"2026-11-12T00:00:00Z"}\n')).toEqual({ a: '바뀐 이름' })
})

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Data, View } from '../types'
import type { Msg } from './list'
import { buildRows, step } from './tree'

const PANE = 'session-explorer'
const view = atom({ plugin: 'session-explorer', key: 'view' } as const, { top: '', open: [], cur: '', more: [], hidden: false } as View, { shape: 'view-1' })
const data = atom({ plugin: 'session-explorer', key: 'data' } as const, { live: [], past: {}, lists: {}, git: {} } as Data, { shape: 'data-1' })

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
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const msg = parseMsg(e.data)
    if (!msg) return {}
    const [v, d] = await Promise.all([read($, view), read($, data)])
    const next = step(v, msg, buildRows(v, d, ''), d.live)
    if (next) await update($, view, () => next)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Client는 터미널과 데스크톱 화면에만 있다
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Client } = $.ui.resolve(e)
    const [v, d] = await Promise.all([read($, view), read($, data)])
    return <Client key="tree" module="./list.tsx" props={{ rows: buildRows(v, d, ''), cur: v.cur }} height={Math.max(3, e.props.scroll.bodyRows)} />
  })
}

// 시험 환경에는 값을 저장하는 곳이 없으므로 state.get과 state.set을 메모리로 받아 준다.
// put은 모양 태그를 붙여 저장한다(plugin.json의 atom 선언과 같은 shape).
type Slot = { value: unknown; version: number }

export function memState(on: any) {
  const store = new Map<string, Slot>()
  on('state.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    const version = (store.get(e.key)?.version ?? 0) + 1
    store.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  return {
    put: (key: 'view' | 'data', shape: string, value: unknown) => void store.set(key, { value: { shape, value }, version: (store.get(key)?.version ?? 0) + 1 }),
    get: (key: string) => (store.get(key)?.value as { value: any } | undefined)?.value,
  }
}

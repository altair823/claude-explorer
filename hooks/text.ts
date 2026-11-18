// 칸 폭: 한글과 이모지는 두 칸
const cw = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    ? 2
    : 1
}
export const width = (s: string) => [...s].reduce((n, ch) => n + cw(ch), 0)

// cols칸에 들어가도록 끝을 …로 자른다
export function clip(s: string, cols: number): string {
  if (width(s) <= cols) return s
  let t = ''
  for (const ch of s) {
    if (width(t) + cw(ch) > cols - 1) break
    t += ch
  }
  return `${t}…`
}

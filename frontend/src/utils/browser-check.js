export function detectBrowserCompatibility() {
  const ua = navigator.userAgent
  const chrome = /Chrome\/(\d+)/.exec(ua)
  const firefox = /Firefox\/(\d+)/.exec(ua)
  const edge = /Edg\/(\d+)/.exec(ua)

  if (edge) return Number(edge[1]) >= 90
  if (firefox) return Number(firefox[1]) >= 88
  if (chrome) return Number(chrome[1]) >= 90
  return false
}

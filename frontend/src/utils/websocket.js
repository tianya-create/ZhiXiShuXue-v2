const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
let socket = null
const listeners = new Map()

export function connectStudentWebSocket(userId) {
  if (!userId) return null
  if (socket && socket.readyState === WebSocket.OPEN) return socket
  socket = new WebSocket(`${wsProtocol}://${window.location.host}/ws?userId=${encodeURIComponent(userId)}`)
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data || '{}')
    const group = listeners.get(message.event) || []
    group.forEach((handler) => handler(message.payload))
  }
  return socket
}

export function onSocketEvent(event, handler) {
  if (!listeners.has(event)) listeners.set(event, [])
  listeners.get(event).push(handler)
}

export function closeStudentWebSocket() {
  if (socket) socket.close()
  socket = null
}

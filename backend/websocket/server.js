const WebSocket = require('ws');

let wss = null;
const clients = new Map();

function initWebSocketServer(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const userId = url.searchParams.get('userId') || '';
    if (userId) {
      if (!clients.has(userId)) clients.set(userId, new Set());
      clients.get(userId).add(socket);
    }

    socket.on('close', () => {
      if (userId && clients.has(userId)) {
        clients.get(userId).delete(socket);
        if (!clients.get(userId).size) clients.delete(userId);
      }
    });
  });

  return wss;
}

function broadcastToUser(userId, event, payload) {
  const group = clients.get(String(userId || ''));
  if (!group) return;
  const message = JSON.stringify({ event, payload });
  group.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  });
}

module.exports = {
  initWebSocketServer,
  broadcastToUser
};

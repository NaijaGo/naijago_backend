// Keep the existing single socket-ID maps while allowing an inbox and a chat
// to connect independently. Explicitly-offline accounts are never reactivated.
function retainChatSocketPresence(map, userId, leavingSocketId, sockets) {
  const id = String(userId);
  if (map.get(id) !== leavingSocketId) return false;
  const replacement = Array.from(sockets).find(socket => socket.id !== leavingSocketId &&
    socket.connected === true && String(socket.user?.id || '') === id);
  if (replacement) map.set(id, replacement.id);
  else map.delete(id);
  return true;
}
module.exports = { retainChatSocketPresence };

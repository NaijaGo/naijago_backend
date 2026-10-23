// Private Socket.IO rooms. Every authenticated socket joins the room for its
// own account id, and admin sockets also join ADMIN_SOCKET_ROOM, so private
// events reach only their intended audience instead of every connected client.
const ADMIN_SOCKET_ROOM = 'admins';

const userSocketRoom = (userId) => `account:${String(userId)}`;

const joinUserSocketRoom = (socket, userId) => {
  if (!socket || !userId) return;
  socket.join(userSocketRoom(userId));
};

// Event names are unchanged (e.g. `user_<id>`, `vendor_<id>`) so the apps do
// not need to change; only the audience is narrowed.
const emitToAccount = (io, accountId, event, payload) => {
  if (!io || !accountId) return;
  io.to(userSocketRoom(accountId)).emit(event, payload);
};

const emitToUser = (io, userId, payload) => {
  if (!userId) return;
  emitToAccount(io, userId, `user_${String(userId)}`, payload);
};

const emitToAdmins = (io, event, payload) => {
  if (!io) return;
  io.to(ADMIN_SOCKET_ROOM).emit(event, payload);
};

module.exports = {
  ADMIN_SOCKET_ROOM,
  userSocketRoom,
  joinUserSocketRoom,
  emitToAccount,
  emitToUser,
  emitToAdmins,
};

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_SOCKET_ROOM,
  userSocketRoom,
  joinUserSocketRoom,
  emitToAccount,
  emitToUser,
  emitToAdmins,
} = require('../utils/userSocketRoom');

function fakeIo() {
  const sent = [];
  return {
    sent,
    emit() { throw new Error('private events must not be broadcast to every socket'); },
    to(room) { return { emit: (event, payload) => sent.push({ room, event, payload }) }; },
  };
}

test('user events keep their client event name but only reach the account room', () => {
  const io = fakeIo();
  emitToUser(io, 'u1', { type: 'order_claimed' });
  assert.deepEqual(io.sent, [{ room: userSocketRoom('u1'), event: 'user_u1', payload: { type: 'order_claimed' } }]);
});

test('vendor events (which can carry pickup OTPs) only reach that vendor', () => {
  const io = fakeIo();
  emitToAccount(io, 'v9', 'vendor_v9', { pickupOTP: '1234' });
  assert.equal(io.sent[0].room, userSocketRoom('v9'));
  assert.equal(io.sent[0].event, 'vendor_v9');
});

test('admin events only reach the admin room', () => {
  const io = fakeIo();
  emitToAdmins(io, 'admin_notification', { message: 'x' });
  assert.deepEqual(io.sent.map((e) => e.room), [ADMIN_SOCKET_ROOM]);
});

test('ObjectId-like ids resolve to the same room as their string form', () => {
  const objectIdLike = { toString: () => 'abc' };
  assert.equal(userSocketRoom(objectIdLike), userSocketRoom('abc'));
});

test('missing io or id is a safe no-op', () => {
  assert.doesNotThrow(() => emitToUser(undefined, 'u1', {}));
  assert.doesNotThrow(() => emitToUser(fakeIo(), null, {}));
  assert.doesNotThrow(() => emitToAdmins(null, 'admin_notification', {}));
  assert.doesNotThrow(() => joinUserSocketRoom(null, 'u1'));
});

test('sockets join their own account room', () => {
  const joined = [];
  joinUserSocketRoom({ join: (room) => joined.push(room) }, 'u1');
  assert.deepEqual(joined, [userSocketRoom('u1')]);
});

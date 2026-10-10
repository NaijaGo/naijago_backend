const ChatMessage = require('../models/ChatMessage');

class ChatDeliveryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// The primary Mongo _id index makes socket/HTTP/manual retries atomic without
// adding an index or changing older clients' messages.
async function persistPharmacyMessage({ sessionId, senderId, senderType, text, clientMessageId }, model = ChatMessage) {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 5000) {
    throw new ChatDeliveryError('Write a message of at most 5000 characters.');
  }
  const id = clientMessageId == null ? null : String(clientMessageId);
  if (id !== null && !/^[a-f0-9]{24}$/.test(id)) {
    throw new ChatDeliveryError('Invalid message retry identifier.');
  }
  const message = text.trim();
  const data = { session: sessionId, sender: senderId, senderType, message, ...(id ? { _id: id } : {}) };
  try {
    return { message: await model.create(data), created: true };
  } catch (error) {
    if (!id || error.code !== 11000) throw error;
    const existing = await model.findById(id);
    if (!existing || String(existing.session) !== String(sessionId) ||
        String(existing.sender) !== String(senderId) || existing.senderType !== senderType || existing.message !== message) {
      throw new ChatDeliveryError('This retry identifier belongs to another message.', 409);
    }
    return { message: existing, created: false };
  }
}
module.exports = { persistPharmacyMessage, ChatDeliveryError };

const ChatSession = require('../models/ChatSession');
async function claimPharmacySession(session, pharmacistId, model = ChatSession) {
  if (session.status === 'closed') return null;
  if (String(session.pharmacist || '') === String(pharmacistId)) return session;
  return model.findOneAndUpdate({ _id: session._id, status: session.status, pharmacist: session.pharmacist || null },
    { $set: { pharmacist: pharmacistId, status: 'assigned' } }, { new: true, runValidators: true });
}
module.exports = { claimPharmacySession };

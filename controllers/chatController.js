// controllers/chatController.js
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const {
  getUserPharmacyAccess,
  consumeOneTimeCreditIfNeeded,
} = require('../services/pharmacySubscriptionService');
// NOTE: axios and getAIResponse removed as core logic moves to server.js socket handler

const formatChatMessage = (message) => ({
  id: message._id,
  session: String(message.session),
  senderType: message.senderType,
  sender: message.sender ? String(message.sender) : null,
  text: message.message,
  createdAt: message.createdAt,
});

const isApprovedPharmacistUser = (user) =>
  Boolean(
    user &&
      user.isVendor === true &&
      user.vendorStatus === 'approved' &&
      (user.role === 'pharmacist' || user.pharmacistStatus === 'approved') &&
      user.pharmacistStatus === 'approved',
  );

const notifyPharmacistsForSession = (app, session, textPreview) => {
  const onlinePharmacists = app?.get?.('onlinePharmacists');
  const io = app?.get?.('io');
  if (!onlinePharmacists || !io) return false;

  const payload = {
    sessionId: String(session._id),
    userId: String(session.user),
    textPreview: String(textPreview || 'A customer is waiting for pharmacist support.').slice(0, 300),
    createdAt: new Date(),
  };

  if (session.pharmacist) {
    const socketId = onlinePharmacists.get(String(session.pharmacist));
    if (!socketId) return false;
    io.to(socketId).emit('incoming_chat_request', payload);
    return true;
  }

  for (const socketId of onlinePharmacists.values()) {
    io.to(socketId).emit('incoming_chat_request', payload);
  }
  return onlinePharmacists.size > 0;
};

const buildQueueItem = async (session) => {
  const latestMessage = await ChatMessage.findOne({
    session: session._id,
    senderType: 'user',
  })
    .sort({ createdAt: -1 })
    .lean();

  return {
    sessionId: String(session._id),
    userId: String(session.user),
    textPreview: latestMessage?.message || 'A customer is waiting for pharmacist support.',
    createdAt: latestMessage?.createdAt || session.createdAt,
    status: session.status,
    pharmacist: session.pharmacist ? String(session.pharmacist) : null,
  };
};

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getDefaultDeliveryLocation = (user) => {
  const addresses = Array.isArray(user.deliveryAddresses) ? user.deliveryAddresses : [];
  const selected = addresses.find((address) => address?.isDefault) || addresses[0];
  if (!selected) return null;

  const latitude = Number(selected.latitude);
  const longitude = Number(selected.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return { latitude, longitude };
};

const findBestPharmacistForUser = async (user, app) => {
  const onlinePharmacists = app?.get?.('onlinePharmacists');
  const onlinePharmacistIds = onlinePharmacists
    ? Array.from(onlinePharmacists.keys())
    : [];

  const pharmacists = await User.find({
    pharmacistStatus: 'approved',
    vendorStatus: 'approved',
    isVendor: true,
    ...(onlinePharmacistIds.length > 0
      ? { _id: { $in: onlinePharmacistIds } }
      : { isAvailable: true }),
  }).select('businessName businessLocation isAvailable lastActive').lean();

  if (!pharmacists.length) return null;

  const userLocation = getDefaultDeliveryLocation(user);
  if (!userLocation) {
    return pharmacists[0];
  }

  return pharmacists
    .map((pharmacist) => {
      const latitude = Number(pharmacist.businessLocation?.latitude);
      const longitude = Number(pharmacist.businessLocation?.longitude);
      const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);

      return {
        pharmacist,
        distanceKm: hasLocation
          ? distanceKm(userLocation.latitude, userLocation.longitude, latitude, longitude)
          : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => {
      return a.distanceKm - b.distanceKm;
    })[0]?.pharmacist || null;
};

// Start a chat session
exports.startChat = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('pharmacySubscription deliveryAddresses');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // A user can only have one active session.
    const existing = await ChatSession.findOne({
      user: req.user._id,
      status: { $in: ['open', 'assigned'] },
    });
    if (existing?.pharmacyAccessGrantedAt) return res.json(existing);

    const access = getUserPharmacyAccess(user);
    if (!access.hasAccess) {
      return res.status(402).json({
        message: 'A pharmacist chat subscription is required before starting a consultation.',
        code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
        access,
      });
    }

    const consumption = await consumeOneTimeCreditIfNeeded(user);
    if (!consumption.allowed) {
      return res.status(402).json({
        message: 'A pharmacist chat subscription is required before starting a consultation.',
        code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
        access: consumption.access,
      });
    }

    const assignedPharmacist = await findBestPharmacistForUser(user, req.app);

    const chat = await ChatSession.create({
      user: req.user._id,
      pharmacist: assignedPharmacist?._id,
      status: assignedPharmacist ? 'assigned' : 'open',
      pharmacyAccessType: access.planType === 'none' ? 'one_time' : access.planType,
      pharmacyAccessGrantedAt: new Date(),
    });
    res.status(201).json(chat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to start chat' });
  }
};

// Send message (kept for non-socket fallback/legacy, but client should prefer socket)
// NOTE: This route should ideally be disabled or handle only metadata updates,
// as the primary messaging logic is in server.js/send_chat_message.
exports.sendMessage = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const message = String(req.body.message || req.body.text || '').trim();
    if (!sessionId || !message) {
      return res.status(400).json({ message: 'sessionId and message are required.' });
    }

    const session = await ChatSession.findById(sessionId);
    if (!session) return res.status(404).json({ message: 'Chat not found' });

    const isPharmacist = isApprovedPharmacistUser(req.user);
    const isOwner = String(session.user) === String(req.user._id);
    const isAssignedPharmacist =
      session.pharmacist && String(session.pharmacist) === String(req.user._id);

    if (isPharmacist && !isAssignedPharmacist) {
      return res.status(403).json({
        message: 'Only the assigned pharmacist can reply to this consultation.',
      });
    }

    if (!isPharmacist && !isOwner) {
      return res.status(403).json({ message: 'Not authorized for this chat.' });
    }

    const chatMessage = await ChatMessage.create({
      session: sessionId,
      senderType: isPharmacist ? 'pharmacist' : 'user',
      sender: req.user._id,
      message,
    });

    const formatted = formatChatMessage(chatMessage);
    req.app.get('io')?.to(`chat_${sessionId}`).emit('new_message', formatted);

    if (!isPharmacist) {
      notifyPharmacistsForSession(req.app, session, message);
    }

    res.json({ success: true, message: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Message send failed' });
  }
};

exports.getPharmacistQueue = async (req, res) => {
  try {
    if (!isApprovedPharmacistUser(req.user)) {
      return res.status(403).json({
        message: 'Only approved pharmacists can view consultation queue.',
      });
    }

    const sessions = await ChatSession.find({
      $or: [
        {
          status: 'open',
          $or: [{ pharmacist: { $exists: false } }, { pharmacist: null }],
        },
        {
          status: 'assigned',
          pharmacist: req.user._id,
        },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const queue = await Promise.all(sessions.map(buildQueueItem));
    res.json({ success: true, queue });
  } catch (err) {
    console.error('Get pharmacist queue failed:', err);
    res.status(500).json({ message: 'Failed to load consultation queue.' });
  }
};

exports.claimSession = async (req, res) => {
  try {
    if (!isApprovedPharmacistUser(req.user)) {
      return res.status(403).json({
        message: 'Only approved pharmacists can claim customer consultations.',
      });
    }

    const session = await ChatSession.findById(req.params.sessionId || req.body.sessionId);
    if (!session) return res.status(404).json({ message: 'Chat session not found.' });

    if (session.pharmacist && String(session.pharmacist) !== String(req.user._id)) {
      return res.status(409).json({ message: 'This consultation has already been claimed.' });
    }

    session.pharmacist = req.user._id;
    session.status = 'assigned';
    await session.save();

    const pharmacistName =
      req.user.businessName ||
      [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') ||
      'A certified pharmacist';

    const systemMessage = await ChatMessage.create({
      session: session._id,
      senderType: 'system',
      sender: null,
      message: `${pharmacistName} has joined the consultation.`,
    });

    const io = req.app.get('io');
    io?.to(`chat_${session._id}`).emit('new_message', formatChatMessage(systemMessage));
    io?.to(`chat_${session._id}`).emit('pharmacist_joined', {
      pharmacistId: String(req.user._id),
      name: pharmacistName,
    });

    res.json({ success: true, session });
  } catch (err) {
    console.error('Claim session failed:', err);
    res.status(500).json({ message: 'Failed to claim consultation.' });
  }
};

// controllers/chatController.js
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const {
  getUserPharmacyAccess,
  consumeOneTimeCreditIfNeeded,
} = require('../services/pharmacySubscriptionService');
const notificationService = require('../services/notificationService');
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

const sendPharmacistPush = async ({ pharmacistId, session, textPreview }) => {
  if (!pharmacistId) return;
  await notificationService.sendToUser(String(pharmacistId), {
    title: 'New pharmacist consultation',
    message: String(textPreview || 'A customer is waiting for pharmacist support.').slice(0, 220),
    data: {
      type: 'pharmacy_consultation_request',
      sessionId: String(session._id),
      userId: String(session.user),
    },
  });
};

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
    if (socketId) {
      io.to(socketId).emit('incoming_chat_request', payload);
    }
    sendPharmacistPush({
      pharmacistId: String(session.pharmacist),
      session,
      textPreview,
    }).catch((error) => {
      console.error(`Assigned pharmacist push failed for ${session.pharmacist}:`, error.message);
    });
    return Boolean(socketId);
  }

  for (const socketId of onlinePharmacists.values()) {
    io.to(socketId).emit('incoming_chat_request', payload);
  }
  getPushEligiblePharmacistList(app)
    .then((pharmacists) =>
      Promise.allSettled(
        pharmacists.map((pharmacist) =>
          sendPharmacistPush({
            pharmacistId: String(pharmacist._id),
            session,
            textPreview,
          })
        )
      )
    )
    .catch((error) => {
      console.error('Online pharmacist pushes failed:', error.message);
    });
  return onlinePharmacists.size > 0;
};

const getOnlinePharmacistList = async (app) => {
  const onlinePharmacists = app?.get?.('onlinePharmacists');
  const socketIds = onlinePharmacists ? Array.from(onlinePharmacists.keys()) : [];
  if (socketIds.length === 0) return [];

  const pharmacists = await User.find({
    _id: { $in: socketIds },
    isVendor: true,
    vendorStatus: 'approved',
    pharmacistStatus: 'approved',
    $or: [{ role: 'pharmacist' }, { pharmacistStatus: 'approved' }],
  })
    .select('firstName lastName businessName phoneNumber businessSupportPhone isAvailable')
    .lean();

  return pharmacists.map((user) => ({
    id: String(user._id),
    name:
      user.businessName ||
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      'Pharmacist',
    phoneNumber: user.businessSupportPhone || user.phoneNumber || '',
    hasSocket: onlinePharmacists?.has?.(String(user._id)) === true,
  }));
};

const getOnlinePharmacistIds = (app) => {
  const onlinePharmacists = app?.get?.('onlinePharmacists');
  return onlinePharmacists ? Array.from(onlinePharmacists.keys()) : [];
};

const getPushEligiblePharmacistList = async (app) => {
  const onlineIds = getOnlinePharmacistIds(app);
  return User.find({
    isVendor: true,
    vendorStatus: 'approved',
    pharmacistStatus: 'approved',
    $or: [{ role: 'pharmacist' }, { pharmacistStatus: 'approved' }],
    $and: [
      {
        $or: [
          { isAvailable: true },
          ...(onlineIds.length ? [{ _id: { $in: onlineIds } }] : []),
        ],
      },
    ],
  })
    .select('_id')
    .lean();
};

const notifyUserOfPharmacyMessage = async (app, session, textPreview, pharmacist) => {
  const io = app?.get?.('io');
  const onlineUsers = app?.get?.('onlineUsers');
  if (!session?.user) return;

  const pharmacistName =
    pharmacist?.businessName ||
    [pharmacist?.firstName, pharmacist?.lastName].filter(Boolean).join(' ') ||
    'A pharmacist';
  const payload = {
    type: 'pharmacy_chat_message',
    sessionId: String(session._id),
    message: `${pharmacistName}: ${String(textPreview || 'You have a new pharmacy chat message.').slice(0, 220)}`,
    createdAt: new Date(),
  };

  await User.findByIdAndUpdate(session.user, {
    $push: {
      notifications: {
        $each: [{
          type: 'general',
          message: payload.message,
          read: false,
          createdAt: payload.createdAt,
        }],
        $position: 0,
        $slice: 100,
      },
    },
  });

  const socketId = onlineUsers?.get?.(String(session.user));
  if (io && socketId) {
    io.to(socketId).emit('pharmacy_chat_message', payload);
    io.to(socketId).emit(`user_${session.user}`, payload);
  }
  io?.emit(`user_${session.user}`, payload);

  notificationService.sendToUser(String(session.user), {
    title: 'New pharmacy chat message',
    message: payload.message,
    data: payload,
  }).catch((error) => {
    console.error(`User pharmacy chat push failed for ${session.user}:`, error.message);
  });
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
  const onlinePharmacistIds = getOnlinePharmacistIds(app);

  if (onlinePharmacistIds.length === 0) return null;

  const pharmacists = await User.find({
    _id: { $in: onlinePharmacistIds },
    pharmacistStatus: 'approved',
    vendorStatus: 'approved',
    isVendor: true,
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

const hasExplicitPharmacyAccessGrant = (session) =>
  Boolean(
    session?.pharmacyAccessGrantedAt &&
      ['one_time', 'subscription', 'admin'].includes(session?.pharmacyAccessSource),
  );

const buildPharmacyAccessGrant = (access) => ({
  pharmacyAccessType: access.planType === 'none' ? 'one_time' : access.planType,
  pharmacyAccessSource:
    access.source || (access.status === 'active' ? 'subscription' : 'one_time'),
  pharmacyAccessExpiresAt: access.expiresAt || null,
  pharmacyAccessGrantedAt: new Date(),
});

const pharmacyAccessRequiredResponse = (access) => ({
  message: 'A pharmacist chat subscription is required before starting a consultation.',
  code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
  entitlement: 'pharmacy_chat',
  access,
});

// Start a chat session
exports.startChat = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('pharmacySubscription deliveryAddresses');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // A user can only have one active consultation.
    const existing = await ChatSession.findOne({
      user: req.user._id,
      status: { $in: ['open', 'assigned'] },
    });
    if (hasExplicitPharmacyAccessGrant(existing)) {
      return res.json(existing);
    }

    const access = getUserPharmacyAccess(user);
    if (!access.hasAccess) {
      return res.status(402).json(pharmacyAccessRequiredResponse(access));
    }

    const consumption = await consumeOneTimeCreditIfNeeded(user);
    if (!consumption.allowed) {
      return res.status(402).json(pharmacyAccessRequiredResponse(consumption.access));
    }

    const assignedPharmacist = await findBestPharmacistForUser(user, req.app);
    const accessGrant = buildPharmacyAccessGrant(access);

    if (existing) {
      if (!existing.pharmacist && assignedPharmacist?._id) {
        existing.pharmacist = assignedPharmacist._id;
        existing.status = 'assigned';
      }
      Object.assign(existing, accessGrant);
      await existing.save();
      return res.json(existing);
    }

    const chat = await ChatSession.create({
      user: req.user._id,
      pharmacist: assignedPharmacist?._id,
      status: assignedPharmacist ? 'assigned' : 'open',
      ...accessGrant,
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

    if (!hasExplicitPharmacyAccessGrant(session)) {
      return res.status(402).json(pharmacyAccessRequiredResponse({
        hasAccess: false,
        entitlement: 'pharmacy_chat',
        planType: 'none',
        status: 'inactive',
        expiresAt: null,
        oneTimeCredits: 0,
      }));
    }

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
    } else {
      notifyUserOfPharmacyMessage(req.app, session, message, req.user).catch((error) => {
        console.error('Failed to notify user of pharmacy message:', error);
      });
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

    const onlinePharmacistIds = getOnlinePharmacistIds(req.app);
    const sessions = await ChatSession.find({
      pharmacyAccessGrantedAt: { $ne: null },
      pharmacyAccessSource: { $in: ['one_time', 'subscription', 'admin'] },
      $or: [
        {
          status: 'open',
          $or: [{ pharmacist: { $exists: false } }, { pharmacist: null }],
        },
        {
          status: 'assigned',
          pharmacist: req.user._id,
        },
        {
          status: 'assigned',
          pharmacist: { $nin: onlinePharmacistIds },
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

exports.getOnlinePharmacists = async (req, res) => {
  try {
    const pharmacists = await getOnlinePharmacistList(req.app);
    res.json({
      success: true,
      online: pharmacists.length > 0,
      count: pharmacists.length,
      pharmacists,
    });
  } catch (err) {
    console.error('Get online pharmacists failed:', err);
    res.status(500).json({ message: 'Failed to load online pharmacists.' });
  }
};

exports.updatePharmacistAvailability = async (req, res) => {
  try {
    if (!isApprovedPharmacistUser(req.user)) {
      return res.status(403).json({
        message: 'Only approved pharmacists can update availability.',
      });
    }

    const online = req.body?.online === true || req.body?.isAvailable === true;
    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { isAvailable: online, lastActive: new Date() } },
      { new: true },
    ).select('isAvailable firstName lastName businessName');

    const onlinePharmacists = req.app.get('onlinePharmacists');
    const io = req.app.get('io');
    const socketId = onlinePharmacists?.get?.(String(req.user._id));
    if (!online && onlinePharmacists) {
      onlinePharmacists.delete(String(req.user._id));
    }

    const pharmacists = await getOnlinePharmacistList(req.app);
    io?.emit('pharmacistStatus', {
      online: pharmacists.length > 0,
      count: pharmacists.length,
      pharmacists,
    });

    if (online) {
      notificationService.sendToUser(req.user._id.toString(), {
        title: 'You are online',
        message: 'You can now receive pharmacist consultation requests from NaijaGo.',
        data: {
          type: 'pharmacist_online',
          pharmacistId: req.user._id.toString(),
        },
      }).catch((error) => {
        console.error(`Pharmacist online push failed for ${req.user._id}:`, error.message);
      });
    }

    res.json({
      success: true,
      online: updated?.isAvailable === true,
      hasSocket: Boolean(socketId),
    });
  } catch (err) {
    console.error('Update pharmacist availability failed:', err);
    res.status(500).json({ message: 'Unable to update pharmacist availability.' });
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
    if (!hasExplicitPharmacyAccessGrant(session)) {
      return res.status(402).json({
        message: 'This consultation is waiting for pharmacist chat access before it can be claimed.',
        code: 'PHARMACY_SUBSCRIPTION_REQUIRED',
        entitlement: 'pharmacy_chat',
      });
    }

    const wasAlreadyAssignedToMe =
      session.pharmacist && String(session.pharmacist) === String(req.user._id);

    const assignedPharmacistOnline =
      session.pharmacist &&
      req.app.get('onlinePharmacists')?.has?.(String(session.pharmacist));

    if (session.pharmacist && !wasAlreadyAssignedToMe && assignedPharmacistOnline) {
      return res.status(409).json({ message: 'This consultation has already been claimed.' });
    }

    session.pharmacist = req.user._id;
    session.status = 'assigned';
    await session.save();

    const pharmacistName =
      req.user.businessName ||
      [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') ||
      'A certified pharmacist';

    const io = req.app.get('io');
    if (!wasAlreadyAssignedToMe) {
      const systemMessage = await ChatMessage.create({
        session: session._id,
        senderType: 'system',
        sender: null,
        message: `${pharmacistName} has joined the consultation.`,
      });

      io?.to(`chat_${session._id}`).emit('new_message', formatChatMessage(systemMessage));
      io?.to(`chat_${session._id}`).emit('pharmacist_joined', {
        pharmacistId: String(req.user._id),
        name: pharmacistName,
      });
    }

    res.json({ success: true, session });
  } catch (err) {
    console.error('Claim session failed:', err);
    res.status(500).json({ message: 'Failed to claim consultation.' });
  }
};

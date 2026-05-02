// controllers/chatController.js
const ChatSession = require('../models/ChatSession');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const {
  getUserPharmacyAccess,
  consumeOneTimeCreditIfNeeded,
} = require('../services/pharmacySubscriptionService');
// NOTE: axios and getAIResponse removed as core logic moves to server.js socket handler

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

const findBestPharmacistForUser = async (user) => {
  const pharmacists = await User.find({
    role: 'pharmacist',
    pharmacistStatus: 'approved',
    vendorStatus: 'approved',
    isVendor: true,
  }).select('businessName businessLocation isAvailable lastActive').lean();

  if (!pharmacists.length) return null;

  const userLocation = getDefaultDeliveryLocation(user);
  if (!userLocation) {
    return pharmacists.find((pharmacist) => pharmacist.isAvailable) || pharmacists[0];
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
      if (a.pharmacist.isAvailable !== b.pharmacist.isAvailable) {
        return a.pharmacist.isAvailable ? -1 : 1;
      }
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

    const assignedPharmacist = await findBestPharmacistForUser(user);

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
    const { sessionId, message } = req.body;
    const session = await ChatSession.findById(sessionId);
    if (!session) return res.status(404).json({ message: 'Chat not found' });

    // Save user message but rely on the socket to handle real-time reply (AI/Pharmacist)
    const userMsg = await ChatMessage.create({
      session: sessionId,
      senderType: 'user',
      sender: req.user._id,
      message,
    });
    
    // Note: AI/Pharmacist reply logic is removed here to prevent duplication with socket.io
    // The client should send the message via socket.io's 'send_chat_message' event.

    res.json({ success: true, message: userMsg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Message send failed' });
  }
};

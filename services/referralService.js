const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const User = require('../models/User');
const MainOrder = require('../models/MainOrder');

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECENT_INVITES_LIMIT = 12;
const DEFAULT_PUBLIC_REFERRAL_BASE_URL = 'https://naijagoapp.com';
const REFERRAL_SETTINGS_KEY = 'referral_program';
const ADMIN_IDENTITY_FIELDS = 'firstName lastName email';

const normalizeReferralCode = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
};

const getDefaultRewardPerReferral = () => {
  const parsedAmount = Number.parseFloat(process.env.REFERRAL_REWARD_AMOUNT || '0');
  return Number.isFinite(parsedAmount) ? Math.max(parsedAmount, 0) : 0;
};

const mapAdminIdentity = (adminLike) => {
  if (!adminLike) {
    return null;
  }

  const firstName = String(adminLike.firstName || '').trim();
  const lastName = String(adminLike.lastName || '').trim();
  const fullName = `${firstName} ${lastName}`.trim();

  return {
    id: adminLike._id || null,
    name: fullName || adminLike.email || 'Admin',
    email: adminLike.email || '',
  };
};

const mapReferralRewardHistoryEntry = (entry) => ({
  previousAmount:
    entry?.previousAmount === null || entry?.previousAmount === undefined
      ? null
      : Number(entry.previousAmount),
  newAmount: Number(entry?.newAmount || 0),
  changedAt: entry?.changedAt || null,
  source: entry?.source || 'admin_update',
  changedBy: mapAdminIdentity(entry?.changedBy || null),
});

const getReferralProgramSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: REFERRAL_SETTINGS_KEY })
    .select('referralRewardAmount updatedBy updatedAt createdAt referralRewardHistory')
    .populate('updatedBy', ADMIN_IDENTITY_FIELDS)
    .populate('referralRewardHistory.changedBy', ADMIN_IDENTITY_FIELDS);

  if (existingSettings) {
    const history = Array.isArray(existingSettings.referralRewardHistory)
      ? existingSettings.referralRewardHistory
          .map(mapReferralRewardHistoryEntry)
          .sort(
            (left, right) =>
              new Date(right.changedAt || 0).getTime() -
              new Date(left.changedAt || 0).getTime(),
          )
      : [];

    return {
      referralRewardAmount: Number(existingSettings.referralRewardAmount || 0),
      updatedBy: mapAdminIdentity(existingSettings.updatedBy),
      updatedAt: existingSettings.updatedAt || null,
      createdAt: existingSettings.createdAt || null,
      source: 'database',
      history,
    };
  }

  return {
    referralRewardAmount: getDefaultRewardPerReferral(),
    updatedBy: null,
    updatedAt: null,
    createdAt: null,
    source: 'env',
    history: [],
  };
};

const getRewardPerReferral = async () => {
  const existingSettings = await AppSetting.findOne({ key: REFERRAL_SETTINGS_KEY })
    .select('referralRewardAmount')
    .lean();

  if (existingSettings && Number.isFinite(Number(existingSettings.referralRewardAmount))) {
    return Math.max(Number(existingSettings.referralRewardAmount), 0);
  }

  return getDefaultRewardPerReferral();
};

const initializeReferralProgramSettings = async () => {
  const existingSettings = await AppSetting.findOne({ key: REFERRAL_SETTINGS_KEY }).select(
    'referralRewardAmount',
  );

  if (existingSettings) {
    return {
      seeded: false,
      referralRewardAmount: Number(existingSettings.referralRewardAmount || 0),
    };
  }

  const defaultRewardAmount = getDefaultRewardPerReferral();

  try {
    await AppSetting.create({
      key: REFERRAL_SETTINGS_KEY,
      referralRewardAmount: defaultRewardAmount,
      updatedBy: null,
      referralRewardHistory: [
        {
          previousAmount: null,
          newAmount: defaultRewardAmount,
          changedBy: null,
          source: 'startup_seed',
        },
      ],
    });

    return {
      seeded: true,
      referralRewardAmount: defaultRewardAmount,
    };
  } catch (error) {
    if (error?.code === 11000) {
      const persistedSettings = await AppSetting.findOne({ key: REFERRAL_SETTINGS_KEY }).select(
        'referralRewardAmount',
      );

      return {
        seeded: false,
        referralRewardAmount: Number(
          persistedSettings?.referralRewardAmount || defaultRewardAmount,
        ),
      };
    }

    throw error;
  }
};

const buildReferralBaseUrl = () => {
  const rawBaseUrl =
    process.env.PUBLIC_REFERRAL_BASE_URL ||
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    process.env.APP_URL ||
    DEFAULT_PUBLIC_REFERRAL_BASE_URL;

  return rawBaseUrl.replace(/\/+$/, '');
};

const buildReferralLink = (referralCode) =>
  `${buildReferralBaseUrl()}/signup?ref=${encodeURIComponent(referralCode)}`;

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const createRandomCharacters = (length) => {
  const randomBytes = crypto.randomBytes(length);

  return Array.from(randomBytes, (byte) => REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length]).join('');
};

const createCandidateCode = (userLike = {}) => {
  const prefixSource = `${userLike.firstName || ''}${userLike.lastName || ''}`
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  const prefix = (prefixSource.slice(0, 4) || 'NGO').padEnd(4, 'X');

  return `${prefix}${createRandomCharacters(4)}`;
};

const generateUniqueReferralCode = async (userLike = {}) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidateCode = createCandidateCode(userLike);
    const existingUser = await User.exists({
      referralCode: candidateCode,
      _id: { $ne: userLike._id },
    });

    if (!existingUser) {
      return candidateCode;
    }
  }

  return `${Date.now().toString(36)}${createRandomCharacters(4)}`.slice(0, 10).toUpperCase();
};

const ensureReferralCode = async (userDoc) => {
  if (!userDoc) {
    throw new Error('User document is required to prepare a referral code.');
  }

  if (userDoc.referralCode && normalizeReferralCode(userDoc.referralCode)) {
    const normalizedCode = normalizeReferralCode(userDoc.referralCode);
    if (normalizedCode !== userDoc.referralCode) {
      userDoc.referralCode = normalizedCode;
      await userDoc.save();
    }
    return normalizedCode;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    userDoc.referralCode = await generateUniqueReferralCode(userDoc);

    try {
      await userDoc.save();
      return userDoc.referralCode;
    } catch (error) {
      const isReferralCollision =
        error?.code === 11000 && String(error?.message || '').includes('referralCode');

      if (!isReferralCollision) {
        throw error;
      }
    }
  }

  throw new Error('Unable to allocate a unique referral code right now.');
};

const findUserByReferralCode = async (rawCode) => {
  const normalizedCode = normalizeReferralCode(rawCode);

  if (!normalizedCode) {
    return null;
  }

  const directMatch = await User.findOne({ referralCode: normalizedCode });
  if (directMatch) {
    return directMatch;
  }

  const caseInsensitiveMatch = await User.findOne({
    referralCode: {
      $regex: `^${escapeRegex(normalizedCode)}$`,
      $options: 'i',
    },
  });

  if (
    caseInsensitiveMatch &&
    normalizeReferralCode(caseInsensitiveMatch.referralCode) !==
      caseInsensitiveMatch.referralCode
  ) {
    caseInsensitiveMatch.referralCode = normalizeReferralCode(
      caseInsensitiveMatch.referralCode,
    );
    await caseInsensitiveMatch.save();
  }

  return caseInsensitiveMatch;
};

const buildInviteName = (user) => {
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return fullName || user.email || user.phoneNumber || 'NaijaGo member';
};

const mapInviteActivity = (user, rewardPerReferral) => {
  const isRewarded = Boolean(user.referralRewardGrantedAt);
  const rewardAmount = isRewarded
    ? Number.isFinite(Number(user.referralRewardAmount))
      ? Number(user.referralRewardAmount)
      : rewardPerReferral
    : 0;

  return {
    name: buildInviteName(user),
    email: user.email || '',
    phoneNumber: user.phoneNumber || '',
    status: !user.isEmailVerified
      ? 'Pending'
      : isRewarded
        ? 'Purchased'
        : 'Signed up',
    rewardAmount,
    invitedAt: user.referredAt || user.createdAt || null,
  };
};

const buildUnprocessedRewardFilter = () => ({
  $or: [
    { referralRewardGrantedAt: { $exists: false } },
    { referralRewardGrantedAt: null },
  ],
});

const buildRewardNotificationMessage = (referredUser, rewardAmount) => {
  const referredName = buildInviteName(referredUser);
  if (rewardAmount > 0) {
    return `Referral reward earned: ₦${rewardAmount.toFixed(2)} for ${referredName}.`;
  }

  return `${referredName} joined through your referral link.`;
};

const grantReferralRewardForVerifiedUser = async (referredUserLike) => {
  const referredUserId = referredUserLike?._id || referredUserLike;
  if (!referredUserId) {
    return { granted: false, reason: 'missing_referred_user' };
  }

  const referredUser = await User.findById(referredUserId).select(
    'firstName lastName email phoneNumber referredBy isEmailVerified referralRewardGrantedAt referralRewardAmount',
  );

  if (!referredUser) {
    return { granted: false, reason: 'referred_user_not_found' };
  }

  if (!referredUser.referredBy) {
    return { granted: false, reason: 'no_inviter' };
  }

  if (!referredUser.isEmailVerified) {
    return { granted: false, reason: 'not_verified' };
  }

  if (referredUser.referralRewardGrantedAt) {
    return { granted: false, reason: 'already_processed' };
  }

  const hasPaidOrder = await MainOrder.exists({
    user: referredUser._id,
    isPaid: true,
  });

  if (!hasPaidOrder) {
    return { granted: false, reason: 'no_paid_order' };
  }

  const inviter = await User.findById(referredUser.referredBy).select('_id');
  if (!inviter) {
    return { granted: false, reason: 'inviter_not_found' };
  }

  const rewardAmount = await getRewardPerReferral();
  const processedAt = new Date();
  const claimedReferral = await User.findOneAndUpdate(
    {
      _id: referredUser._id,
      referredBy: inviter._id,
      isEmailVerified: true,
      ...buildUnprocessedRewardFilter(),
    },
    {
      $set: {
        referralRewardGrantedAt: processedAt,
        referralRewardAmount: rewardAmount,
      },
    },
    { new: true },
  );

  if (!claimedReferral) {
    return { granted: false, reason: 'already_processed' };
  }

  const inviterUpdate = {
    $push: {
      notifications: {
        type: rewardAmount > 0 ? 'referral_reward' : 'general',
        message: buildRewardNotificationMessage(referredUser, rewardAmount),
        read: false,
        createdAt: processedAt,
        relatedId: claimedReferral._id,
        relatedModel: 'User',
      },
    },
  };

  if (rewardAmount > 0) {
    inviterUpdate.$inc = { userWalletBalance: rewardAmount };
  }

  const updatedInviter = await User.findByIdAndUpdate(inviter._id, inviterUpdate, {
    new: true,
  }).select('_id');

  if (!updatedInviter) {
    await User.findByIdAndUpdate(claimedReferral._id, {
      $unset: {
        referralRewardGrantedAt: 1,
        referralRewardAmount: 1,
      },
    });

    return { granted: false, reason: 'inviter_update_failed' };
  }

  return {
    granted: true,
    rewardAmount,
    referredUserId: claimedReferral._id,
    inviterId: inviter._id,
  };
};

const reconcileReferralRewardsForInviter = async (inviterLike) => {
  const inviterId = inviterLike?._id || inviterLike;
  if (!inviterId) {
    return { grantedCount: 0 };
  }

  const pendingRewardUsers = await User.find({
    referredBy: inviterId,
    isEmailVerified: true,
    ...buildUnprocessedRewardFilter(),
  })
    .select('_id')
    .lean();

  let grantedCount = 0;

  for (const pendingRewardUser of pendingRewardUsers) {
    const result = await grantReferralRewardForVerifiedUser(pendingRewardUser._id);
    if (result.granted) {
      grantedCount += 1;
    }
  }

  return { grantedCount };
};

const buildReferralSummary = async (userDoc) => {
  const referralCode = await ensureReferralCode(userDoc);
  const rewardPerReferral = await getRewardPerReferral();
  await reconcileReferralRewardsForInviter(userDoc);

  const [totalInvites, successfulInvites, earnedSummary, recentInviteUsers] =
    await Promise.all([
    User.countDocuments({ referredBy: userDoc._id }),
    User.countDocuments({
      referredBy: userDoc._id,
      referralRewardGrantedAt: { $exists: true, $ne: null },
    }),
    User.aggregate([
      {
        $match: {
          referredBy: userDoc._id,
          referralRewardGrantedAt: { $exists: true, $ne: null },
        },
      },
      {
        $group: {
          _id: null,
          totalEarned: { $sum: { $ifNull: ['$referralRewardAmount', 0] } },
          rewardedInvites: { $sum: 1 },
        },
      },
    ]),
    User.find({ referredBy: userDoc._id })
      .select(
        'firstName lastName email phoneNumber isEmailVerified createdAt referredAt referralRewardGrantedAt referralRewardAmount',
      )
      .sort({ referredAt: -1, createdAt: -1 })
      .limit(RECENT_INVITES_LIMIT)
      .lean(),
    ]);

  const pendingInvites = Math.max(totalInvites - successfulInvites, 0);
  const recentInvites = recentInviteUsers.map((inviteUser) =>
    mapInviteActivity(inviteUser, rewardPerReferral),
  );
  const totalEarned = earnedSummary[0]?.totalEarned || 0;
  const rewardedInvites = earnedSummary[0]?.rewardedInvites || 0;

  return {
    referralCode,
    referralLink: buildReferralLink(referralCode),
    totalInvites,
    totalReferrals: totalInvites,
    successfulInvites,
    successfulReferrals: successfulInvites,
    pendingInvites,
    pendingReferrals: pendingInvites,
    totalEarned,
    rewardedInvites,
    rewardPerReferral,
    recentInvites,
    recentReferrals: recentInvites,
  };
};

module.exports = {
  buildReferralSummary,
  ensureReferralCode,
  findUserByReferralCode,
  generateUniqueReferralCode,
  getReferralProgramSettings,
  initializeReferralProgramSettings,
  grantReferralRewardForVerifiedUser,
  normalizeReferralCode,
  reconcileReferralRewardsForInviter,
};

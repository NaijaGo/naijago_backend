const AppSetting = require('../models/AppSetting');

const SETTINGS_KEY = 'food_readiness_campaigns';
const mealDefaults = {
  breakfast: {
    title: 'Breakfast is ready',
    message: 'Start the day with ready meals from Abuja restaurants.',
    startTime: '06:00',
    endTime: '11:00',
  },
  lunch: {
    title: 'Lunch is ready',
    message: 'It is lunch time. Ready meals are waiting from Abuja restaurants.',
    startTime: '12:00',
    endTime: '16:00',
  },
  dinner: {
    title: 'Dinner is ready',
    message: 'Dinner options are ready now from Abuja restaurants.',
    startTime: '18:00',
    endTime: '22:00',
  },
};

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizeText(value, fallback, max = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback || '').slice(0, max);
}

function normalizeCampaign(raw = {}) {
  const mealType = ['breakfast', 'lunch', 'dinner'].includes(raw.mealType)
    ? raw.mealType
    : 'breakfast';
  const defaults = mealDefaults[mealType];
  return {
    mealType,
    title: sanitizeText(raw.title, defaults.title, 80),
    message: sanitizeText(raw.message, defaults.message, 240),
    imageUrl: sanitizeText(raw.imageUrl, '', 500),
    city: sanitizeText(raw.city, 'Abuja', 80),
    startTime: timePattern.test(raw.startTime || '')
      ? raw.startTime
      : defaults.startTime,
    endTime: timePattern.test(raw.endTime || '') ? raw.endTime : defaults.endTime,
    isActive: raw.isActive !== false,
    updatedAt: new Date(),
  };
}

function defaultCampaigns() {
  return Object.entries(mealDefaults).map(([mealType, defaults]) =>
    normalizeCampaign({
      mealType,
      ...defaults,
      city: 'Abuja',
      isActive: true,
    }),
  );
}

async function getFoodReadinessCampaigns() {
  let setting = await AppSetting.findOne({ key: SETTINGS_KEY }).select(
    'foodReadinessCampaigns',
  );
  if (!setting) {
    setting = await AppSetting.create({
      key: SETTINGS_KEY,
      foodReadinessCampaigns: defaultCampaigns(),
    });
  }
  return setting.foodReadinessCampaigns?.length
    ? setting.foodReadinessCampaigns
    : defaultCampaigns();
}

function minutesFromTime(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (hours * 60) + minutes;
}

function inTimeWindow(nowMinutes, startTime, endTime) {
  const start = minutesFromTime(startTime);
  const end = minutesFromTime(endTime);
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes <= end;
  return nowMinutes >= start || nowMinutes <= end;
}

async function getActiveFoodReadinessCampaign({ city = '', now = new Date() } = {}) {
  const cityLower = String(city || '').trim().toLowerCase();
  const campaigns = await getFoodReadinessCampaigns();
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  return campaigns.find((campaign) => {
    if (campaign.isActive === false) return false;
    const campaignCity = String(campaign.city || '').trim().toLowerCase();
    if (campaignCity && cityLower && campaignCity !== cityLower) return false;
    if (campaignCity && !cityLower) return false;
    return inTimeWindow(nowMinutes, campaign.startTime, campaign.endTime);
  }) || null;
}

async function updateFoodReadinessCampaigns(campaigns, updatedBy) {
  const normalized = Array.isArray(campaigns)
    ? campaigns.map(normalizeCampaign)
    : defaultCampaigns();
  const setting = await AppSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        foodReadinessCampaigns: normalized,
        updatedBy,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).select('foodReadinessCampaigns');
  return setting.foodReadinessCampaigns;
}

module.exports = {
  getFoodReadinessCampaigns,
  getActiveFoodReadinessCampaign,
  updateFoodReadinessCampaigns,
};

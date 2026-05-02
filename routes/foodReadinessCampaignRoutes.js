const express = require('express');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  getActiveFoodReadinessCampaign,
  getFoodReadinessCampaigns,
  updateFoodReadinessCampaigns,
} = require('../services/foodReadinessCampaignService');

const router = express.Router();

router.get('/active', async (req, res) => {
  try {
    const campaign = await getActiveFoodReadinessCampaign({
      city: req.query.city,
    });
    res.status(200).json({ campaign });
  } catch (error) {
    console.error('Error fetching active food readiness campaign:', error);
    res.status(500).json({ message: 'Failed to fetch food readiness campaign.' });
  }
});

router.get('/admin', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const campaigns = await getFoodReadinessCampaigns();
    res.status(200).json({ campaigns });
  } catch (error) {
    console.error('Error fetching food readiness campaigns:', error);
    res.status(500).json({ message: 'Failed to fetch food readiness campaigns.' });
  }
});

router.put('/admin', protect, authorizeRoles('admin'), async (req, res) => {
  try {
    const campaigns = await updateFoodReadinessCampaigns(
      req.body.campaigns,
      req.user._id,
    );
    res.status(200).json({
      message: 'Food readiness campaigns updated.',
      campaigns,
    });
  } catch (error) {
    console.error('Error updating food readiness campaigns:', error);
    res.status(500).json({ message: 'Failed to update food readiness campaigns.' });
  }
});

module.exports = router;

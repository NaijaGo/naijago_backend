const express = require('express');
const service = require('../services/vendorCommissionService');
const lowCostService = require('../services/lowCostCommissionService');

// Mounted exclusively behind the existing protect + authorizeAdmin middleware.
function createVendorCommissionRouter({ settingsService = service, lowCostSettingsService = lowCostService } = {}) {
    const router = express.Router();
    function failure(res, error) {
        const status = error.statusCode || 500;
        return res.status(status).json({ message: error.statusCode ? error.message : 'Commission settings are temporarily unavailable.' });
    }
    router.get('/', async (req, res) => {
        try { return res.json(await settingsService.getSettings()); }
        catch (error) { return failure(res, error); }
    });
    router.put('/', async (req, res) => {
        try { return res.json(await settingsService.updateSettings(req.body, req.user._id)); }
        catch (error) { return failure(res, error); }
    });
    router.get('/low-cost-world', async (req, res) => {
        try { return res.json(await lowCostSettingsService.getSettings()); }
        catch (error) { return failure(res, error); }
    });
    router.put('/low-cost-world', async (req, res) => {
        try { return res.json(await lowCostSettingsService.updateSettings(req.body, req.user._id)); }
        catch (error) { return failure(res, error); }
    });
    return router;
}
module.exports = { createVendorCommissionRouter };

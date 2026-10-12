const express = require('express');
const service = require('../services/vendorCommissionService');

// Mounted exclusively behind the existing protect + authorizeAdmin middleware.
function createVendorCommissionRouter({ settingsService = service } = {}) {
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
    return router;
}
module.exports = { createVendorCommissionRouter };

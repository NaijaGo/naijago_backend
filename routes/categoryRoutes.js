const express = require('express');
const mongoose = require('mongoose');
const Category = require('../models/Category');
const taxonomy = require('../services/catalogTaxonomyService');
function createCategoryRouter({ readiness = () => taxonomy.databaseReadiness({ Category, connection: mongoose.connection }) } = {}) {
    const router = express.Router();
    router.get('/', async (_req, res) => {
        let ready = false;
        try { ready = await readiness(); } catch (_) { /* Valid manifest remains available. */ }
        res.set('Cache-Control', 'no-store').json(taxonomy.hierarchy(ready));
    });
    return router;
}
module.exports = createCategoryRouter();
module.exports.createCategoryRouter = createCategoryRouter;

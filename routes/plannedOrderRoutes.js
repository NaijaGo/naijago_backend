'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { PlanningError } = require('../utils/orderPlanningPolicy');

function createPlannedOrderRouter({
    runtime,
    authenticate = protect,
}) {
    const router = express.Router();
    const wrap = (work) => async (req, res) => {
        try {
            await work(req, res);
        } catch (error) {
            const safe = error instanceof PlanningError;
            const status = safe && [400, 403, 404, 409, 429, 503].includes(error.statusCode)
                ? error.statusCode : 503;
            if (!safe) console.error('Planned order operation unavailable', { name: error.name, code: error.code });
            res.status(status).json({
                message: safe ? error.message : 'Order planning is temporarily unavailable. Please try again.',
                ...(safe ? { code: error.code } : {}),
            });
        }
    };
    const available = async () => runtime.enabled() && await runtime.ready();
    router.get('/config', wrap(async (_req, res) => res.json({
        enabled: await available(),
        timeZone: 'Africa/Lagos',
        automaticCharges: false,
        paymentMode: 'reminder_to_pay',
    })));
    router.use(authenticate);
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.user.constructor?.modelName !== 'User' || req.user.isVendor || req.user.isAdmin) {
            return res.status(403).json({ message: 'Use a customer account for planned orders.' });
        }
        next();
    });
    router.use(rateLimit({
        windowMs: 60000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id),
        message: { message: 'Please wait before checking planned orders again.' },
    }));
    router.use(async (_req, res, next) => {
        try {
            if (await available()) return next();
        } catch (_) {}
        return res.status(503).json({ message: 'Order planning is not enabled yet.' });
    });
    const writes = rateLimit({
        windowMs: 60000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
        keyGenerator: (req) => String(req.user._id),
        message: { message: 'Too many changes. Please wait a minute.' },
    });
    const actor = (req) => req.user._id;
    const displayName = (req) => [req.user.firstName, req.user.lastName].filter(Boolean).join(' ').trim() || 'NaijaGo customer';
    const service = () => runtime.services();

    router.get('/groups', wrap(async (req, res) => res.json(await service().groups.list({
        actor: actor(req), before: req.query.before, limit: req.query.limit || 20,
    }))));
    router.post('/groups', writes, wrap(async (req, res) => res.status(201).json(await service().groups.create({
        actor: actor(req), displayName: displayName(req), input: req.body || {},
    }))));
    router.post('/groups/join', writes, wrap(async (req, res) => res.json(await service().groups.join({
        token: req.body?.token, actor: actor(req), displayName: displayName(req),
    }))));
    router.get('/groups/:id', wrap(async (req, res) => res.json(await service().groups.get({
        groupId: req.params.id, actor: actor(req),
    }))));
    router.post('/groups/:id/invite', writes, wrap(async (req, res) => res.json(await service().groups.rotateInvite({
        groupId: req.params.id, actor: actor(req), revision: req.body?.revision,
    }))));
    router.put('/groups/:id/items', writes, wrap(async (req, res) => res.json(await service().groups.edit({
        groupId: req.params.id, actor: actor(req), revision: req.body?.revision, items: req.body?.items,
    }))));
    router.post('/groups/:id/control', writes, wrap(async (req, res) => res.json(await service().groups.control({
        groupId: req.params.id, actor: actor(req), revision: req.body?.revision,
        action: req.body?.action, memberId: req.body?.memberId, cutoffAt: req.body?.cutoffAt,
    }))));
    router.post('/groups/:id/quote', writes, wrap(async (req, res) => res.json(await service().groups.quote({
        groupId: req.params.id, actor: actor(req), revision: req.body?.revision,
    }))));
    router.post('/groups/:id/checkout', writes, wrap(async (req, res) => res.status(201).json(await service().checkoutGroup({
        groupId: req.params.id, actor: actor(req), revision: req.body?.revision,
        approvalToken: req.body?.approvalToken, paymentMethod: req.body?.paymentMethod,
    }))));

    router.get('/recurring', wrap(async (req, res) => res.json(await service().recurring.list({
        actor: actor(req), before: req.query.before, limit: req.query.limit || 20,
    }))));
    router.post('/recurring', writes, wrap(async (req, res) => res.status(201).json(await service().recurring.create({
        actor: actor(req), input: req.body || {},
    }))));
    router.get('/recurring/:id', wrap(async (req, res) => res.json(await service().recurring.get({
        planId: req.params.id, actor: actor(req),
    }))));
    router.put('/recurring/:id', writes, wrap(async (req, res) => res.json(await service().recurring.editFuture({
        planId: req.params.id, actor: actor(req), revision: req.body?.revision, input: req.body || {},
    }))));
    router.post('/recurring/:id/control', writes, wrap(async (req, res) => res.json(await service().recurring.control({
        planId: req.params.id, actor: actor(req), revision: req.body?.revision,
        action: req.body?.action, pauseUntil: req.body?.pauseUntil,
    }))));
    router.post('/occurrences/:id/control', writes, wrap(async (req, res) => res.json(await service().recurring.editOccurrence({
        occurrenceId: req.params.id, actor: actor(req), revision: req.body?.revision,
        action: req.body?.action, input: req.body || {},
    }))));
    router.post('/occurrences/:id/quote', writes, wrap(async (req, res) => res.json(await service().recurring.quote({
        occurrenceId: req.params.id, actor: actor(req), revision: req.body?.revision,
    }))));
    router.post('/occurrences/:id/checkout', writes, wrap(async (req, res) => res.status(201).json(await service().checkoutRecurring({
        occurrenceId: req.params.id, actor: actor(req), revision: req.body?.revision,
        approvalToken: req.body?.approvalToken, paymentMethod: req.body?.paymentMethod,
    }))));
    return router;
}

const runtime = require('../services/plannedOrderRuntime');
module.exports = createPlannedOrderRouter({ runtime });
module.exports.createPlannedOrderRouter = createPlannedOrderRouter;

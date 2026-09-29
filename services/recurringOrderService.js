'use strict';
const { fail, id, integer, instant, normalizeRecurrence, occurrenceAt } = require('../utils/orderPlanningPolicy');
const { normalizeItems } = require('../utils/groupOrderPolicy');
const { assertCreatedOrder, totalKobo } = require('../utils/plannedCheckoutApproval');
const DAY = 86400000;

function createRecurringOrderService({ Plan, Occurrence, connection, queue, validateOccurrence, validateTemplate, checkout, now = () => new Date() }) {
    if (!queue?.enqueue || typeof validateOccurrence !== 'function' || typeof validateTemplate !== 'function') throw new TypeError('Recurring orders require the notification outbox and authoritative catalog/checkout validation.');
    async function validatedItems(items, session) {
        const result = await validateTemplate({ items: normalizeItems(items), session });
        if (!Array.isArray(result?.items) || !result.items.length) fail('VALIDATION_UNAVAILABLE', 'Catalog validation is unavailable.', 503);
        return normalizeItems(result.items);
    }
    async function transaction(work) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { return await connection.transaction(work); }
            catch (error) { if (error.code !== 11000 || attempt === 2) throw error; }
        }
    }
    const notify = (row, event, session) => queue.enqueue({ type: 'recurring.notify',
        dedupeKey: `${row._id}:${row.revision}:${event}`, owner: row.owner,
        payload: { occurrenceId: String(row._id), event }, maxAttempts: 5 }, { session });
    async function owned(planId, actor, session) {
        const plan = await Plan.findOne({ _id: id(planId), owner: id(actor) }).select('+destination').session(session);
        if (!plan) fail('PLAN_NOT_FOUND', 'Recurring plan not found.', 404);
        return plan;
    }
    function audit(row, actor, action) {
        if (row.history.length >= 2000) fail('PLAN_EDIT_LIMIT', 'This plan has reached its edit limit. Please create a new plan.', 409);
        row.revision += 1; row.history.push({ action, actor, at: now(), revision: row.revision });
    }
    function nextDate(plan) {
        if (plan.nextIndex >= 1000) return null;
        const next = occurrenceAt(plan.rule.toObject ? plan.rule.toObject() : plan.rule, plan.nextIndex);
        return next ? new Date(next.startAt.getTime() - plan.reminderLeadDays * DAY) : null;
    }
    async function create({ actor, input }) {
        id(actor); const rule = normalizeRecurrence(input.rule); const items = normalizeItems(input.items);
        if (!items.length) fail('EMPTY_PLAN', 'Add at least one product to the recurring plan.');
        const reminderLeadDays = integer(input.reminderLeadDays ?? 3, 1, 7, 'reminder lead time');
        if (occurrenceAt(rule, 0).startAt <= now()) fail('INVALID_START', 'Choose a future first delivery.');
        return connection.transaction(async (session) => {
            // A template does not freeze prices, reserve stock or authorize charges.
            const plan = new Plan({ owner: actor, name: input.name, items: await validatedItems(items, session), destination: input.destination, rule,
                substitutionPreference: input.substitutionPreference || 'do_not_replace',
                priceApprovalPercent: input.priceApprovalPercent ?? 0, priceApprovalKobo: input.priceApprovalKobo ?? 0,
                reminderLeadDays, nextGenerateAt: new Date(occurrenceAt(rule, 0).startAt - reminderLeadDays * DAY) });
            audit(plan, actor, 'plan_created'); await plan.save({ session }); return plan.toObject();
        });
    }
    async function get({ planId, actor }) {
        const plan = await owned(planId, actor, null);
        const occurrences = await Occurrence.find({ plan: plan._id, owner: actor }).sort({ number: -1 }).limit(30).lean();
        return { plan: plan.toObject(), occurrences };
    }
    async function list({ actor, before, limit = 20 }) {
        const owner = id(actor); const safeLimit = integer(Number(limit), 1, 30, 'page size');
        const filter = { owner };
        if (before) filter._id = { $lt: id(before) };
        const rows = await Plan.find(filter).sort({ _id: -1 }).limit(safeLimit + 1).lean();
        return {
            plans: rows.slice(0, safeLimit),
            nextCursor: rows.length > safeLimit ? String(rows[safeLimit - 1]._id) : null,
        };
    }
    async function control({ planId, actor, revision, action, pauseUntil }) {
        integer(revision, 0, Number.MAX_SAFE_INTEGER, 'plan revision');
        return connection.transaction(async (session) => {
            const plan = await owned(planId, actor, session);
            if (plan.revision !== revision) fail('PLAN_CHANGED', 'This plan changed. Refresh before editing.', 409);
            if (['cancelled', 'completed'].includes(plan.state)) fail('PLAN_CLOSED', 'This recurring plan is closed.', 409);
            if (action === 'pause') {
                const until = pauseUntil ? instant(pauseUntil) : null;
                if (until && until <= now()) fail('INVALID_PAUSE', 'Choose a future resume date.');
                plan.state = 'paused'; plan.pauseUntil = until;
            } else if (action === 'resume') { plan.state = 'active'; plan.pauseUntil = null; }
            else if (action === 'cancel') {
                plan.state = 'cancelled'; plan.pauseUntil = null;
                // Paid/checkout orders follow normal order cancellation, never
                // silently cancel or refund them by cancelling the template.
                const rows = await Occurrence.find({ plan: plan._id, state: { $in: ['awaiting_review', 'needs_attention'] } }).session(session);
                for (const row of rows) { row.state = 'cancelled'; audit(row, actor, 'occurrence_cancelled'); await row.save({ session }); await notify(row, 'occurrence_cancelled', session); }
            } else fail('INVALID_ACTION', 'Unsupported recurring plan action.');
            audit(plan, actor, `plan_${action}`); await plan.save({ session }); return plan.toObject();
        });
    }
    async function editFuture({ planId, actor, revision, input }) {
        integer(revision, 0, Number.MAX_SAFE_INTEGER, 'plan revision');
        return connection.transaction(async (session) => {
            const plan = await owned(planId, actor, session);
            if (!['active', 'paused'].includes(plan.state) || plan.revision !== revision) fail('PLAN_CHANGED', 'Refresh this active plan before editing.', 409);
            // Dates keep their original recurrence anchor. Changing frequency or
            // anchor requires a new plan, until the rescheduling flow is wired.
            if (input.rule || input.paymentMode) fail('PLAN_SCHEDULE_LOCKED', 'Create a new plan to change its repeat schedule.');
            if (input.items !== undefined) plan.items = await validatedItems(input.items, session);
            if (input.destination !== undefined) plan.destination = input.destination;
            for (const field of ['name', 'substitutionPreference', 'priceApprovalPercent', 'priceApprovalKobo']) if (input[field] !== undefined) plan[field] = input[field];
            audit(plan, actor, 'future_orders_edited'); await plan.save({ session });
            const pending = await Occurrence.find({ plan: plan._id, state: { $in: ['awaiting_review', 'needs_attention'] }, startAt: { $gt: now() } }).session(session);
            for (const row of pending) {
                if (input.items !== undefined) row.items = plan.items;
                if (input.destination !== undefined) row.destination = plan.destination;
                row.planRevision = plan.revision; row.state = 'needs_attention'; row.attentionCode = 'revalidation_required';
                row.estimatedTotalKobo = null; row.estimatedAt = null;
                audit(row, actor, 'future_order_updated'); await row.save({ session }); await notify(row, 'future_order_updated', session);
            }
            return plan.toObject();
        });
    }
    async function editOccurrence({ occurrenceId, actor, revision, action, input = {} }) {
        integer(revision, 0, Number.MAX_SAFE_INTEGER, 'occurrence revision');
        return connection.transaction(async (session) => {
            const row = await Occurrence.findOne({ _id: id(occurrenceId), owner: id(actor) }).select('+destination').session(session);
            if (!row) fail('OCCURRENCE_NOT_FOUND', 'Upcoming order not found.', 404);
            const plan = await owned(String(row.plan), actor, session);
            if (!['active', 'paused'].includes(plan.state) || !['awaiting_review', 'needs_attention'].includes(row.state) || row.startAt <= now() || row.revision !== revision) fail('OCCURRENCE_LOCKED', 'This occurrence can no longer be edited here.', 409);
            if (action === 'skip') row.state = 'skipped';
            else if (action === 'edit') {
                if (input.items !== undefined) row.items = await validatedItems(input.items, session);
                if (input.destination !== undefined) row.destination = input.destination;
                row.state = 'needs_attention'; row.attentionCode = 'revalidation_required'; row.estimatedTotalKobo = null;
            } else fail('INVALID_ACTION', 'Unsupported occurrence action.');
            audit(row, actor, `occurrence_${action}`); await row.save({ session }); await notify(row, `occurrence_${action}`, session); return row.toObject();
        });
    }
    async function generate(planId, signal) {
        return transaction(async (session) => {
            signal?.throwIfAborted();
            const plan = await Plan.findById(id(planId)).select('+destination').session(session);
            if (!plan || !['active', 'paused'].includes(plan.state)) return null;
            if (plan.state === 'paused') {
                if (!plan.pauseUntil || plan.pauseUntil > now()) return null;
                plan.state = 'active'; plan.pauseUntil = null; audit(plan, plan.owner, 'plan_resumed');
            }
            if (plan.nextGenerateAt > now()) { if (plan.isModified()) await plan.save({ session }); return null; }
            let occurrence = plan.nextIndex < 1000 ? occurrenceAt(plan.rule.toObject(), plan.nextIndex) : null;
            // Missed or paused dates are not back-charged or dispatched. Advance
            // from the original anchor; work is bounded to 1000 occurrences.
            while (occurrence && occurrence.startAt <= now()) {
                plan.nextIndex += 1;
                occurrence = plan.nextIndex < 1000 ? occurrenceAt(plan.rule.toObject(), plan.nextIndex) : null;
            }
            if (!occurrence) { plan.state = 'completed'; audit(plan, plan.owner, 'plan_completed'); await plan.save({ session }); return null; }
            const dueAt = new Date(occurrence.startAt - plan.reminderLeadDays * DAY);
            if (dueAt > now()) { plan.nextGenerateAt = dueAt; await plan.save({ session }); return null; }
            let row = await Occurrence.findOne({ plan: plan._id, number: occurrence.number }).session(session);
            if (!row) {
                row = new Occurrence({ plan: plan._id, owner: plan.owner, number: occurrence.number, planRevision: plan.revision,
                    startAt: occurrence.startAt, endAt: occurrence.endAt, items: plan.items, destination: plan.destination });
                const quote = await validateOccurrence({ plan, occurrence: row, session });
                if (!quote || typeof quote.eligible !== 'boolean') fail('VALIDATION_UNAVAILABLE', 'Order validation is unavailable.', 503);
                row.state = quote.eligible ? 'awaiting_review' : 'needs_attention';
                row.attentionCode = quote.eligible ? '' : 'commercial_conditions_changed';
                row.estimatedTotalKobo = quote.eligible ? integer(quote.totalKobo, 0, Number.MAX_SAFE_INTEGER, 'estimated total') : null;
                row.estimatedAt = now(); audit(row, plan.owner, 'occurrence_generated'); signal?.throwIfAborted();
                await row.save({ session }); await notify(row, 'occurrence_generated', session);
            }
            plan.nextIndex += 1;
            const next = nextDate(plan);
            // Exhausted templates stop generating but the last unpaid occurrence
            // remains actionable; completion is finalized after it is resolved.
            plan.nextGenerateAt = next || new Date(occurrence.endAt.getTime() + DAY);
            audit(plan, plan.owner, 'occurrence_generated'); await plan.save({ session }); return row.toObject();
        });
    }
    async function generateDue({ signal, limit = 20 } = {}) {
        integer(limit, 1, 50, 'generation batch size');
        const plans = await Plan.find({ $or: [{ state: 'active', nextGenerateAt: { $lte: now() } }, { state: 'paused', pauseUntil: { $ne: null, $lte: now() } }] })
            .sort({ nextGenerateAt: 1 }).limit(limit).select('_id').lean();
        for (const plan of plans) { signal?.throwIfAborted(); await generate(String(plan._id), signal); }
        return plans.length;
    }
    function requireCheckout() {
        if (!checkout?.quoteOccurrence || !checkout?.approval?.issue || !checkout?.approval?.verify) fail('CHECKOUT_UNAVAILABLE', 'Recurring checkout is not ready.', 503);
    }
    const quoteContext = (row, plan) => ({ kind: 'recurring', owner: String(row.owner), recordId: String(row._id), revision: row.revision,
        planId: String(plan._id), planRevision: plan.revision, startAt: row.startAt, endAt: row.endAt, destination: row.destination });
    async function forCheckout({ occurrenceId, actor, revision, session }) {
        const row = await Occurrence.findOne({ _id: id(occurrenceId), owner: id(actor) }).select('+destination').session(session || null);
        if (!row) fail('OCCURRENCE_NOT_FOUND', 'Upcoming order not found.', 404);
        const plan = await owned(String(row.plan), actor, session || null);
        if (['checkout', 'ordered'].includes(row.state) && row.order) return { row, plan, reused: true };
        if (plan.state !== 'active' || !['awaiting_review', 'needs_attention'].includes(row.state) || row.startAt <= now() ||
            row.revision !== integer(revision, 0, Number.MAX_SAFE_INTEGER, 'occurrence revision')) fail('OCCURRENCE_LOCKED', 'Refresh this active upcoming order before checkout.', 409);
        return { row, plan, reused: false };
    }
    async function quote(args) {
        requireCheckout(); const { row, plan, reused } = await forCheckout(args);
        if (reused) fail('OCCURRENCE_LOCKED', 'Continue payment from the existing order.', 409);
        const current = await checkout.quoteOccurrence({ occurrence: row, plan });
        const increaseKobo = row.estimatedTotalKobo == null ? null : Math.max(0, totalKobo(current) - row.estimatedTotalKobo);
        const increasePercent = increaseKobo == null ? null : row.estimatedTotalKobo > 0 ? increaseKobo / row.estimatedTotalKobo * 100 : increaseKobo > 0 ? null : 0;
        return { ...checkout.approval.issue({ context: quoteContext(row, plan), quote: current }), priceChange: {
            previousEstimateKobo: row.estimatedTotalKobo, increaseKobo, increasePercent,
            requiresAttention: increaseKobo == null || increaseKobo > plan.priceApprovalKobo || (increaseKobo > 0 && (increasePercent == null || increasePercent > plan.priceApprovalPercent)),
        } }; // Always explicit approval/payment, even below notification thresholds.
    }
    async function checkoutOrder({ occurrenceId, actor, revision, approvalToken, session, createOrder }) {
        if (!session?.inTransaction() || typeof createOrder !== 'function') fail('TRANSACTION_REQUIRED', 'Checkout must use the order transaction.', 500);
        const { row, plan, reused } = await forCheckout({ occurrenceId, actor, revision, session });
        if (reused) return { orderId: String(row.order), reused: true };
        requireCheckout();
        const current = await checkout.quoteOccurrence({ occurrence: row, plan, session });
        checkout.approval.verify({ context: quoteContext(row, plan), quote: current, token: approvalToken });
        // A write on the plan serializes checkout against pause/cancel/template
        // edits. Merely reading it in a snapshot would allow write skew with a
        // concurrent plan-control transaction that touches a different document.
        audit(plan, actor, 'checkout_started'); await plan.save({ session });
        const order = await createOrder({ owner: row.owner, occurrence: row, plan, items: normalizeItems(row.items), quote: current, session });
        assertCreatedOrder({ order, quote: current, owner: row.owner, shipmentCount: current.shipmentSummaries?.length });
        row.order = order._id; row.state = 'checkout'; audit(row, actor, 'checkout_started');
        await row.save({ session }); await notify(row, 'checkout_started', session);
        return { orderId: String(order._id), reused: false };
    }
    return { create, list, get, control, editFuture, editOccurrence, generate, generateDue, quote, checkout: checkoutOrder };
}
module.exports = { createRecurringOrderService };

const crypto = require('crypto');
const Product = require('../models/Product');
const ProductOffer = require('../models/ProductOffer');
const InventoryOperation = require('../models/InventoryOperation');
const DeliveryReservation = require('../models/DeliveryReservation');
const MainOrder = require('../models/MainOrder');

function fail(code, message, statusCode = 409) {
  const error = new Error(message);
  Object.assign(error, { code, statusCode });
  throw error;
}
function integer(value, positive = false) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail('INVALID_INVENTORY_QUANTITY', 'Inventory quantities must be safe integers.', 400);
  }
  return value;
}
function objectId(value) {
  const result = String(value?._id || value || '');
  if (!/^[a-f\d]{24}$/i.test(result)) fail('INVALID_INVENTORY_IDENTITY', 'Invalid inventory identity.', 400);
  return result.toLowerCase();
}
function requireTransaction(session) {
  if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
    fail('INVENTORY_TRANSACTION_REQUIRED', 'Inventory writes require an active MongoDB transaction.', 503);
  }
}
function normalizeAllocations(allocations, { hold = false } = {}) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 100) {
    fail('INVALID_INVENTORY_ALLOCATIONS', 'Provide between 1 and 100 allocations.', 400);
  }
  const merged = new Map();
  for (const input of allocations) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('INVALID_INVENTORY_IDENTITY', 'Invalid inventory allocation.', 400);
    }
    // Immediate orders retain their existing aggregate accounting. Holds cannot
    // imply that variant/size stock is protected by that aggregate accounting.
    if (hold && (input.variantId || (input.selectedSize != null && input.selectedSize !== ''))) {
      fail('UNSUPPORTED_INVENTORY_VARIANT', 'Variant and size reservations are not supported.', 409);
    }
    const allocation = { product: objectId(input.product), offer: input.offer ? objectId(input.offer) : null,
      quantity: integer(input.quantity, true) };
    const key = `${allocation.product}:${allocation.offer || ''}`;
    allocation.quantity += merged.get(key)?.quantity || 0;
    integer(allocation.quantity, true);
    merged.set(key, allocation);
  }
  return [...merged.values()].sort((a, b) => `${a.product}:${a.offer}`.localeCompare(`${b.product}:${b.offer}`));
}
function getAvailableQuantity(document) {
  if (!document || typeof document !== 'object') fail('INVALID_INVENTORY_BALANCE', 'Inventory balance is required.', 400);
  const stock = integer(document.stockQuantity);
  const reserved = integer(document.reservedStockQuantity ?? 0);
  integer(document.inventoryRevision ?? 0);
  if (reserved > stock) fail('INVALID_INVENTORY_BALANCE', 'Inventory requires reconciliation.');
  return stock - reserved;
}
function assertAvailable(document, quantity) {
  integer(quantity, true);
  if (getAvailableQuantity(document) < quantity) fail('INSUFFICIENT_INVENTORY', 'Insufficient available stock.');
}
async function validateInventoryIdentity(allocation, { session, hold = false } = {}) {
  const [identity] = normalizeAllocations([allocation], { hold });
  const product = await Product.findById(identity.product).session(session || null);
  if (!product) fail('INVENTORY_NOT_FOUND', 'Product inventory not found.', 404);
  getAvailableQuantity(product);
  let offer = null;
  if (identity.offer) {
    offer = await ProductOffer.findOne({ _id: identity.offer, product: identity.product }).session(session || null);
    if (!offer) fail('INVALID_INVENTORY_OFFER', 'Offer does not belong to this product.', 400);
    getAvailableQuantity(offer);
  }
  if (hold && (product.variants?.length || product.sizeData?.sizes?.length ||
      product.sizeData?.customDimensions?.length || offer?.variants?.length)) {
    fail('UNSUPPORTED_INVENTORY_VARIANT', 'Products with variant or size inventory cannot be reserved yet.');
  }
  if (hold && (product.productStatus !== 'active' || product.moderationStatus !== 'approved' ||
      (offer && offer.status !== 'active'))) fail('INVENTORY_NOT_ELIGIBLE', 'Inventory is not eligible for reservation.');
  return { identity, product, offer };
}
const reservedExpression = { $ifNull: ['$reservedStockQuantity', 0] };
const availableExpression = { $subtract: ['$stockQuantity', reservedExpression] };
const revisionExpression = { $ifNull: ['$inventoryRevision', 0] };
let receiptIndexVerified = false;
async function requireReceiptIndex() {
  if (receiptIndexVerified) return;
  let indexes;
  try { indexes = await InventoryOperation.collection.indexes(); }
  catch { fail('INVENTORY_INDEX_REQUIRED', 'Inventory receipt indexes must be provisioned before settlement.', 503); }
  if (!indexes.some((index) => index.unique === true && index.key?.businessKey === 1 && Object.keys(index.key).length === 1 &&
      !index.partialFilterExpression && !index.sparse)) {
    fail('INVENTORY_INDEX_REQUIRED', 'A unique inventory business-key index is required.', 503);
  }
  receiptIndexVerified = true;
}

async function receipt({ type, businessKey, allocations, order = null, reservation = null, extra = null, session }, apply) {
  requireTransaction(session);
  await requireReceiptIndex();
  if (typeof businessKey !== 'string' || !businessKey.trim() || businessKey.length > 240) {
    fail('INVALID_INVENTORY_KEY', 'A bounded inventory business key is required.', 400);
  }
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ type, allocations,
    order: order ? objectId(order) : null, reservation: reservation ? objectId(reservation) : null, extra })).digest('hex');
  const existing = await InventoryOperation.findOne({ businessKey }).session(session);
  if (existing) {
    if (existing.requestHash !== requestHash) fail('INVENTORY_OPERATION_CONFLICT', 'Inventory operation key was already used for another request.');
    return existing;
  }
  // Claim before changing balances. Duplicate-key races abort the transaction;
  // callers retry the whole transaction, never an individual stock mutation.
  const [operation] = await InventoryOperation.create([{ businessKey, requestHash, type, allocations, order, reservation }], { session });
  await apply();
  return operation;
}
async function mutateBalances(allocations, type, session) {
  const balances = new Map();
  for (const allocation of allocations) {
    await validateInventoryIdentity(allocation, { session, hold: type === 'hold' });
    for (const [model, id] of [[Product, allocation.product], ...(allocation.offer ? [[ProductOffer, allocation.offer]] : [])]) {
      const key = `${model.modelName}:${id}`;
      const entry = balances.get(key) || { model, id, quantity: 0 };
      entry.quantity = integer(entry.quantity + allocation.quantity, true);
      balances.set(key, entry);
    }
  }
  for (const { model, id, quantity } of [...balances.values()].sort((a, b) => `${a.model.modelName}:${a.id}`.localeCompare(`${b.model.modelName}:${b.id}`))) {
    const expression = ['sale', 'hold'].includes(type) ? availableExpression : reservedExpression;
    const condition = { _id: id, $expr: { $and: [
      { $gte: [expression, quantity] }, { $gte: [reservedExpression, 0] },
      { $gte: ['$stockQuantity', reservedExpression] },
      { $lt: [revisionExpression, Number.MAX_SAFE_INTEGER] },
    ] } };
    const changes = { inventoryRevision: 1 };
    if (['sale', 'hold_confirm'].includes(type)) {
      changes.stockQuantity = -quantity;
      if (model === Product) changes.salesCount = quantity;
    }
    if (type === 'hold') changes.reservedStockQuantity = quantity;
    if (['hold_confirm', 'hold_release'].includes(type)) changes.reservedStockQuantity = -quantity;
    const updated = await model.findOneAndUpdate(condition, { $inc: changes }, { new: true, session, runValidators: true });
    if (!updated) fail('INSUFFICIENT_INVENTORY', 'Inventory changed or available stock is insufficient.');
  }
}
async function immediateSale({ allocations, order, businessKey, session }) {
  const normalized = normalizeAllocations(allocations);
  objectId(order);
  return receipt({ type: 'sale', allocations: normalized, order, businessKey, session },
    () => mutateBalances(normalized, 'sale', session));
}
async function reserve({ allocations, businessKey, session }) {
  if (typeof businessKey !== 'string' || !businessKey.trim() || businessKey.length > 220) {
    fail('INVALID_INVENTORY_KEY', 'A bounded reservation business key is required.', 400);
  }
  const normalized = normalizeAllocations(allocations, { hold: true });
  return receipt({ type: 'hold', allocations: normalized, businessKey: `hold:${businessKey}`, session },
    () => mutateBalances(normalized, 'hold', session));
}
async function transitionHold({ reservation, session }, type) {
  requireTransaction(session);
  const current = await DeliveryReservation.findById(objectId(reservation)).session(session);
  if (!current) fail('RESERVATION_NOT_FOUND', 'Reservation not found.', 404);
  const allocations = normalizeAllocations(current.inventoryAllocations, { hold: true });
  const holdKey = `hold:${current.user}:${current.idempotencyKey}`;
  const held = await InventoryOperation.findOne({ businessKey: holdKey, type: 'hold' }).session(session);
  if (!held || JSON.stringify(held.allocations.map((item) => ({ product: String(item.product), offer: item.offer ? String(item.offer) : null, quantity: item.quantity }))) !== JSON.stringify(allocations)) {
    fail('INVENTORY_HOLD_MISMATCH', 'Reservation has no matching inventory hold.');
  }
  return receipt({ type, allocations, businessKey: `terminal:${holdKey}`, reservation: current._id,
    order: current.order || null, session }, async () => {
    if (current.state !== 'held') fail('INVENTORY_RECONCILIATION_REQUIRED', 'Only a temporary hold can transition.');
    const order = current.order ? await MainOrder.findById(current.order).session(session) : null;
    if (type === 'hold_confirm') {
      if (!order?.isPaid || String(order.user) !== String(current.user) || order.schedule?.mode !== 'scheduled' ||
          String(order.schedule?.reservation) !== String(current._id) || String(order.schedule?.window) !== String(current.window) ||
          order.fulfillmentHold?.active || ['cancelled', 'completed', 'delivered'].includes(order.mainOrderStatus) ||
          !current.expiresAt || current.expiresAt <= new Date()) {
        fail('INVENTORY_RECONCILIATION_REQUIRED', 'Verified eligible payment is required to confirm inventory.');
      }
    } else if (current.order && (!order || order.isPaid || order.paymentResult?.tx_ref)) {
      fail('INVENTORY_RECONCILIATION_REQUIRED', 'Payment must be reconciled before releasing inventory.');
    }
    await mutateBalances(allocations, type, session);
    // The common unique terminal key fences confirm against release. The caller
    // owns the reservation state/revision update in this same transaction.
  });
}
async function adjustStock({ product, offer = null, stockQuantity, expectedRevision, expectedOfferRevision, businessKey, session }) {
  const quantity = integer(stockQuantity);
  integer(expectedRevision);
  if (offer) integer(expectedOfferRevision);
  const allocations = [{ product: objectId(product), offer: offer ? objectId(offer) : null, quantity }];
  return receipt({ type: 'adjustment', allocations, businessKey, extra: { expectedRevision, expectedOfferRevision: expectedOfferRevision ?? null }, session }, async () => {
    // Identity validation uses a positive probe, since setting zero is valid.
    await validateInventoryIdentity({ ...allocations[0], quantity: 1 }, { session });
    for (const [model, id, revision] of [[Product, allocations[0].product, expectedRevision],
      ...(offer ? [[ProductOffer, allocations[0].offer, expectedOfferRevision]] : [])]) {
      const updated = await model.findOneAndUpdate({ _id: id, $expr: { $and: [
        { $eq: [revisionExpression, revision] }, { $lt: [revisionExpression, Number.MAX_SAFE_INTEGER] },
        { $lte: [reservedExpression, quantity] }, { $gte: [reservedExpression, 0] },
      ] } }, { $set: { stockQuantity: quantity }, $inc: { inventoryRevision: 1 } }, { new: true, session, runValidators: true });
      if (!updated) fail('INVENTORY_ADJUSTMENT_CONFLICT', 'Stock changed or the new quantity is below reserved stock.');
    }
  });
}
async function restock({ allocations, order, businessKey, session }) {
  const normalized = normalizeAllocations(allocations);
  objectId(order);
  return receipt({ type: 'restock', allocations: normalized, order, businessKey, session }, async () => {
    for (const allocation of normalized) {
      await validateInventoryIdentity(allocation, { session });
      for (const [model, id] of [[Product, allocation.product], ...(allocation.offer ? [[ProductOffer, allocation.offer]] : [])]) {
        const current = await model.findById(id).session(session);
        integer(current.stockQuantity + allocation.quantity);
        integer((current.inventoryRevision ?? 0) + 1);
        await model.updateOne({ _id: id }, { $inc: { stockQuantity: allocation.quantity, inventoryRevision: 1 } }, { session });
      }
    }
  });
}
async function assertNoHolds(productIds, session) {
  const ids = productIds.map(objectId);
  const held = await DeliveryReservation.exists({ state: { $in: ['held', 'confirmed', 'review'] }, 'inventoryAllocations.product': { $in: ids } }).session(session || null);
  const product = await Product.exists({ _id: { $in: ids }, reservedStockQuantity: { $gt: 0 } }).session(session || null);
  const offer = await ProductOffer.exists({ product: { $in: ids }, reservedStockQuantity: { $gt: 0 } }).session(session || null);
  if (held || product || offer) fail('INVENTORY_HAS_RESERVATIONS', 'Inventory with reservations cannot be deleted or reassigned.');
}

async function initializeOffer({ product, values, session }) {
  requireTransaction(session);
  const current = await Product.findById(objectId(product)).session(session);
  if (!current) fail('INVENTORY_NOT_FOUND', 'Product inventory not found.', 404);
  getAvailableQuantity(current);
  integer((current.inventoryRevision ?? 0) + 1);
  if ((current.reservedStockQuantity ?? 0) !== 0) fail('INVENTORY_HAS_RESERVATIONS', 'Cannot initialize an offer while inventory is held.');
  // Touch the parent so concurrent sales/deletion cannot commit a stale copy.
  const fenced = await Product.updateOne({ _id: current._id,
    $expr: { $eq: [revisionExpression, current.inventoryRevision ?? 0] } },
  { $inc: { inventoryRevision: 1 } }, { session });
  if (fenced.modifiedCount !== 1) fail('INVENTORY_OPERATION_CONFLICT', 'Product inventory changed.');
  const [offer] = await ProductOffer.create([{ ...values, product: current._id,
    stockQuantity: current.stockQuantity, reservedStockQuantity: 0, inventoryRevision: 0 }], { session });
  return offer;
}

module.exports = { getAvailableQuantity, assertAvailable, validateInventoryIdentity, normalizeAllocations,
  reserve, confirmReservation: (input) => transitionHold(input, 'hold_confirm'),
  releaseReservation: (input) => transitionHold(input, 'hold_release'), immediateSale, adjustStock, restock,
  assertNoHolds, initializeOffer, requireTransaction };

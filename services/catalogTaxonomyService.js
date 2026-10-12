const crypto = require('node:crypto');
const manifest = require('../config/catalogTaxonomy.json');
const { preservesCategoryRestrictions } = require('../utils/categoryPolicy');

class CategoryInputError extends Error {
    constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; this.code = 'INVALID_PRODUCT_CATEGORY'; }
}
const text = value => String(value ?? '').trim();
const normalized = value => text(value).toLowerCase();
const nodes = manifest.categories.flatMap(parent => [
    { ...parent, children: undefined, parentId: null }, ...parent.children,
]);
const byId = new Map(nodes.map(node => [node.id, node]));
function validateManifest(data = manifest) {
    if (data.version !== 1 || data.categories.length !== 23 || data.categories.reduce((n, p) => n + p.children.length, 0) !== 186) throw new Error('Invalid category manifest counts/version.');
    const ids = new Set(), keys = new Set(), parentLabels = new Set();
    data.categories.forEach((parent, i) => {
        if (parentLabels.has(parent.label)) throw new Error('Duplicate category labels.');
        parentLabels.add(parent.label);
        if (parent.sortOrder !== i) throw new Error('Invalid category ordering.');
        const labels = new Set();
        [parent, ...parent.children].forEach((node, j) => {
            if (!/^[a-f0-9]{24}$/.test(node.id) || ids.has(node.id) || keys.has(node.key) || typeof node.key !== 'string' || !node.key || !text(node.label)) throw new Error('Invalid category identity.');
            ids.add(node.id); keys.add(node.key);
            if (j && (node.parentId !== parent.id || node.sortOrder !== j - 1 || labels.has(node.label))) throw new Error('Invalid subcategory relationship.');
            if (j) labels.add(node.label);
        });
    });
    return true;
}
validateManifest();
const checksum = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
function parentForLabel(label) {
    const name = normalized(label);
    const alias = manifest.parentAliases.find(group => group.some(item => normalized(item) === name));
    return manifest.categories.find(parent => normalized(parent.label) === name || (alias && normalized(parent.label) === normalized(alias[0]))) || null;
}
function childForLabel(parent, label) {
    const name = normalized(label);
    const groups = manifest.childAliases[normalized(parent.label)] || [];
    const alias = groups.find(group => group.some(item => normalized(item) === name));
    return parent.children.find(child => normalized(child.label) === name || (alias && normalized(child.label) === normalized(alias[0]))) || null;
}
function resolveLabels(category, subcategory = '') {
    const parts = text(category).split('>').map(text).filter(Boolean);
    const parent = parentForLabel(parts[0]);
    if (!parent || parts.length > 2) return null;
    const childText = parts[1] || text(subcategory);
    const child = childText ? childForLabel(parent, childText) : null;
    if (childText && !child) return null;
    if (parts[1] && text(subcategory) && childForLabel(parent, subcategory)?.id !== child?.id) return null;
    return { parent, child };
}
function resolveIds(categoryId, subcategoryId) {
    const validType = value => typeof value === 'string' || value?._bsontype === 'ObjectId';
    if (!validType(categoryId) || (subcategoryId != null && subcategoryId !== '' && !validType(subcategoryId))) {
        throw new CategoryInputError('Select a valid category and its matching subcategory.');
    }
    const parent = byId.get(text(categoryId));
    const child = text(subcategoryId) ? byId.get(text(subcategoryId)) : null;
    if (!parent || parent.parentId || (text(subcategoryId) && (!child || child.parentId !== parent.id))) throw new CategoryInputError('Select a valid category and its matching subcategory.');
    return { parent, child };
}
function assertReferences(product, { allowUnchangedLegacy = false } = {}) {
    // Only a hydrated, unchanged classification can retain legacy references.
    // New products and every actual label/reference change remain strict.
    if (allowUnchangedLegacy && product.isNew === false && typeof product.isModified === 'function' &&
        ['category', 'subcategory', 'categoryId', 'subcategoryId'].every(field => !product.isModified(field))) return;
    if (!product.categoryId && !product.subcategoryId) return;
    const selected = resolveIds(product.categoryId, product.subcategoryId);
    const labels = resolveLabels(product.category, product.subcategory);
    if (!labels || labels.parent.id !== selected.parent.id || (labels.child?.id || null) !== (selected.child?.id || null)) throw new CategoryInputError('Category references conflict with the product labels.');
}
function referencesMatch(product, labels = resolveLabels(product.category, product.subcategory)) {
    if (!labels) return false;
    try {
        const selected = resolveIds(product.categoryId, product.subcategoryId);
        return labels.parent.id === selected.parent.id && (labels.child?.id || null) === (selected.child?.id || null);
    } catch (_) { return false; }
}
function unchangedCategoryFields(current, labels, referencesReady) {
    const saved = typeof current.toObject === 'function' ? current.toObject() : current;
    const fields = { category: current.category, subcategory: current.subcategory ?? '',
        categoryId: current.categoryId || null, subcategoryId: current.subcategoryId || null };
    if ((!fields.categoryId && !fields.subcategoryId) || referencesMatch(fields, labels)) return fields;
    if (referencesReady && labels) {
        const candidate = { ...fields, categoryId: labels.parent.id, subcategoryId: labels.child?.id || null };
        // Never infer a mapping from a duplicate child alone, or erase known
        // restrictive ID evidence merely because the saved labels disagree.
        if (preservesCategoryRestrictions(saved, { ...saved, ...candidate })) return candidate;
    }
    return fields;
}
function prepareProductCategory(input, current = {}, { referencesReady = false } = {}) {
    const categoryChanged = input.category !== undefined;
    const childChanged = input.subcategory !== undefined;
    const idsProvided = input.categoryId !== undefined || input.subcategoryId !== undefined;
    let category = categoryChanged ? text(input.category) : text(current.category);
    // Omission preserves the saved child; an explicit empty/null value clears it.
    let subcategory = childChanged ? text(input.subcategory) : text(current.subcategory);
    const changed = categoryChanged || childChanged || idsProvided;
    if (!changed) return unchangedCategoryFields(current, resolveLabels(current.category, current.subcategory), referencesReady);
    let labels = resolveLabels(category, subcategory);
    if (idsProvided) {
        const parentId = input.categoryId !== undefined ? input.categoryId : current.categoryId;
        const sameParent = text(parentId) === text(current.categoryId);
        const childId = input.subcategoryId !== undefined ? input.subcategoryId
            : (sameParent && !categoryChanged && !childChanged ? current.subcategoryId : labels?.child?.id);
        const selected = resolveIds(parentId, childId);
        if (!referencesReady) throw new CategoryInputError('Category references are not enabled yet. Submit the existing category labels.', 503);
        if (!categoryChanged && !childChanged && (!labels || labels.parent.id !== selected.parent.id || (labels.child?.id || null) !== (selected.child?.id || null))) {
            category = selected.child ? `${selected.parent.label} > ${selected.child.label}` : selected.parent.label;
            subcategory = selected.child?.label || '';
            labels = selected;
        } else if (!labels || labels.parent.id !== selected.parent.id || (labels.child?.id || null) !== (selected.child?.id || null)) throw new CategoryInputError('Category references conflict with the supplied labels.');
    }
    // Preserve unchanged legacy labels; reject new contradictory selections
    // under a known parent even when the caller submits no database references.
    const labelsUnchanged = normalized(category) === normalized(current.category) && normalized(subcategory) === normalized(current.subcategory);
    if (!idsProvided && labelsUnchanged) return unchangedCategoryFields(current, labels, referencesReady);
    if (parentForLabel(category.split('>')[0]) && !labels && !labelsUnchanged) {
        throw new CategoryInputError('Select a valid category and its matching subcategory.');
    }
    const fields = { category, subcategory, categoryId: referencesReady && labels ? labels.parent.id : null,
        subcategoryId: referencesReady && labels ? labels.child?.id || null : null };
    // A valid saved identity does not need to be removed by an older label-only
    // form, including an equivalent alias, when reference writes are disabled.
    if (!idsProvided && referencesMatch({ ...current, category, subcategory }, labels)) {
        fields.categoryId = current.categoryId; fields.subcategoryId = current.subcategoryId || null;
    }
    return fields;
}
const databaseRecords = () => nodes.map(({ id, key, label, parentId, sortOrder }) => ({ _id: id, key, label, parentId, sortOrder, taxonomyVersion: manifest.version }));
function recordsMatch(records) {
    if (records.length !== nodes.length) return false;
    const saved = new Map(records.map(row => [String(row._id), row]));
    return databaseRecords().every(expected => {
        const actual = saved.get(expected._id);
        return actual && ['key', 'label', 'sortOrder', 'taxonomyVersion'].every(key => actual[key] === expected[key]) && String(actual.parentId || '') === String(expected.parentId || '');
    });
}
async function databaseReadiness({ Category, connection, env = process.env } = {}) {
    if (env.CATEGORY_REFERENCE_WRITES_ENABLED !== 'true' || connection?.readyState !== 1) return false;
    try {
        const records = await Category.find({}).lean();
        const indexes = await Category.collection.indexes();
        return recordsMatch(records) && indexes.some(index => index.unique && index.key?.key === 1 && Object.keys(index.key).length === 1);
    } catch (_) { return false; }
}
function hierarchy(referencesReady = false) {
    return { ...manifest, checksum, referencesReady: referencesReady === true };
}
module.exports = { manifest, nodes, byId, checksum, CategoryInputError, validateManifest, resolveLabels, resolveIds, assertReferences, prepareProductCategory, databaseRecords, recordsMatch, databaseReadiness, hierarchy };

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Match equivalent storefront labels without rewriting a product's saved category.
const { manifest, resolveIds, resolveLabels, CategoryInputError } = require('../services/catalogTaxonomyService');
const CATEGORY_PARENT_ALIASES = manifest.parentAliases;
const CATEGORY_CHILD_ALIASES = manifest.childAliases;

const categoryChildPattern = (parent, children) => {
  const groups = CATEGORY_CHILD_ALIASES[String(parent).toLowerCase()] || [];
  return children.map((child, index) => {
    const aliases = index === 0 && groups.find(group =>
      group.some(label => label.toLowerCase() === child.toLowerCase()));
    return aliases ? '(?:' + aliases.map(escapeRegex).join('|') + ')' : escapeRegex(child);
  }).join('\\s*>\\s*');
};

const categoryPathPattern = (category) => {
  const parts = String(category || '').split('>').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  const aliases = CATEGORY_PARENT_ALIASES.find(group =>
    group.some(label => label.toLowerCase() === parts[0].toLowerCase()));
  const parent = aliases ? '(?:' + aliases.map(escapeRegex).join('|') + ')' : escapeRegex(parts[0]);
  return parts.length > 1 ? parent + '\\s*>\\s*' + categoryChildPattern(parts[0], parts.slice(1)) : parent;
};

const buildHierarchicalCategoryFilter = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) return {};
  if (normalized.toLowerCase() === 'restaurant') {
    return {
      $or: [{ category: {
        $regex: /^(restaurant($|\s*>\s*)|.*\b(meal|fast food|local dishes|pastries|drinks|catering)\b.*)/i,
      } }, { subcategory: { $regex: /(^restaurant$|\b(meal|fast food|local dishes|pastries|drinks|catering)\b)/i } }],
    };
  }
  return {
    category: {
      $regex: new RegExp(`^${categoryPathPattern(normalized)}(?:$|\\s*>\\s*)`, 'i'),
    },
  };
};

const buildCategoryFilter = (category, { includeStandaloneSubcategory = false } = {}) => {
  const normalized = String(category || '').trim();
  if (!normalized) return {};
  const parts = normalized.split('>').map(part => part.trim()).filter(Boolean);
  const hierarchy = buildHierarchicalCategoryFilter(normalized);
  if (parts.length < 2) {
    if (!includeStandaloneSubcategory) return hierarchy;
    return { $or: [hierarchy, { subcategory: { $regex: new RegExp('^' + escapeRegex(normalized) + '$', 'i') } }] };
  }
  return {
    $or: [
      hierarchy,
      {
        category: { $regex: new RegExp('^' + categoryPathPattern(parts[0]) + '$', 'i') },
        subcategory: { $regex: new RegExp('^' + categoryChildPattern(parts[0], parts.slice(1)) + '$', 'i') },
      },
    ],
  };
};

// ID browsing must also find products that have never been backfilled.
function buildCategorySelectionFilter(query = {}) {
  const hasIds = query.categoryId !== undefined || query.subcategoryId !== undefined;
  if (!hasIds) {
    if (!query.category) return query.subcategory
      ? { subcategory: { $regex: new RegExp('^' + escapeRegex(String(query.subcategory).trim()) + '$', 'i') } } : null;
    if (!query.subcategory) return buildCategoryFilter(query.category);
    const parentText = String(query.category).split('>')[0].trim();
    if (resolveLabels(parentText) && !resolveLabels(query.category, query.subcategory)) throw new CategoryInputError('Category filters conflict.');
    const path = String(query.category).includes('>') ? query.category : query.category + ' > ' + query.subcategory;
    return buildCategoryFilter(path);
  }
  let { parent, child } = resolveIds(query.categoryId, query.subcategoryId);
  if (query.category || query.subcategory) {
    const labels = resolveLabels(query.category || parent.label, query.subcategory);
    if (!labels || labels.parent.id !== parent.id || (labels.child && child && labels.child.id !== child.id)) throw new CategoryInputError('Category filters conflict.');
    // A label child can narrow a parent-ID query, but never broaden it.
    if (labels.child) child = labels.child;
  }
  const path = child ? parent.label + ' > ' + child.label : parent.label;
  const reference = child ? { categoryId: parent.id, subcategoryId: child.id } : { categoryId: parent.id };
  const labels = buildCategoryFilter(path);
  // A stale reference must not place an unrelated product in this category.
  // Every reference match also needs compatible legacy text; label matching
  // continues to find unreferenced and safely retained legacy products.
  return { $or: [{ $and: [reference, labels] }, labels] };
}

const buildPriceFilter = (minPrice, maxPrice) => {
  const minimum = minPrice === undefined || minPrice === '' ? null : Number(minPrice);
  const maximum = maxPrice === undefined || maxPrice === '' ? null : Number(maxPrice);
  if (!Number.isFinite(minimum) && !Number.isFinite(maximum)) return undefined;
  const filter = {};
  if (Number.isFinite(minimum)) filter.$gte = Math.max(0, minimum);
  if (Number.isFinite(maximum)) filter.$lte = Math.max(0, maximum);
  return filter;
};

const buildEffectivePriceExpression = (minPrice, maxPrice) => {
  const range = buildPriceFilter(minPrice, maxPrice);
  if (!range) return undefined;
  const effectivePrice = {
    $cond: [
      { $and: [{ $ne: ['$discountPrice', null] }, { $gt: ['$price', '$discountPrice'] }] },
      '$discountPrice',
      '$price',
    ],
  };
  const conditions = [];
  if (range.$gte !== undefined) conditions.push({ $gte: [effectivePrice, range.$gte] });
  if (range.$lte !== undefined) conditions.push({ $lte: [effectivePrice, range.$lte] });
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
};

module.exports = { buildCategorySelectionFilter, buildCategoryFilter, buildHierarchicalCategoryFilter, buildPriceFilter, buildEffectivePriceExpression, escapeRegex };

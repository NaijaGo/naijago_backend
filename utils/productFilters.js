const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildHierarchicalCategoryFilter = (category) => {
  const normalized = String(category || '').trim();
  if (!normalized) return {};
  if (normalized.toLowerCase() === 'restaurant') {
    return {
      category: {
        $regex: /^(restaurant($|\s*>\s*)|.*\b(meal|fast food|local dishes|pastries|drinks|catering)\b.*)/i,
      },
    };
  }
  return {
    category: {
      $regex: new RegExp(`^${escapeRegex(normalized)}(?:$|\\s*>\\s*)`, 'i'),
    },
  };
};

// Shared by the HTTP route and isolated search tests. Support both legacy
// hierarchical category strings and separately stored category/subcategory.
const buildCategoryFilter = (category) => {
  const normalized = String(category || '').trim();
  const parts = normalized.split('>').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return buildHierarchicalCategoryFilter(normalized);
  const parent = parts[0];
  const child = parts.slice(1).join(' > ');
  return { $or: [buildHierarchicalCategoryFilter(normalized), {
    category: { $regex: new RegExp(`^${escapeRegex(parent)}$`, 'i') },
    subcategory: { $regex: new RegExp(`^${escapeRegex(child)}$`, 'i') },
  }] };
};

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

module.exports = { buildCategoryFilter, buildHierarchicalCategoryFilter, buildPriceFilter, buildEffectivePriceExpression, escapeRegex };

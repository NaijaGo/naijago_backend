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

const buildPriceFilter = (minPrice, maxPrice) => {
  const minimum = minPrice === undefined || minPrice === '' ? null : Number(minPrice);
  const maximum = maxPrice === undefined || maxPrice === '' ? null : Number(maxPrice);
  if (!Number.isFinite(minimum) && !Number.isFinite(maximum)) return undefined;
  const filter = {};
  if (Number.isFinite(minimum)) filter.$gte = Math.max(0, minimum);
  if (Number.isFinite(maximum)) filter.$lte = Math.max(0, maximum);
  return filter;
};

module.exports = { buildHierarchicalCategoryFilter, buildPriceFilter, escapeRegex };

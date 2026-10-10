const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Match equivalent storefront labels without rewriting a product's saved category.
const CATEGORY_PARENT_ALIASES = [
  ['Cosmetics & Beauty', 'Health & Beauty', 'Supermarket Health & Beauty'],
  ['Groceries', 'Supermarket'],
];

const CATEGORY_CHILD_ALIASES = {
  fashion: [["Men's Fashion", 'Men']],
  'phones & tablets': [['Mobile Phone Accessories', 'Accessories']],
};

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
      category: {
        $regex: /^(restaurant($|\s*>\s*)|.*\b(meal|fast food|local dishes|pastries|drinks|catering)\b.*)/i,
      },
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

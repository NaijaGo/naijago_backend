// Shared, versioned search vocabulary. This describes attributes, not invented
// inventory. Unknown words remain literal search terms; AI cannot override stock.
const SEARCH_SCHEMA_VERSION = 1;
const CATEGORY_FAMILIES = [
    { key: 'fashion', label: 'Fashion', aliases: ['fashion', 'clothes', 'clothing', 'wear', 'apparel'] },
    { key: 'electronics', label: 'Electronics', aliases: ['electronics', 'electronic', 'phones tablets', 'computing', 'computers', 'phones', 'gadgets'] },
    { key: 'food', label: 'Food', aliases: ['food', 'restaurant', 'restaurants', 'groceries', 'grocery', 'meals'] },
    { key: 'beauty', label: 'Cosmetics and Beauty', aliases: ['cosmetics beauty', 'cosmetics and beauty', 'health beauty', 'health and beauty', 'beauty', 'cosmetics'] },
    { key: 'home', label: 'Home & Office', aliases: ['home office', 'home and office', 'home appliances', 'furniture', 'appliances'] },
    { key: 'automobiles', label: 'Automobiles', aliases: ['automobiles', 'automobile', 'automotive', 'cars'] },
];
const PRODUCT_TYPES = [
    ['dress', 'Dresses', ['dress', 'dresses', 'gown', 'gowns']],
    ['top', 'Tops', ['top', 'tops', 'blouse', 'blouses']],
    ['skirt', 'Skirts', ['skirt', 'skirts']],
    ['trousers', 'Trousers', ['trouser', 'trousers', 'pants']],
    ['jeans', 'Jeans', ['jean', 'jeans']],
    ['native_wear', 'Native wear', ['native wear', 'traditional wear', 'ankara', 'agbada']],
    ['jumpsuit', 'Jumpsuits', ['jumpsuit', 'jumpsuits']],
    ['shoes', 'Shoes', ['shoe', 'shoes', 'footwear', 'sneaker', 'sneakers', 'heels', 'sandals', 'boots']],
    ['bag', 'Bags', ['bag', 'bags', 'handbag', 'handbags', 'backpack', 'backpacks']],
    ['accessories', 'Accessories', ['accessory', 'accessories', 'jewellery', 'jewelry']],
    ['shirt', 'Shirts', ['shirt', 'shirts']],
    ['t_shirt', 'T-shirts', ['t shirt', 't shirts', 'tshirt', 'tshirts', 'tee', 'tees']],
    ['phone', 'Phones', ['phone', 'phones', 'smartphone', 'smartphones']],
    ['laptop', 'Laptops', ['laptop', 'laptops', 'notebook', 'notebooks']],
    ['blender', 'Blenders', ['blender', 'blenders']],
];
const GENDER_ALIASES = {
    female: ['female', 'woman', 'women', 'womens', 'lady', 'ladies', 'girl', 'girls'],
    male: ['male', 'man', 'men', 'mens', 'gentleman', 'gentlemen', 'boy', 'boys'],
    unisex: ['unisex'],
};
const CHILD_WORDS = ['boy', 'boys', 'girl', 'girls', 'kids', 'kid', 'children', 'child', 'baby', 'babies'];
const ADULT_WORDS = ['woman', 'women', 'womens', 'lady', 'ladies', 'man', 'men', 'mens', 'gentleman', 'gentlemen', 'adult'];
const STOP_WORDS = new Set(['i', 'want', 'need', 'for', 'please', 'show', 'me', 'to', 'buy', 'find', 'with', 'and', 'of', 'in', 'a', 'an', 'the', 'some', 'looking']);
const FASHION_TYPES = new Set(PRODUCT_TYPES.slice(0, 12).map(([key]) => key));
const normalize = (value) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasPhrase = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
const unique = (items) => [...new Set(items)];

function readIntent(query) {
    const text = normalize(String(query || '').slice(0, 200));
    let remaining = ` ${text} `;
    const words = text.split(' ');
    const genders = Object.entries(GENDER_ALIASES).filter(([, aliases]) => aliases.some((word) => words.includes(word))).map(([gender]) => gender);
    const gender = genders.length === 1 ? genders[0] : null;
    const ageGroup = words.some((word) => CHILD_WORDS.includes(word)) ? 'child'
        : words.some((word) => ADULT_WORDS.includes(word)) ? 'adult' : null;
    // Match longest phrases first (T-shirt must not become shirt).
    const matchedTypes = [];
    const aliases = PRODUCT_TYPES.flatMap(([key, , values]) => values.map((alias) => ({ key, alias })))
        .sort((a, b) => b.alias.length - a.alias.length);
    for (const { key, alias } of aliases) {
        if (remaining.includes(` ${alias} `)) {
            matchedTypes.push(key);
            remaining = remaining.replaceAll(` ${alias} `, ' ');
        }
    }
    const productTypes = unique(matchedTypes);
    let categoryFamily = CATEGORY_FAMILIES.find((family) => family.aliases.some((alias) => hasPhrase(text, alias)))?.key || null;
    if (!categoryFamily && productTypes.some((type) => FASHION_TYPES.has(type))) categoryFamily = 'fashion';
    if (!categoryFamily && productTypes.some((type) => ['phone', 'laptop'].includes(type))) categoryFamily = 'electronics';
    const consumed = new Set([...Object.values(GENDER_ALIASES).flat(), ...CHILD_WORDS, ...ADULT_WORDS]);
    if (categoryFamily) {
        for (const alias of [...CATEGORY_FAMILIES.find((item) => item.key === categoryFamily).aliases].sort((a, b) => b.length - a.length)) {
            remaining = remaining.replaceAll(` ${alias} `, ' ');
        }
    }
    const terms = unique(remaining.trim().split(/\s+/).filter((word) => word && !STOP_WORDS.has(word) && !consumed.has(word))).slice(0, 12);
    return { query: String(query || '').trim().slice(0, 200), normalized: text, categoryFamily, gender, ageGroup, productTypes, terms };
}

function deriveSearchAttributes(product) {
    const categoryPath = unique([String(product.category || ''), String(product.subcategory || '')]
        .flatMap((item) => item.split('>')).map((item) => item.trim()).filter(Boolean));
    const tags = Array.isArray(product.searchTags) ? product.searchTags : [];
    const identity = [product.name, product.productType, ...categoryPath, ...tags].filter(Boolean).join(' ');
    const intent = readIntent(identity);
    const root = normalize(categoryPath[0]);
    const family = CATEGORY_FAMILIES.find((item) => item.aliases.includes(root))?.key || intent.categoryFamily;
    const searchable = normalize([identity, product.brand, product.description, product.restaurantName].filter(Boolean).join(' ').slice(0, 8000));
    return {
        version: SEARCH_SCHEMA_VERSION, categoryPath, categoryFamily: family || '',
        gender: product.gender || intent.gender || 'unspecified',
        ageGroup: product.ageGroup || intent.ageGroup || 'all',
        productTypes: product.productType ? (readIntent(product.productType).productTypes.length
            ? readIntent(product.productType).productTypes : [normalize(product.productType).replaceAll(' ', '_')]) : intent.productTypes,
        tokens: unique(searchable.split(' ').filter(Boolean)).slice(0, 256),
    };
}

function wordPattern(aliases) {
    return { $regex: `(?:^|[^a-z0-9])(?:${aliases.map(escapeRegex).join('|')})(?:$|[^a-z0-9])`, $options: 'i' };
}
function legacyMatch(fields, aliases) {
    return { $or: fields.map((field) => ({ [field]: wordPattern(aliases) })) };
}
function attributeClause(path, values, legacy) {
    return { $or: [{ [`searchAttributes.${path}`]: { $in: values } }, {
        $and: [{ 'searchAttributes.version': { $exists: false } }, legacy],
    }] };
}

function buildIntentFilter(intent, { vendorIdsByTerm = {} } = {}) {
    const clauses = [];
    const identityFields = ['name', 'category', 'subcategory', 'searchTags'];
    if (intent.categoryFamily) {
        const family = CATEGORY_FAMILIES.find((item) => item.key === intent.categoryFamily);
        clauses.push(attributeClause('categoryFamily', [family.key], legacyMatch(identityFields, family.aliases)));
    }
    if (intent.gender) {
        const genders = unique([intent.gender, 'unisex']);
        clauses.push(attributeClause('gender', genders, legacyMatch(identityFields, genders.flatMap((key) => GENDER_ALIASES[key]))));
    }
    if (intent.ageGroup) {
        clauses.push(attributeClause('ageGroup', [intent.ageGroup, 'all'], intent.ageGroup === 'child'
            ? legacyMatch(identityFields, CHILD_WORDS)
            : { $nor: [legacyMatch(identityFields, CHILD_WORDS)] }));
    }
    if (intent.productTypes.length) {
        const aliases = PRODUCT_TYPES.filter(([key]) => intent.productTypes.includes(key)).flatMap(([, , values]) => values);
        clauses.push(attributeClause('productTypes', intent.productTypes, legacyMatch(identityFields, aliases)));
    }
    for (const term of intent.terms) {
        const fields = [...identityFields, 'description', 'brand', 'restaurantName', 'sku'];
        const alternatives = fields.map((field) => ({ [field]: { $regex: escapeRegex(term), $options: 'i' } }));
        alternatives.unshift({ 'searchAttributes.tokens': term });
        if (vendorIdsByTerm[term]?.length) alternatives.push({ vendor: { $in: vendorIdsByTerm[term] } });
        clauses.push({ $or: alternatives });
    }
    return clauses.length ? { $and: clauses } : {};
}

function collectionForIntent(intent) {
    const family = CATEGORY_FAMILIES.find((item) => item.key === intent.categoryFamily);
    if (!family && !intent.gender) return null;
    const audience = intent.gender === 'female' ? (intent.ageGroup === 'child' ? 'Girls' : 'Women')
        : intent.gender === 'male' ? (intent.ageGroup === 'child' ? 'Boys' : 'Men') : '';
    const title = [audience, family?.label || 'Products'].filter(Boolean).join(' ');
    const chips = family?.key === 'fashion' ? PRODUCT_TYPES.filter(([key]) => FASHION_TYPES.has(key))
        .map(([key, label]) => ({ key, label })) : [];
    return { title, categoryFamily: family?.key || null, gender: intent.gender, ageGroup: intent.ageGroup, chips };
}

module.exports = { SEARCH_SCHEMA_VERSION, CATEGORY_FAMILIES, PRODUCT_TYPES, GENDER_ALIASES,
    normalize, escapeRegex, readIntent, deriveSearchAttributes, buildIntentFilter, collectionForIntent };

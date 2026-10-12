// Existing category commission defaults, preserved for installations without admin overrides.
const CATEGORY_COMMISSION_RATES = {
    // Core Marketplace
    'Groceries': 0.05,
    'Food & Beverage': 0.15,

    'Phones & Tablets': 0.06,
    'Computing': 0.06,
    'Electronics': 0.06,
    'Appliances': 0.06,

    // Lifestyle & High Margin
    'Fashion': 0.12,
    'Jewelry & Watches': 0.12,
    'Fragrances': 0.12,
    'Health & Beauty': 0.06,
    'Cosmetics & Beauty': 0.06,

    // Home & Living
    'Home & Kitchen': 0.07,
    'Furniture': 0.08,
    'Home Interior & Exterior': 0.08,
    'Lighting': 0.08,

    // Everyday & Business
    'Office Products': 0.07,
    'Automobile': 0.08,
    'Agriculture': 0.05,

    // Entertainment & Hobby
    'Gaming': 0.10,
    'Sporting Goods': 0.10,
    'Toys & Games': 0.10,
    'Music & Instruments': 0.08,
    'Arts & Crafts': 0.10,
    'Photography': 0.08,

    // Services
    'Travel & Tourism': 0.10,
    'Events': 0.10,
};

// Helper function to get commission rate based on category
// function getCommissionRateForCategory(category) {
//     // Check each commission tier
//     for (const [tier, data] of Object.entries(CATEGORY_COMMISSION_RATES)) {
//         if (data.categories.includes(category)) {
//             return data.rate;
//         }
//     }

//     // Default rate if category not found
//     return 0.125; // 12.5% default
// }

function getCommissionRateForCategory(category) {
    if (!category || typeof category !== 'string') return 0.08;

    const normalizedCategory = category.trim();
    const mainCategory = normalizedCategory.split('>')[0].trim();
    const subCategory = normalizedCategory.includes('>')
        ? normalizedCategory.split('>')[1].trim()
        : '';

    // THIS IS ONLY FOR FOOD (15% platform fee)
    const lowerCat = normalizedCategory.toLowerCase();
    if (!lowerCat.includes('restaurant equipment') && (
        lowerCat === 'restaurant' ||
        lowerCat.startsWith('restaurant >') ||
        lowerCat.includes('meal') ||
        lowerCat.includes('fast food') ||
        lowerCat.includes('local dishes') ||
        lowerCat.includes('pastries') ||
        lowerCat.includes('drinks') ||
        lowerCat.includes('catering') ||
        mainCategory === 'Food & Beverage'
    )) {
        return 0.15;
    }

    // Exact match first
    if (CATEGORY_COMMISSION_RATES[normalizedCategory]) {
        return CATEGORY_COMMISSION_RATES[normalizedCategory];
    }

    // Main category match
    if (CATEGORY_COMMISSION_RATES[mainCategory]) {
        return CATEGORY_COMMISSION_RATES[mainCategory];
    }

    // Support old DB category names
    const CATEGORY_ALIASES = {
        'Home & Office': {
            'Home & Kitchen': 0.07,
            'Furniture': 0.08,
            'Home Interior & Exterior': 0.08,
            'Lighting': 0.08,
            'Office Products': 0.07,
            'Appliances': 0.06,
        },
        'Automobiles': 0.08,
        'Automobile': 0.08,
        'Health & Beauty': 0.06,
        'Cosmetics & Beauty': 0.06,
        'Fragrance': 0.12,
        'Fragrances': 0.12,
        'Groceries': 0.05,
        'Animal Products': 0.05,
    };

    const alias = CATEGORY_ALIASES[mainCategory];

    if (typeof alias === 'number') {
        return alias;
    }

    if (alias && subCategory && alias[subCategory]) {
        return alias[subCategory];
    }

    return 0.08;
}

module.exports = { CATEGORY_COMMISSION_RATES, getCommissionRateForCategory };

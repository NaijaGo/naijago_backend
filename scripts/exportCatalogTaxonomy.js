const fs = require('node:fs');
const path = require('node:path');
const { hierarchy } = require('../services/catalogTaxonomyService');
const output = JSON.stringify(hierarchy(false), null, 2) + '\n';
const root = path.resolve(__dirname, '../..');
const targets = [
    'naijago.com_admin_panel/js/admin/catalog-taxonomy.fallback.json',
    'naijagomainapp/assets/catalog_taxonomy.v1.json',
    'go-vendor/assets/catalog_taxonomy.v1.json',
];
function exportTaxonomy({ check = true } = {}) {
    for (const target of targets) {
        const file = path.join(root, target);
        if (check) {
            if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output) throw new Error(`Category fallback differs: ${target}`);
        } else fs.writeFileSync(file, output);
    }
    return targets;
}
if (require.main === module) {
    try { exportTaxonomy({ check: !process.argv.includes('--write') }); console.log('Category fallback artifacts match the backend manifest.'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { exportTaxonomy };

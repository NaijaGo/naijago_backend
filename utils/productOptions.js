const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'PRODUCT_OPTIONS_INVALID' });

function parseColors(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = value.split(','); }
  }
  if (!Array.isArray(value) || value.length > 32) throw invalid('Provide up to 32 available colours.');
  const seen = new Set(), result = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length > 40 || /[\u0000-\u001f]/.test(entry)) throw invalid('Colour names must be plain text, up to 40 characters.');
    const label = entry.trim();
    if (label && !seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); result.push(label); }
  }
  return result;
}

function resolveSelection(product, input = {}) {
  let selectedColor = null;
  // Older clients may omit optional colours. Supplied colours must be real seller options.
  if (input.selectedColor != null && input.selectedColor !== '') {
    if (typeof input.selectedColor !== 'string' || input.selectedColor.length > 40) throw invalid('Select a valid colour.');
    selectedColor = (product.availableColors || []).find(value => value.toLowerCase() === input.selectedColor.trim().toLowerCase());
    if (!selectedColor) throw invalid('This colour is no longer available. Refresh the product.');
  }
  const selectedSize = input.selectedSize || null;
  const data = product.sizeData;
  if (selectedSize != null && data?.type) {
    if (data.type === 'custom') {
      const dimensions = data.customDimensions || [];
      const valid = typeof selectedSize === 'object' && !Array.isArray(selectedSize) && dimensions.some(size =>
        ['length', 'width', 'height', 'unit', 'label'].every(key => String(size[key] ?? '') === String(selectedSize[key] ?? '')));
      if (!valid) throw invalid('Select an available set of dimensions.');
    } else if ((data.sizes || []).length) {
      const value = typeof selectedSize === 'string' ? selectedSize : selectedSize?.value;
      if (typeof value !== 'string' || !(data.sizes || []).some(size => String(size.value ?? size) === value)) throw invalid('This size is no longer available. Refresh the product.');
    }
  }
  return { selectedColor, selectedSize };
}
module.exports = { parseColors, resolveSelection };

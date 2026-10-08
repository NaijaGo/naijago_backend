function positiveLimit(raw, maximum) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : 0;
}
module.exports = { positiveLimit };

function numericSimilarity_(a, b, floorScale) {
  a = toNumber_(a);
  b = toNumber_(b);
  const scale = Math.max(Math.abs(a), Math.abs(b), floorScale || 1);
  return clamp_(1 - Math.abs(a - b) / scale, 0, 1);
}

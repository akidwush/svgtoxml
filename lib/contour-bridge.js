// Alight Motion may flatten independent subpaths instead of preserving an
// SVG compound path's nonzero-winding holes. A retraced, zero-width bridge
// connects the two contours into one closed walk without changing their fill.
// Conservative: do not alter open contours or >2 independent subpaths.
export function bridgeClosedContourPair(input) {
  const path = String(input || '');
  const move = /M\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi;
  const matches = [...path.matchAll(move)];
  if (matches.length !== 2) return { path, bridged: false };
  if (matches[0].index !== 0) return { path, bridged: false };
  const outer = path.slice(0, matches[1].index).trim();
  const inner = path.slice(matches[1].index).trim();
  if (!outer.endsWith('Z') || !inner.endsWith('Z')) return { path, bridged: false };
  const [outerX, outerY] = matches[0].slice(1, 3);
  const [innerX, innerY] = matches[1].slice(1, 3);
  // The two L-bridges are retraced in opposite directions: zero enclosed area.
  // Retain both Bézier contours and their original winding unchanged.
  const stitched = `${outer.slice(0, -1)}L ${outerX} ${outerY}` +
    `L ${innerX} ${innerY}${inner.slice(matches[1][0].length, -1)}` +
    `L ${innerX} ${innerY}L ${outerX} ${outerY}Z`;
  return { path: stitched, bridged: true };
}

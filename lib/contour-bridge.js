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

/**
 * Join multiple filled subpaths into one continuous closed walk.
 *
 * Many SVG tracers (including Vector Magic) implicitly close their earlier
 * contours with the next M command and put a single Z at the end. Alight Motion
 * can fill those contours independently, erasing holes in rings and glyphs.
 * Retraced, zero-area connectors preserve nonzero-winding fill geometry while
 * giving the native editor one continuous contour.
 *
 * Use only for filled, unstroked paths. SVG strokes and open geometry must
 * keep the original path because bridging introduces visible stroke segments.
 */
export function bridgeFilledSubpaths(input) {
  const path = String(input || '').trim();
  const move = /M\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/g;
  const matches = [...path.matchAll(move)];
  if (matches.length < 2 || matches[0].index !== 0) return { path, bridged: false };
  const [outerX, outerY] = matches[0].slice(1, 3);
  let joined = `M ${outerX} ${outerY}`;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const end = index + 1 < matches.length ? matches[index + 1].index : path.length;
    const rawCommands = path.slice(match.index + match[0].length, end).trim();
    // Keep the helper conservative for malformed or multi-close subpaths.
    const commands = rawCommands.replace(/[Zz]\s*$/, '').trim();
    if (!commands || /[Zz]/.test(commands)) return { path, bridged: false };
    const [x, y] = match.slice(1, 3);

    if (index > 0) joined += ` L ${x} ${y}`;
    joined += ` ${commands} L ${x} ${y}`;
    if (index > 0) joined += ` L ${outerX} ${outerY}`;
  }
  return { path: `${joined} Z`, bridged: true };
}

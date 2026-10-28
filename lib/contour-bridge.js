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
 * Convert a filled compound path into one contiguous contour while placing
 * zero-area bridges inside existing painted areas. A long retraced bridge
 * can appear as a 1px seam in Alight Motion, even with unchanged SVG fill.
 *
 * SVG paths arriving here are already normalized to absolute M/L/C/Z
 * commands by normalizePathForAlight(). Fail closed for unknown commands.
 */
function parseClosedContours(source) {
  const tokens = source.match(/[a-zA-Z]|[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi) || [];
  const contours = [];
  let current = null;
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    if (!/^[MLCZ]$/.test(command)) return null;
    if (command === 'Z') {
      if (!current || !current.segments.length) return null;
      contours.push(current);
      current = null;
      continue;
    }
    const count = command === 'C' ? 6 : 2;
    if (i + count > tokens.length) return null;
    const values = tokens.slice(i, i + count).map(Number);
    if (values.some((v) => !Number.isFinite(v))) return null;
    i += count;
    const end = values.slice(-2);
    if (command === 'M') {
      if (current) contours.push(current);
      current = { start: end, segments: [] };
    } else {
      if (!current) return null;
      current.segments.push([command, ...values]);
    }
  }
  if (current) contours.push(current);
  if (contours.length < 2 || contours.length > 32) return null;
  let nodeCount = 0;
  for (const contour of contours) {
    if (!contour.segments.length) return null;
    const last = contour.segments[contour.segments.length - 1].slice(-2);
    if (Math.hypot(last[0] - contour.start[0], last[1] - contour.start[1]) > 1e-10) {
      contour.segments.push(['L', ...contour.start]);
    }
    contour.vertices = [contour.start, ...contour.segments.slice(0, -1).map((s) => s.slice(-2))];
    nodeCount += contour.segments.length;
  }
  return nodeCount <= 2000 ? contours : null;
}

function contourPolygon(contour) {
  const points = [contour.start];
  let current = contour.start;
  for (const segment of contour.segments) {
    if (segment[0] === 'L') {
      current = segment.slice(1);
      points.push(current);
      continue;
    }
    const [x1, y1, x2, y2, x3, y3] = segment.slice(1);
    const [x0, y0] = current;
    for (let step = 1; step <= 16; step++) {
      const t = step / 16;
      const u = 1 - t;
      points.push([
        u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
        u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3
      ]);
    }
    current = [x3, y3];
  }
  return points;
}

function containsPoint(polygon, x, y) {
  let inside = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const q = polygon[a], r = polygon[b];
    if ((q[1] > y) !== (r[1] > y) &&
        x < (r[0] - q[0]) * (y - q[1]) / (r[1] - q[1]) + q[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function bridgeInsidePaint(outer, holes, from, to) {
  for (const t of [0.125, 0.25, 0.5, 0.75, 0.875]) {
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    if (!containsPoint(outer, x, y) || holes.some((hole) => containsPoint(hole, x, y))) {
      return false;
    }
  }
  return true;
}

export function bridgeFilledSubpaths(input) {
  const path = String(input || '').trim();
  const contours = parseClosedContours(path);
  if (!contours) return { path, bridged: false, bridges: [] };

  const polygons = contours.map(contourPolygon);
  const outer = contours[0];
  const holes = polygons.slice(1);
  const visits = new Map();
  const bridges = [];

  for (let h = 1; h < contours.length; h++) {
    const inner = contours[h];
    // Only stitch enclosed holes, not disjoint islands, and avoid expensive
    // all-pairs geometry on pathological SVG files.
    if (!containsPoint(polygons[0], ...inner.start)) {
      return { path, bridged: false, bridges: [] };
    }
    if (outer.vertices.length * inner.vertices.length > 60000) {
      return { path, bridged: false, bridges: [] };
    }
    const candidates = [];
    for (let o = 0; o < outer.vertices.length; o++) {
      const from = outer.vertices[o];
      for (let j = 0; j < inner.vertices.length; j++) {
        const to = inner.vertices[j];
        const distance = Math.hypot(from[0] - to[0], from[1] - to[1]);
        candidates.push({ o, j, from, to, distance });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.o - b.o || a.j - b.j);
    let selected = null;
    for (const candidate of candidates.slice(0, 300)) {
      if (bridgeInsidePaint(polygons[0], holes, candidate.from, candidate.to)) {
        selected = candidate;
        break;
      }
    }
    if (!selected) return { path, bridged: false, bridges: [] };
    if (!visits.has(selected.o)) visits.set(selected.o, []);
    visits.get(selected.o).push({ inner, selected });
    bridges.push({ distance: selected.distance, outerIndex: selected.o, innerIndex: selected.j });
  }

  const emit = (seg) => seg[0] + ' ' + seg.slice(1).join(' ');
  const out = ['M ' + outer.start.join(' ')];
  for (let i = 0; i < outer.segments.length; i++) {
    for (const { inner, selected } of visits.get(i) || []) {
      out.push('L ' + selected.to.join(' '));
      for (const segment of inner.segments.slice(selected.j).concat(inner.segments.slice(0, selected.j))) {
        out.push(emit(segment));
      }
      out.push('L ' + selected.from.join(' '));
    }
    out.push(emit(outer.segments[i]));
  }
  out.push('Z');
  return { path: out.join(' '), bridged: true, bridges };
}

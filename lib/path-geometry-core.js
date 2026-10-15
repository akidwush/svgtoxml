import svgpath from 'svgpath';

function finite(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Path berisi koordinat non-finite.');
  return n;
}

export function quadraticToCubic(x0, y0, x1, y1, x2, y2) {
  return {
    c1x: x0 + (2 / 3) * (x1 - x0),
    c1y: y0 + (2 / 3) * (y1 - y0),
    c2x: x2 + (2 / 3) * (x1 - x2),
    c2y: y2 + (2 / 3) * (y1 - y2),
    x: x2,
    y: y2
  };
}

// svgpath.unarc() uses the standard SVG elliptical-arc decomposition into
// cubic Bézier segments. Keeping this in one helper makes the same canonical
// geometry path available to every quality mode.
export function expandArcsToCubics(d) {
  return svgpath(d).abs().unshort().unarc();
}

function pathNumber(value, precision = 8) {
  const n = finite(value);
  const p = Math.max(0, Math.min(12, Math.round(precision)));
  const fixed = n.toFixed(p);
  const cleaned = fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return cleaned === '-0' || cleaned === '' ? '0' : cleaned;
}

function rawNumber(value) {
  const n = finite(value);
  if (Object.is(n, -0)) return '0';
  // 15 significant digits keeps IEEE-754 transform results stable without
  // producing unnecessarily huge XML strings.
  return Number.parseFloat(n.toPrecision(15)).toString();
}

function canonicalPathObject(d) {
  const p = expandArcsToCubics(d);
  p.iterate((seg, _idx, x, y) => {
    const cmd = String(seg[0] || '').toUpperCase();
    if (cmd === 'H') return [['L', seg[1], y]];
    if (cmd === 'V') return [['L', x, seg[1]]];
    if (cmd === 'Q') {
      const q = quadraticToCubic(x, y, seg[1], seg[2], seg[3], seg[4]);
      return [['C', q.c1x, q.c1y, q.c2x, q.c2y, q.x, q.y]];
    }
    return undefined;
  });
  return p;
}

export function normalizePathForAlight(d, transformChain = [], rootMatrix = [1, 0, 0, 1, 0, 0], precision = 10) {
  // Arc expansion happens before arbitrary affine transforms. This avoids
  // relying on SVG arc parameters surviving skew/non-uniform transforms.
  let p = canonicalPathObject(d);
  for (let i = transformChain.length - 1; i >= 0; i--) {
    if (transformChain[i]) p.transform(transformChain[i]);
  }
  p.matrix(rootMatrix).abs().unshort().unarc();
  p.iterate((seg, _idx, x, y) => {
    const cmd = String(seg[0] || '').toUpperCase();
    if (cmd === 'H') return [['L', seg[1], y]];
    if (cmd === 'V') return [['L', x, seg[1]]];
    if (cmd === 'Q') {
      const q = quadraticToCubic(x, y, seg[1], seg[2], seg[3], seg[4]);
      return [['C', q.c1x, q.c1y, q.c2x, q.c2y, q.x, q.y]];
    }
    return undefined;
  });
  return p.round(Math.max(0, Math.min(12, precision))).toString();
}

export function serializePathForAlight(d, precision = 8) {
  const p = canonicalPathObject(d);
  const out = [];
  p.iterate((seg, _idx, x, y) => {
    const cmd = String(seg[0] || '').toUpperCase();
    const n = (v) => pathNumber(v, precision);
    if (cmd === 'M') out.push(`M ${n(seg[1])} ${n(seg[2])}`);
    else if (cmd === 'L') out.push(`L ${n(seg[1])} ${n(seg[2])}`);
    else if (cmd === 'H') out.push(`L ${n(seg[1])} ${n(y)}`);
    else if (cmd === 'V') out.push(`L ${n(x)} ${n(seg[1])}`);
    else if (cmd === 'Q') {
      const q = quadraticToCubic(x, y, seg[1], seg[2], seg[3], seg[4]);
      out.push(`C ${n(q.c1x)} ${n(q.c1y)}, ${n(q.c2x)} ${n(q.c2y)}, ${n(q.x)} ${n(q.y)}`);
    } else if (cmd === 'C') {
      out.push(`C ${n(seg[1])} ${n(seg[2])}, ${n(seg[3])} ${n(seg[4])}, ${n(seg[5])} ${n(seg[6])}`);
    } else if (cmd === 'Z') out.push('Z');
    else throw new Error(`Command path ${cmd || '?'} tidak didukung profil Alight Motion.`);
  });
  const result = out.join('');
  if (!result.startsWith('M ')) throw new Error('Path Alight Motion harus dimulai dengan M.');
  return result;
}

export function pathNodeCount(d) {
  let count = 0;
  try {
    canonicalPathObject(d).iterate((seg) => {
      if (String(seg[0]).toUpperCase() !== 'Z') count++;
    });
  } catch {
    return 0;
  }
  return count;
}

function collectSubpaths(d) {
  const p = canonicalPathObject(d);
  const subpaths = [];
  let current = null;

  p.iterate((seg, _idx, x, y) => {
    const cmd = String(seg[0] || '').toUpperCase();
    if (cmd === 'M') {
      current = { move: [finite(seg[1]), finite(seg[2])], segments: [], closed: false };
      subpaths.push(current);
      return;
    }
    if (!current) return;
    if (cmd === 'L') {
      current.segments.push({ type: 'L', start: [x, y], end: [seg[1], seg[2]] });
    } else if (cmd === 'C') {
      current.segments.push({
        type: 'C', start: [x, y], c1: [seg[1], seg[2]], c2: [seg[3], seg[4]], end: [seg[5], seg[6]]
      });
    } else if (cmd === 'Z') {
      current.closed = true;
    }
  });
  return subpaths;
}

function cubicPoint(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]
  ];
}

function sampleSubpath(subpath, steps = 12) {
  const pts = [subpath.move];
  for (const seg of subpath.segments) {
    if (seg.type === 'L') pts.push(seg.end);
    else {
      for (let i = 1; i <= steps; i++) pts.push(cubicPoint(seg.start, seg.c1, seg.c2, seg.end, i / steps));
    }
  }
  if (subpath.closed) {
    const last = pts.at(-1);
    const first = pts[0];
    if (!last || Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-9) pts.push(first);
  }
  return pts;
}

function signedArea(points) {
  let area = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  }
  return area / 2;
}

function pointInPolygon(point, polygon) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-30) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point, a, b, epsilon) {
  const [px, py] = point;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length <= epsilon) return Math.hypot(px - a[0], py - a[1]) <= epsilon;
  const cross = Math.abs((px - a[0]) * dy - (py - a[1]) * dx) / length;
  if (cross > epsilon) return false;
  const dot = (px - a[0]) * dx + (py - a[1]) * dy;
  return dot >= -epsilon && dot <= dx * dx + dy * dy + epsilon;
}

function segmentRelationship(a, b, c, d, epsilon) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  const sign = (value) => value > epsilon ? 1 : value < -epsilon ? -1 : 0;
  const s1 = sign(o1), s2 = sign(o2), s3 = sign(o3), s4 = sign(o4);
  if (s1 * s2 < 0 && s3 * s4 < 0) return 'CROSSING';
  if ((s1 === 0 && pointOnSegment(c, a, b, epsilon)) ||
      (s2 === 0 && pointOnSegment(d, a, b, epsilon)) ||
      (s3 === 0 && pointOnSegment(a, c, d, epsilon)) ||
      (s4 === 0 && pointOnSegment(b, c, d, epsilon))) return 'TOUCHING';
  return 'DISJOINT';
}

function closedPolygons(d, curveSteps) {
  return collectSubpaths(d).map((subpath) => {
    const points = sampleSubpath(subpath, curveSteps);
    if (points.length < 2) return points;
    const first = points[0];
    const last = points.at(-1);
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-9) points.push(first);
    return points;
  }).filter((points) => points.length >= 4);
}

function pointInPaint(point, polygons, fillRule, epsilon) {
  for (const polygon of polygons) {
    for (let i = 0; i + 1 < polygon.length; i++) {
      if (pointOnSegment(point, polygon[i], polygon[i + 1], epsilon)) return null;
    }
  }
  const hits = polygons.filter((polygon) => pointInPolygon(point, polygon));
  if (fillRule === 'evenodd') return hits.length % 2 === 1;
  const winding = hits.reduce((sum, polygon) => sum + Math.sign(signedArea(polygon)), 0);
  return winding !== 0;
}

function interiorSamples(polygons, fillRule, epsilon) {
  const output = [];
  const pushIfPainted = (point) => {
    if (!point || output.length >= 64) return;
    if (pointInPaint(point, polygons, fillRule, epsilon) === true) output.push(point);
  };
  for (const polygon of polygons) {
    pushIfPainted(polygonCentroid(polygon));
    const xs = polygon.map((point) => point[0]);
    const ys = polygon.map((point) => point[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    for (let yi = 1; yi < 8 && output.length < 64; yi++) {
      for (let xi = 1; xi < 8 && output.length < 64; xi++) {
        pushIfPainted([minX + (maxX - minX) * xi / 8, minY + (maxY - minY) * yi / 8]);
      }
    }
    const average = [
      polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length,
      polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length
    ];
    for (let i = 0; i + 1 < polygon.length && output.length < 64; i++) {
      pushIfPainted([(polygon[i][0] + average[0]) / 2, (polygon[i][1] + average[1]) / 2]);
    }
  }
  return output;
}

// A deterministic narrow phase for filled SVG paths. Bounds remain the broad
// phase in the planner. Curves are flattened only for topology classification;
// the original Bézier geometry is never changed or merged in serialized XML.
export function classifyFilledPathRelationship(
  pathA,
  pathB,
  { fillRuleA = 'nonzero', fillRuleB = 'nonzero', curveSteps = 24, epsilon = 1e-7 } = {}
) {
  try {
    const polygonsA = closedPolygons(pathA, curveSteps);
    const polygonsB = closedPolygons(pathB, curveSteps);
    if (!polygonsA.length || !polygonsB.length) return 'UNKNOWN';

    let touching = false;
    for (const a of polygonsA) {
      for (const b of polygonsB) {
        for (let ai = 0; ai + 1 < a.length; ai++) {
          for (let bi = 0; bi + 1 < b.length; bi++) {
            const relationship = segmentRelationship(a[ai], a[ai + 1], b[bi], b[bi + 1], epsilon);
            if (relationship === 'CROSSING') return 'OVERLAPPING';
            if (relationship === 'TOUCHING') touching = true;
          }
        }
      }
    }

    const samplesA = interiorSamples(polygonsA, String(fillRuleA).toLowerCase(), epsilon);
    const samplesB = interiorSamples(polygonsB, String(fillRuleB).toLowerCase(), epsilon);
    if (!samplesA.length || !samplesB.length) return 'UNKNOWN';
    const aInsideB = samplesA.some((point) => pointInPaint(point, polygonsB, String(fillRuleB).toLowerCase(), epsilon) === true);
    const bInsideA = samplesB.some((point) => pointInPaint(point, polygonsA, String(fillRuleA).toLowerCase(), epsilon) === true);

    if (aInsideB && bInsideA) return 'OVERLAPPING';
    if (bInsideA) return 'CONTAINS';
    if (aInsideB) return 'INSIDE';
    if (touching) return 'TOUCHING';
    return 'DISJOINT';
  } catch {
    return 'UNKNOWN';
  }
}

function polygonCentroid(points) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const cross = points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
    a += cross;
    cx += (points[i][0] + points[i + 1][0]) * cross;
    cy += (points[i][1] + points[i + 1][1]) * cross;
  }
  if (Math.abs(a) < 1e-12) return null;
  return [cx / (3 * a), cy / (3 * a)];
}

function representativePoint(points) {
  const candidates = [];
  const centroid = polygonCentroid(points);
  if (centroid) candidates.push(centroid);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  candidates.push([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
  const avg = [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  candidates.push(avg);
  for (let i = 0; i + 1 < Math.min(points.length, 24); i++) {
    candidates.push([(points[i][0] + avg[0]) / 2, (points[i][1] + avg[1]) / 2]);
  }
  return candidates.find((p) => pointInPolygon(p, points)) || avg;
}

function reverseClosedSubpath(subpath) {
  const edges = [...subpath.segments];
  const last = edges.at(-1)?.end || subpath.move;
  if (Math.hypot(last[0] - subpath.move[0], last[1] - subpath.move[1]) > 1e-9) {
    edges.push({ type: 'L', start: last, end: subpath.move, implicitClose: true });
  }
  const reversed = [];
  for (const edge of [...edges].reverse()) {
    if (edge.type === 'C') {
      reversed.push({ type: 'C', start: edge.end, c1: edge.c2, c2: edge.c1, end: edge.start });
    } else {
      reversed.push({ type: 'L', start: edge.end, end: edge.start, implicitClose: edge.implicitClose });
    }
  }
  return { move: subpath.move, segments: reversed, closed: true };
}

function subpathsToPath(subpaths) {
  let d = '';
  for (const sp of subpaths) {
    d += `M${rawNumber(sp.move[0])} ${rawNumber(sp.move[1])}`;
    for (const seg of sp.segments) {
      if (seg.implicitClose) {
        d += `L${rawNumber(seg.end[0])} ${rawNumber(seg.end[1])}`;
      } else if (seg.type === 'L') {
        d += `L${rawNumber(seg.end[0])} ${rawNumber(seg.end[1])}`;
      } else {
        d += `C${rawNumber(seg.c1[0])} ${rawNumber(seg.c1[1])} ${rawNumber(seg.c2[0])} ${rawNumber(seg.c2[1])} ${rawNumber(seg.end[0])} ${rawNumber(seg.end[1])}`;
      }
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}

// Alight Motion XML samples do not expose an explicit fill-rule attribute.
// For simple nested even-odd contours we preserve the visual result by
// alternating subpath winding while leaving every Bézier segment exact.
export function normalizeEvenOddToNonZero(d) {
  const subpaths = collectSubpaths(d);
  const closed = subpaths
    .map((sp, index) => ({ sp, index, poly: sp.closed ? sampleSubpath(sp) : null }))
    .filter((x) => x.poly && x.poly.length >= 4)
    .map((x) => ({ ...x, area: signedArea(x.poly) }));

  if (closed.length < 2) return { path: d, changed: false, uncertain: false };
  const largest = [...closed].sort((a, b) => Math.abs(b.area) - Math.abs(a.area))[0];
  const outerSign = Math.sign(largest.area) || 1;
  let changed = false;

  for (const item of closed) {
    const point = representativePoint(item.poly);
    let depth = 0;
    for (const other of closed) {
      if (other === item || Math.abs(other.area) <= Math.abs(item.area)) continue;
      if (pointInPolygon(point, other.poly)) depth++;
    }
    const desired = depth % 2 === 0 ? outerSign : -outerSign;
    if ((Math.sign(item.area) || desired) !== desired) {
      subpaths[item.index] = reverseClosedSubpath(item.sp);
      changed = true;
    }
  }

  return { path: changed ? subpathsToPath(subpaths) : d, changed, uncertain: false };
}

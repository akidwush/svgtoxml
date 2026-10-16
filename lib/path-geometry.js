import svgpath from 'svgpath';
import {
  quadraticToCubic,
  expandArcsToCubics,
  normalizePathForAlight,
  serializePathForAlight,
  pathNodeCount,
  normalizeEvenOddToNonZero
} from './path-geometry-core.js';

export {
  quadraticToCubic,
  expandArcsToCubics,
  normalizePathForAlight,
  serializePathForAlight,
  pathNodeCount,
  normalizeEvenOddToNonZero
};

const DEFAULT_CURVE_STEPS = 24;
const DEFAULT_EPSILON = 1e-7;
const DEFAULT_MAX_WORK_UNITS = 20_000_000;
const SEGMENT_TREE_LEAF_SIZE = 8;
let activeGeometryScope = null;

function finite(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Path berisi koordinat non-finite.');
  return n;
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

function sampleSubpath(subpath, steps = DEFAULT_CURVE_STEPS) {
  const points = [subpath.move];
  for (const seg of subpath.segments) {
    if (seg.type === 'L') points.push(seg.end);
    else {
      for (let i = 1; i <= steps; i++) {
        points.push(cubicPoint(seg.start, seg.c1, seg.c2, seg.end, i / steps));
      }
    }
  }
  if (subpath.closed) {
    const first = points[0];
    const last = points.at(-1);
    if (!last || Math.hypot(last[0] - first[0], last[1] - first[1]) > 1e-9) points.push(first);
  }
  return points;
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

function polygonCentroid(points) {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const cross = points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
    area += cross;
    cx += (points[i][0] + points[i + 1][0]) * cross;
    cy += (points[i][1] + points[i + 1][1]) * cross;
  }
  if (Math.abs(area) < 1e-12) return null;
  return [cx / (3 * area), cy / (3 * area)];
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

function segmentRecord(a, b, index) {
  return {
    a,
    b,
    index,
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1])
  };
}

function geometryBounds(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function segmentCollectionBounds(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const segment of segments) {
    minX = Math.min(minX, segment.minX);
    minY = Math.min(minY, segment.minY);
    maxX = Math.max(maxX, segment.maxX);
    maxY = Math.max(maxY, segment.maxY);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function buildSegmentTree(segments) {
  if (!segments.length) return null;

  const build = (items) => {
    const bounds = segmentCollectionBounds(items);
    if (items.length <= SEGMENT_TREE_LEAF_SIZE) return { bounds, segments: items };

    const spanX = bounds[2] - bounds[0];
    const spanY = bounds[3] - bounds[1];
    const axis = spanX >= spanY ? 'x' : 'y';
    const sorted = [...items].sort((a, b) => {
      const ac = axis === 'x' ? a.minX + a.maxX : a.minY + a.maxY;
      const bc = axis === 'x' ? b.minX + b.maxX : b.minY + b.maxY;
      return ac - bc || a.index - b.index;
    });
    const middle = Math.floor(sorted.length / 2);
    return {
      bounds,
      left: build(sorted.slice(0, middle)),
      right: build(sorted.slice(middle))
    };
  };

  return build(segments);
}

function scopeStats(scope = activeGeometryScope) {
  if (!scope) return null;
  const { cache: _cache, ...stats } = scope;
  return { ...stats };
}

function safeScopeDiagnostics(scope) {
  if (!scope) return null;
  return {
    engine: 'smart-color-groups',
    preparedGeometries: scope.preparedGeometries,
    preparedSegments: scope.preparedSegments,
    geometryCacheHits: scope.geometryCacheHits,
    samplePreparations: scope.samplePreparations,
    spatialNodeTests: scope.spatialNodeTests,
    spatialNodeRejected: scope.spatialNodeRejected,
    pointSpatialNodeTests: scope.pointSpatialNodeTests,
    pointSpatialNodeRejected: scope.pointSpatialNodeRejected,
    segmentBoundsTests: scope.segmentBoundsTests,
    segmentBoundsRejected: scope.segmentBoundsRejected,
    segmentComparisons: scope.segmentComparisons,
    paintPointTests: scope.paintPointTests,
    geometryWorkUnits: scope.workUnits,
    geometryWorkLimit: scope.maxWorkUnits
  };
}

function complexityLimitError(scope) {
  const error = new Error('Smart Color Groups menghentikan audit topology karena batas kerja geometry terlampaui. Gunakan input yang lebih sederhana atau engine fidelity tanpa color grouping.');
  error.code = 'COLOR_GROUP_COMPLEXITY_LIMIT';
  error.geometryWork = scope.workUnits;
  error.diagnostics = safeScopeDiagnostics(scope);
  return error;
}

function consumeWork(amount = 1) {
  const scope = activeGeometryScope;
  if (!scope) return;
  scope.workUnits += amount;
  if (scope.workUnits > scope.maxWorkUnits) throw complexityLimitError(scope);
}

export function withFilledPathGeometryScope(callback, { maxWorkUnits = DEFAULT_MAX_WORK_UNITS } = {}) {
  const parent = activeGeometryScope;
  const numericLimit = Number(maxWorkUnits);
  const scope = {
    cache: new Map(),
    maxWorkUnits: Number.isFinite(numericLimit) && numericLimit > 0 ? Math.floor(numericLimit) : DEFAULT_MAX_WORK_UNITS,
    workUnits: 0,
    preparedGeometries: 0,
    preparedSegments: 0,
    geometryCacheHits: 0,
    samplePreparations: 0,
    spatialNodeTests: 0,
    spatialNodeRejected: 0,
    pointSpatialNodeTests: 0,
    pointSpatialNodeRejected: 0,
    segmentBoundsTests: 0,
    segmentBoundsRejected: 0,
    segmentComparisons: 0,
    paintPointTests: 0
  };
  activeGeometryScope = scope;
  try {
    return callback(scope);
  } finally {
    activeGeometryScope = parent;
  }
}

export function getFilledPathGeometryScopeStats() {
  return scopeStats();
}

export function prepareFilledPathGeometry(
  path,
  { fillRule = 'nonzero', curveSteps = DEFAULT_CURVE_STEPS, epsilon = DEFAULT_EPSILON } = {}
) {
  const normalizedRule = String(fillRule).toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
  const steps = Math.max(1, Math.min(128, Math.round(Number(curveSteps) || DEFAULT_CURVE_STEPS)));
  const eps = Number.isFinite(Number(epsilon)) && Number(epsilon) > 0 ? Number(epsilon) : DEFAULT_EPSILON;
  const key = `${steps}\u0000${eps}\u0000${String(path)}`;
  const scope = activeGeometryScope;
  let base = scope?.cache.get(key);

  if (base) {
    scope.geometryCacheHits++;
  } else {
    const polygons = closedPolygons(path, steps);
    if (!polygons.length) return null;
    const segments = [];
    for (const polygon of polygons) {
      for (let i = 0; i + 1 < polygon.length; i++) {
        segments.push(segmentRecord(polygon[i], polygon[i + 1], segments.length));
      }
    }
    base = {
      polygons,
      segments,
      segmentTree: buildSegmentTree(segments),
      bounds: geometryBounds(polygons),
      samplesByRule: new Map()
    };
    if (scope) {
      scope.cache.set(key, base);
      scope.preparedGeometries++;
      scope.preparedSegments += segments.length;
    }
  }

  let samples = base.samplesByRule.get(normalizedRule);
  if (!samples) {
    samples = interiorSamples(base.polygons, normalizedRule, eps);
    base.samplesByRule.set(normalizedRule, samples);
    if (scope) scope.samplePreparations++;
  }

  return {
    polygons: base.polygons,
    segments: base.segments,
    segmentTree: base.segmentTree,
    bounds: base.bounds,
    samples,
    fillRule: normalizedRule,
    epsilon: eps
  };
}

function boundsDisjoint(a, b, epsilon) {
  if (!a || !b) return false;
  return a[2] < b[0] - epsilon || b[2] < a[0] - epsilon ||
    a[3] < b[1] - epsilon || b[3] < a[1] - epsilon;
}

function segmentBoundsDisjoint(a, b, epsilon) {
  return a.maxX < b.minX - epsilon || b.maxX < a.minX - epsilon ||
    a.maxY < b.minY - epsilon || b.maxY < a.minY - epsilon;
}

function pointOutsideBounds(point, bounds, epsilon) {
  return !bounds || point[0] < bounds[0] - epsilon || point[0] > bounds[2] + epsilon ||
    point[1] < bounds[1] - epsilon || point[1] > bounds[3] + epsilon;
}

function pointTouchesPreparedBoundary(point, prepared) {
  const epsilon = prepared.epsilon;
  const scope = activeGeometryScope;
  if (!prepared.segmentTree) return false;
  const stack = [prepared.segmentTree];
  while (stack.length) {
    const node = stack.pop();
    if (scope) scope.pointSpatialNodeTests++;
    if (pointOutsideBounds(point, node.bounds, epsilon)) {
      if (scope) scope.pointSpatialNodeRejected++;
      continue;
    }
    if (node.segments) {
      for (const segment of node.segments) {
        if (point[0] < segment.minX - epsilon || point[0] > segment.maxX + epsilon ||
            point[1] < segment.minY - epsilon || point[1] > segment.maxY + epsilon) continue;
        if (pointOnSegment(point, segment.a, segment.b, epsilon)) return true;
      }
      continue;
    }
    if (node.right) stack.push(node.right);
    if (node.left) stack.push(node.left);
  }
  return false;
}

function pointInPreparedPaint(point, prepared) {
  const scope = activeGeometryScope;
  if (scope) scope.paintPointTests++;
  consumeWork(1);
  if (pointTouchesPreparedBoundary(point, prepared)) return null;
  const hits = prepared.polygons.filter((polygon) => pointInPolygon(point, polygon));
  if (prepared.fillRule === 'evenodd') return hits.length % 2 === 1;
  const winding = hits.reduce((sum, polygon) => sum + Math.sign(signedArea(polygon)), 0);
  return winding !== 0;
}

function segmentTreeRelationship(preparedA, preparedB, epsilon) {
  if (!preparedA.segmentTree || !preparedB.segmentTree) return { crossing: false, touching: false };
  const scope = activeGeometryScope;
  const stack = [[preparedA.segmentTree, preparedB.segmentTree]];
  let touching = false;

  while (stack.length) {
    const [nodeA, nodeB] = stack.pop();
    if (scope) scope.spatialNodeTests++;
    if (boundsDisjoint(nodeA.bounds, nodeB.bounds, epsilon)) {
      if (scope) scope.spatialNodeRejected++;
      continue;
    }

    const leafA = Array.isArray(nodeA.segments);
    const leafB = Array.isArray(nodeB.segments);
    if (leafA && leafB) {
      for (const a of nodeA.segments) {
        for (const b of nodeB.segments) {
          if (scope) scope.segmentBoundsTests++;
          if (segmentBoundsDisjoint(a, b, epsilon)) {
            if (scope) scope.segmentBoundsRejected++;
            continue;
          }
          if (scope) scope.segmentComparisons++;
          // Work units represent the expensive exact relationship operation.
          // Cheap BVH/bounds rejections are tracked separately and do not burn
          // the safety budget merely for proving that segments are far apart.
          consumeWork(1);
          const relationship = segmentRelationship(a.a, a.b, b.a, b.b, epsilon);
          if (relationship === 'CROSSING') return { crossing: true, touching };
          if (relationship === 'TOUCHING') touching = true;
        }
      }
      continue;
    }

    if (leafA) {
      if (nodeB.right) stack.push([nodeA, nodeB.right]);
      if (nodeB.left) stack.push([nodeA, nodeB.left]);
      continue;
    }
    if (leafB) {
      if (nodeA.right) stack.push([nodeA.right, nodeB]);
      if (nodeA.left) stack.push([nodeA.left, nodeB]);
      continue;
    }

    if (nodeA.right && nodeB.right) stack.push([nodeA.right, nodeB.right]);
    if (nodeA.right && nodeB.left) stack.push([nodeA.right, nodeB.left]);
    if (nodeA.left && nodeB.right) stack.push([nodeA.left, nodeB.right]);
    if (nodeA.left && nodeB.left) stack.push([nodeA.left, nodeB.left]);
  }

  return { crossing: false, touching };
}

export function classifyPreparedFilledPathRelationship(preparedA, preparedB) {
  if (!preparedA || !preparedB) return 'UNKNOWN';
  const epsilon = Math.max(preparedA.epsilon || DEFAULT_EPSILON, preparedB.epsilon || DEFAULT_EPSILON);
  if (boundsDisjoint(preparedA.bounds, preparedB.bounds, epsilon)) return 'DISJOINT';

  const boundary = segmentTreeRelationship(preparedA, preparedB, epsilon);
  if (boundary.crossing) return 'OVERLAPPING';

  if (!preparedA.samples.length || !preparedB.samples.length) return 'UNKNOWN';
  const aInsideB = preparedA.samples.some((point) => pointInPreparedPaint(point, preparedB) === true);
  const bInsideA = preparedB.samples.some((point) => pointInPreparedPaint(point, preparedA) === true);

  if (aInsideB && bInsideA) return 'OVERLAPPING';
  if (bInsideA) return 'CONTAINS';
  if (aInsideB) return 'INSIDE';
  if (boundary.touching) return 'TOUCHING';
  return 'DISJOINT';
}

export function classifyFilledPathRelationship(
  pathA,
  pathB,
  { fillRuleA = 'nonzero', fillRuleB = 'nonzero', curveSteps = DEFAULT_CURVE_STEPS, epsilon = DEFAULT_EPSILON } = {}
) {
  try {
    const preparedA = prepareFilledPathGeometry(pathA, { fillRule: fillRuleA, curveSteps, epsilon });
    const preparedB = prepareFilledPathGeometry(pathB, { fillRule: fillRuleB, curveSteps, epsilon });
    return classifyPreparedFilledPathRelationship(preparedA, preparedB);
  } catch (error) {
    if (error?.code === 'COLOR_GROUP_COMPLEXITY_LIMIT') throw error;
    return 'UNKNOWN';
  }
}

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { convertSvgToAlightXml } from '../lib/converter.js';

const SHAPE_COUNT = 987;
const TARGET_MS = 8000;
const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'];

// Captured on GitHub Actions before this repair from the same synthetic fixture.
// These values are a forensic reference only; do not treat cross-run timings as
// an apples-to-apples speedup claim.
const BEFORE_REFERENCE = Object.freeze({
  inputBytes: 1219087,
  inputShapes: 987,
  pathCount: 987,
  sourcePathNodes: 78148,
  overlapCandidates: 10027,
  geometryChecks: 10027,
  preparedGeometries: 987,
  geometryCacheHits: 19067,
  segmentBoundsTests: 22242968,
  segmentBoundsRejected: 22230869,
  segmentComparisons: 12099,
  paintPointTests: 221696,
  geometryWorkUnits: 22464664,
  totalMs: 1603.198,
  planningMs: 1243.083,
  productionGuard: 'COLOR_GROUP_COMPLEXITY_LIMIT@20000001'
});

function denseCirclePath(cx, cy, radius, points = 80) {
  const coords = [];
  for (let i = 0; i < points; i++) {
    const angle = (Math.PI * 2 * i) / points;
    const wobble = 1 + Math.sin(i * 5) * 0.035;
    coords.push([
      cx + Math.cos(angle) * radius * wobble,
      cy + Math.sin(angle) * radius * wobble
    ]);
  }
  return coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point[0].toFixed(3)} ${point[1].toFixed(3)}`).join('') + 'Z';
}

function cubicLoopPath(cx, cy, radius) {
  const k = 0.5522847498307936;
  const r = radius;
  const c = r * k;
  return [
    `M${(cx + r).toFixed(3)} ${cy.toFixed(3)}`,
    `C${(cx + r).toFixed(3)} ${(cy + c).toFixed(3)} ${(cx + c).toFixed(3)} ${(cy + r).toFixed(3)} ${cx.toFixed(3)} ${(cy + r).toFixed(3)}`,
    `C${(cx - c).toFixed(3)} ${(cy + r).toFixed(3)} ${(cx - r).toFixed(3)} ${(cy + c).toFixed(3)} ${(cx - r).toFixed(3)} ${cy.toFixed(3)}`,
    `C${(cx - r).toFixed(3)} ${(cy - c).toFixed(3)} ${(cx - c).toFixed(3)} ${(cy - r).toFixed(3)} ${cx.toFixed(3)} ${(cy - r).toFixed(3)}`,
    `C${(cx + c).toFixed(3)} ${(cy - r).toFixed(3)} ${(cx + r).toFixed(3)} ${(cy - c).toFixed(3)} ${(cx + r).toFixed(3)} ${cy.toFixed(3)}Z`
  ].join('');
}

function donutPath(cx, cy, radius) {
  return `${denseCirclePath(cx, cy, radius, 80)} ${denseCirclePath(cx, cy, radius * 0.42, 40)}`;
}

function fixture(count = SHAPE_COUNT) {
  const columns = 33;
  const spacing = 9;
  const radius = 11;
  const shapes = [];
  let sourcePathNodes = 0;
  for (let index = 0; index < count; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cx = 16 + column * spacing;
    const cy = 16 + row * spacing;
    const color = colors[index % colors.length];
    let d;
    let fillRule = '';
    if (index % 29 === 0) {
      d = donutPath(cx, cy, radius);
      fillRule = ' fill-rule="evenodd"';
      sourcePathNodes += 124;
    } else if (index % 17 === 0) {
      d = cubicLoopPath(cx, cy, radius);
      sourcePathNodes += 6;
    } else {
      d = denseCirclePath(cx, cy, radius, 80);
      sourcePathNodes += 82;
    }
    shapes.push(`<path id="dense-${index}" fill="${color}"${fillRule} d="${d}"/>`);
  }
  return {
    svg: `<svg width="${columns * spacing + 32}" height="${Math.ceil(count / columns) * spacing + 32}" xmlns="http://www.w3.org/2000/svg">${shapes.join('')}</svg>`,
    sourcePathNodes
  };
}

function stableAudit(grouping) {
  return {
    inputShapes: grouping.inputShapes,
    overlapCandidates: grouping.overlapCandidates,
    geometryChecks: grouping.geometryChecks,
    preparedGeometries: grouping.preparedGeometries,
    preparedSegments: grouping.preparedSegments,
    geometryCacheHits: grouping.geometryCacheHits,
    spatialNodeTests: grouping.spatialNodeTests,
    spatialNodeRejected: grouping.spatialNodeRejected,
    segmentBoundsTests: grouping.segmentBoundsTests,
    segmentBoundsRejected: grouping.segmentBoundsRejected,
    segmentComparisons: grouping.segmentComparisons,
    paintPointTests: grouping.paintPointTests,
    geometryWorkUnits: grouping.geometryWorkUnits,
    geometryWorkLimit: grouping.geometryWorkLimit,
    actualOverlaps: grouping.actualOverlaps,
    touchingPairs: grouping.touchingPairs,
    unknownPairs: grouping.unknownPairs,
    zOrderConstraints: grouping.zOrderConstraints
  };
}

function run(svg) {
  const started = performance.now();
  const output = convertSvgToAlightXml(svg, { quality: 'color-groups', includeTimings: true });
  return { output, totalMs: performance.now() - started };
}

const input = fixture();
const inputBytes = Buffer.byteLength(input.svg, 'utf8');
assert.equal(inputBytes, BEFORE_REFERENCE.inputBytes, 'fixture bytes drifted from captured baseline');
assert.equal(input.sourcePathNodes, BEFORE_REFERENCE.sourcePathNodes, 'fixture topology drifted from captured baseline');

const first = run(input.svg);
const second = run(input.svg);
const audit = stableAudit(first.output.grouping);

assert.equal(first.output.profile.engine, 'smart-color-groups');
assert.equal(first.output.grouping.geometryMerged, false);
assert.equal(first.output.grouping.preservesInternalShapes, true);
assert.equal(first.output.grouping.inputShapes, SHAPE_COUNT);
assert.ok(first.output.grouping.spatialNodeTests > 0);
assert.ok(first.output.grouping.spatialNodeRejected > 0);
assert.ok(first.output.grouping.geometryWorkUnits < first.output.grouping.geometryWorkLimit);
assert.ok(first.output.grouping.segmentBoundsTests < BEFORE_REFERENCE.segmentBoundsTests / 4,
  'segment-pair broad phase did not reduce enough versus captured Cartesian baseline');
assert.deepEqual(audit, stableAudit(second.output.grouping), 'real-complex topology audit must remain deterministic');
assert.ok(first.totalMs < TARGET_MS, `real-complex benchmark exceeded ${TARGET_MS} ms: ${first.totalMs.toFixed(3)} ms`);
assert.ok(second.totalMs < TARGET_MS, `second real-complex benchmark exceeded ${TARGET_MS} ms: ${second.totalMs.toFixed(3)} ms`);

console.log('REAL_COMPLEX_BEFORE_REFERENCE', JSON.stringify(BEFORE_REFERENCE));
console.table([{
  fixture: 'synthetic-real-complex-v1',
  inputBytes,
  inputShapes: audit.inputShapes,
  pathCount: SHAPE_COUNT,
  sourcePathNodes: input.sourcePathNodes,
  totalMs: Number(first.totalMs.toFixed(3)),
  planningMs: first.output.grouping.timingsMs?.planning,
  overlapCandidates: audit.overlapCandidates,
  geometryChecks: audit.geometryChecks,
  preparedGeometries: audit.preparedGeometries,
  preparedSegments: audit.preparedSegments,
  geometryCacheHits: audit.geometryCacheHits,
  spatialNodeTests: audit.spatialNodeTests,
  spatialNodeRejected: audit.spatialNodeRejected,
  segmentBoundsTests: audit.segmentBoundsTests,
  segmentBoundsRejected: audit.segmentBoundsRejected,
  segmentComparisons: audit.segmentComparisons,
  paintPointTests: audit.paintPointTests,
  geometryWorkUnits: audit.geometryWorkUnits,
  geometryWorkLimit: audit.geometryWorkLimit
}]);

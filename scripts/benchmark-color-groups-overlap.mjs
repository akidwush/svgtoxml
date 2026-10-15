import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { convertSvgToAlightXml } from '../lib/converter.js';

const SHAPE_COUNT = 987;
const TARGET_MS = 8000;
const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'];

function fixture(count = SHAPE_COUNT) {
  const columns = 33;
  const rows = Math.ceil(count / columns);
  const shapes = Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * 8;
    const y = row * 8;
    const color = colors[index % colors.length];

    if (index % 37 === 0) {
      return `<path id="donut-${index}" fill="${color}" fill-rule="evenodd" d="M${x} ${y}H${x + 18}V${y + 18}H${x}Z M${x + 6} ${y + 6}H${x + 12}V${y + 12}H${x + 6}Z"/>`;
    }
    if (index % 19 === 0) {
      return `<path id="curve-${index}" fill="${color}" d="M${x} ${y + 9}C${x} ${y + 1} ${x + 18} ${y + 1} ${x + 18} ${y + 9}C${x + 18} ${y + 17} ${x} ${y + 17} ${x} ${y + 9}Z"/>`;
    }
    if (index % 17 === 0) {
      return `<rect id="touch-${index}" x="${x}" y="${y}" width="8" height="8" fill="${color}"/>`;
    }
    return `<rect id="rect-${index}" x="${x}" y="${y}" width="18" height="18" fill="${color}"/>`;
  }).join('');

  return `<svg width="${columns * 8 + 18}" height="${rows * 8 + 18}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;
}

function stableAudit(grouping) {
  return {
    inputShapes: grouping.inputShapes,
    overlapCandidates: grouping.overlapCandidates,
    geometryChecks: grouping.geometryChecks,
    actualOverlaps: grouping.actualOverlaps,
    touchingPairs: grouping.touchingPairs,
    unknownPairs: grouping.unknownPairs,
    zOrderConstraints: grouping.zOrderConstraints,
    preparedGeometries: grouping.preparedGeometries,
    geometryCacheHits: grouping.geometryCacheHits,
    segmentBoundsTests: grouping.segmentBoundsTests,
    segmentBoundsRejected: grouping.segmentBoundsRejected,
    segmentComparisons: grouping.segmentComparisons,
    geometryWorkUnits: grouping.geometryWorkUnits
  };
}

function run() {
  const svg = fixture();
  const started = performance.now();
  const output = convertSvgToAlightXml(svg, { quality: 'color-groups', includeTimings: true });
  const totalMs = performance.now() - started;
  return { output, totalMs };
}

const first = run();
const second = run();
const audit = stableAudit(first.output.grouping);

assert.equal(first.output.grouping.inputShapes, SHAPE_COUNT);
assert.ok(first.output.grouping.geometryChecks > 1000, 'fixture must exercise the narrow phase');
assert.ok(first.output.grouping.preparedGeometries <= SHAPE_COUNT);
assert.ok(first.output.grouping.geometryCacheHits > 0);
assert.ok(first.output.grouping.segmentBoundsRejected > 0);
assert.deepEqual(audit, stableAudit(second.output.grouping), 'topology audit must be deterministic');
assert.ok(first.totalMs < TARGET_MS, `overlap-heavy benchmark exceeded ${TARGET_MS} ms: ${first.totalMs.toFixed(3)} ms`);
assert.ok(second.totalMs < TARGET_MS, `second overlap-heavy benchmark exceeded ${TARGET_MS} ms: ${second.totalMs.toFixed(3)} ms`);

console.table([{
  inputShapes: SHAPE_COUNT,
  totalMs: Number(first.totalMs.toFixed(3)),
  parseMs: first.output.grouping.timingsMs?.parse,
  analysisMs: first.output.grouping.timingsMs?.analysis,
  planningMs: first.output.grouping.timingsMs?.planning,
  serializationAndValidationMs: first.output.grouping.timingsMs?.serializationAndValidation,
  overlapCandidates: audit.overlapCandidates,
  geometryChecks: audit.geometryChecks,
  preparedGeometries: audit.preparedGeometries,
  geometryCacheHits: audit.geometryCacheHits,
  segmentBoundsTests: audit.segmentBoundsTests,
  segmentBoundsRejected: audit.segmentBoundsRejected,
  segmentComparisons: audit.segmentComparisons,
  geometryWorkUnits: audit.geometryWorkUnits
}]);

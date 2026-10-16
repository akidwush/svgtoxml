import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';
import {
  classifyFilledPathRelationship,
  getFilledPathGeometryScopeStats,
  withFilledPathGeometryScope
} from '../lib/path-geometry.js';

function overlappingFixture(count = 180) {
  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4'];
  const columns = 18;
  const shapes = Array.from({ length: count }, (_, index) => {
    const x = (index % columns) * 7;
    const y = Math.floor(index / columns) * 7;
    const color = colors[index % colors.length];
    return `<rect id="shape-${index}" x="${x}" y="${y}" width="15" height="15" fill="${color}"/>`;
  }).join('');
  return `<svg width="140" height="100" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;
}

function densePolygonPath(cx, cy, radius, points = 48) {
  const output = [];
  for (let i = 0; i < points; i++) {
    const angle = Math.PI * 2 * i / points;
    output.push(`${i === 0 ? 'M' : 'L'}${(cx + Math.cos(angle) * radius).toFixed(3)} ${(cy + Math.sin(angle) * radius).toFixed(3)}`);
  }
  return `${output.join('')}Z`;
}

function manySegmentFixture(count = 144) {
  const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308'];
  const columns = 12;
  const shapes = Array.from({ length: count }, (_, index) => {
    const cx = 12 + (index % columns) * 9;
    const cy = 12 + Math.floor(index / columns) * 9;
    return `<path id="dense-${index}" fill="${colors[index % colors.length]}" d="${densePolygonPath(cx, cy, 11)}"/>`;
  }).join('');
  return `<svg width="130" height="130" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;
}

test('Smart Color Groups prepares candidate geometry at most once per conversion', () => {
  const out = convertSvgToAlightXml(overlappingFixture(), { quality: 'color-groups' });

  assert.ok(out.grouping.geometryChecks > 0);
  assert.ok(out.grouping.preparedGeometries > 0);
  assert.ok(out.grouping.preparedGeometries <= out.grouping.inputShapes);
  assert.ok(out.grouping.geometryCacheHits > 0);
  assert.ok(out.grouping.spatialNodeTests > 0);
  assert.ok(out.grouping.spatialNodeRejected > 0);
  assert.ok(out.grouping.segmentBoundsTests >= out.grouping.segmentComparisons);
  assert.ok(out.grouping.segmentBoundsRejected > 0);
  assert.ok(out.grouping.geometryWorkUnits > 0);
  assert.equal(out.grouping.geometryWorkLimit, 20_000_000);
});

test('prepared geometry cache is conversion-scoped and resets between runs', () => {
  const first = convertSvgToAlightXml(overlappingFixture(90), { quality: 'color-groups' });
  const second = convertSvgToAlightXml(overlappingFixture(90), { quality: 'color-groups' });

  assert.equal(first.grouping.preparedGeometries, second.grouping.preparedGeometries);
  assert.equal(first.grouping.preparedSegments, second.grouping.preparedSegments);
  assert.equal(first.grouping.geometryCacheHits, second.grouping.geometryCacheHits);
  assert.equal(first.grouping.spatialNodeTests, second.grouping.spatialNodeTests);
  assert.equal(first.grouping.segmentComparisons, second.grouping.segmentComparisons);
  assert.equal(first.grouping.geometryWorkUnits, second.grouping.geometryWorkUnits);
});

test('optimized classifier preserves touching, overlap, containment, inside and hole semantics', () => {
  const squareA = 'M0 0H50V50H0Z';
  const touching = 'M50 0H100V50H50Z';
  const crossing = 'M25 25H75V75H25Z';
  const inside = 'M1 1H2V2H1Z';
  const donut = 'M0 0H100V100H0Z M30 30H70V70H30Z';
  const inHole = 'M40 40H60V60H40Z';

  assert.equal(classifyFilledPathRelationship(squareA, touching), 'TOUCHING');
  assert.equal(classifyFilledPathRelationship(squareA, crossing), 'OVERLAPPING');
  assert.equal(classifyFilledPathRelationship(squareA, inside), 'CONTAINS');
  assert.equal(classifyFilledPathRelationship(inside, squareA), 'INSIDE');
  assert.equal(classifyFilledPathRelationship(donut, inHole, { fillRuleA: 'evenodd' }), 'DISJOINT');
});

test('many-segment dense paths use spatial pruning without silent engine fallback', () => {
  const out = convertSvgToAlightXml(manySegmentFixture(), { quality: 'color-groups' });
  assert.equal(out.profile.quality, 'color-group');
  assert.equal(out.profile.engine, 'smart-color-groups');
  assert.equal(out.grouping.engine, 'smart-color-groups');
  assert.equal(out.grouping.geometryMerged, false);
  assert.equal(out.grouping.preservesInternalShapes, true);
  assert.ok(out.grouping.spatialNodeRejected > 0);
  assert.ok(out.grouping.segmentComparisons > 0);
  assert.ok(out.grouping.geometryWorkUnits < out.grouping.geometryWorkLimit);
});

test('disjoint complex paths are rejected by spatial hierarchy without exact Cartesian scan', () => {
  const left = densePolygonPath(0, 0, 10, 96);
  const right = densePolygonPath(1000, 1000, 10, 96);
  const relationship = withFilledPathGeometryScope(() => {
    const result = classifyFilledPathRelationship(left, right);
    const stats = getFilledPathGeometryScopeStats();
    assert.equal(stats.segmentComparisons, 0);
    assert.equal(stats.geometryWorkUnits, 0);
    return result;
  });
  assert.equal(relationship, 'DISJOINT');
});

test('complexity guard remains fail-closed and exposes only numeric geometry diagnostics', () => {
  assert.throws(
    () => withFilledPathGeometryScope(() => {
      classifyFilledPathRelationship(
        'M0 0H100V100H0Z',
        'M0 0H100V100H0Z'
      );
    }, { maxWorkUnits: 1 }),
    (error) => {
      assert.equal(error?.code, 'COLOR_GROUP_COMPLEXITY_LIMIT');
      assert.equal(error?.diagnostics?.engine, 'smart-color-groups');
      assert.equal(error?.diagnostics?.geometryWorkLimit, 1);
      assert.ok(Number.isFinite(error?.diagnostics?.geometryWorkUnits));
      assert.equal(Object.hasOwn(error?.diagnostics || {}, 'svg'), false);
      assert.equal(Object.hasOwn(error?.diagnostics || {}, 'path'), false);
      return true;
    }
  );
});

test('Maximum Fidelity and Small Patch Cleanup remain independent from Smart Color complexity accounting', () => {
  const svg = manySegmentFixture(24);
  const maximum = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity', requireExact: false });
  const cleanup = convertSvgToAlightXml(svg, { quality: 'small-patch-cleanup', patchAreaPercent: 0, protectThinPercent: 0 });

  assert.equal(maximum.profile.engine, 'maximum-fidelity');
  assert.equal(maximum.profile.quality, 'lossless');
  assert.equal(cleanup.profile.engine, 'small-patch-cleanup');
  assert.equal(cleanup.profile.quality, 'patch-clean');
  assert.equal(cleanup.cleanup.patchAreaPercent, 0);
  assert.equal(cleanup.cleanup.protectThinPercent, 0);
  assert.equal(maximum.grouping, undefined);
  assert.equal(cleanup.grouping, undefined);
});

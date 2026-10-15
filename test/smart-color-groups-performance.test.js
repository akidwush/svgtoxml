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

test('Smart Color Groups prepares candidate geometry at most once per conversion', () => {
  const out = convertSvgToAlightXml(overlappingFixture(), { quality: 'color-groups' });

  assert.ok(out.grouping.geometryChecks > 0);
  assert.ok(out.grouping.preparedGeometries > 0);
  assert.ok(out.grouping.preparedGeometries <= out.grouping.inputShapes);
  assert.ok(out.grouping.geometryCacheHits > 0);
  assert.ok(out.grouping.segmentBoundsTests >= out.grouping.segmentComparisons);
  assert.ok(out.grouping.segmentBoundsRejected > 0);
  assert.ok(out.grouping.geometryWorkUnits > 0);
  assert.equal(out.grouping.geometryWorkLimit, 20_000_000);
});

test('prepared geometry cache is conversion-scoped and resets between runs', () => {
  const first = convertSvgToAlightXml(overlappingFixture(90), { quality: 'color-groups' });
  const second = convertSvgToAlightXml(overlappingFixture(90), { quality: 'color-groups' });

  assert.equal(first.grouping.preparedGeometries, second.grouping.preparedGeometries);
  assert.equal(first.grouping.geometryCacheHits, second.grouping.geometryCacheHits);
  assert.equal(first.grouping.segmentComparisons, second.grouping.segmentComparisons);
  assert.equal(first.grouping.geometryWorkUnits, second.grouping.geometryWorkUnits);
});

test('optimized classifier preserves touching, overlap, containment and hole semantics', () => {
  const squareA = 'M0 0H50V50H0Z';
  const touching = 'M50 0H100V50H50Z';
  const crossing = 'M25 25H75V75H25Z';
  const inside = 'M1 1H2V2H1Z';
  const donut = 'M0 0H100V100H0Z M30 30H70V70H30Z';
  const inHole = 'M40 40H60V60H40Z';

  assert.equal(classifyFilledPathRelationship(squareA, touching), 'TOUCHING');
  assert.equal(classifyFilledPathRelationship(squareA, crossing), 'OVERLAPPING');
  assert.equal(classifyFilledPathRelationship(squareA, inside), 'CONTAINS');
  assert.equal(classifyFilledPathRelationship(donut, inHole, { fillRuleA: 'evenodd' }), 'DISJOINT');
});

test('complexity guard fails closed with a dedicated error code', () => {
  assert.throws(
    () => withFilledPathGeometryScope(() => {
      classifyFilledPathRelationship(
        'M0 0H100V100H0Z',
        'M0 0H100V100H0Z'
      );
      getFilledPathGeometryScopeStats();
    }, { maxWorkUnits: 1 }),
    (error) => error?.code === 'COLOR_GROUP_COMPLEXITY_LIMIT'
  );
});

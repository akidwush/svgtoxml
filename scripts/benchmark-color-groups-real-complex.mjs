import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { convertSvgToAlightXml as convertSvgToAlightXmlCore } from '../lib/converter-core.js';
import { convertSvgToAlightXml } from '../lib/converter.js';
import {
  getFilledPathGeometryScopeStats,
  withFilledPathGeometryScope
} from '../lib/path-geometry.js';

const SHAPE_COUNT = 987;
const PROFILE_WORK_LIMIT = 120_000_000;
const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#06b6d4', '#f97316'];

function round(value) {
  return Number(value.toFixed(3));
}

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
  const outer = denseCirclePath(cx, cy, radius, 80);
  const inner = denseCirclePath(cx, cy, radius * 0.42, 40);
  return `${outer} ${inner}`;
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

const input = fixture();
const inputBytes = Buffer.byteLength(input.svg, 'utf8');
const profileStarted = performance.now();
const profiled = withFilledPathGeometryScope(() => {
  const output = convertSvgToAlightXmlCore(input.svg, { quality: 'color-groups', includeTimings: true });
  return { output, geometry: getFilledPathGeometryScopeStats() };
}, { maxWorkUnits: PROFILE_WORK_LIMIT });
const profileMs = performance.now() - profileStarted;

const before = {
  fixture: 'synthetic-real-complex-v1',
  inputBytes,
  inputShapes: profiled.output.grouping.inputShapes,
  pathCount: SHAPE_COUNT,
  sourcePathNodes: input.sourcePathNodes,
  overlapCandidates: profiled.output.grouping.overlapCandidates,
  geometryChecks: profiled.output.grouping.geometryChecks,
  preparedGeometries: profiled.geometry.preparedGeometries,
  geometryCacheHits: profiled.geometry.geometryCacheHits,
  segmentBoundsTests: profiled.geometry.segmentBoundsTests,
  segmentBoundsRejected: profiled.geometry.segmentBoundsRejected,
  segmentComparisons: profiled.geometry.segmentComparisons,
  paintPointTests: profiled.geometry.paintPointTests,
  geometryWorkUnits: profiled.geometry.workUnits,
  geometryWorkLimit: profiled.geometry.maxWorkUnits,
  totalMs: round(profileMs),
  planningMs: profiled.output.grouping.timingsMs?.planning
};
console.log('REAL_COMPLEX_BASELINE', JSON.stringify(before));

let productionFailure = null;
try {
  convertSvgToAlightXml(input.svg, { quality: 'color-groups', includeTimings: true });
} catch (error) {
  productionFailure = error;
}

assert.equal(productionFailure?.code, 'COLOR_GROUP_COMPLEXITY_LIMIT', 'baseline fixture must reproduce the production complexity guard before the algorithm repair');
console.log('REAL_COMPLEX_PRODUCTION_GUARD', JSON.stringify({
  code: productionFailure.code,
  geometryWork: productionFailure.geometryWork
}));

throw new Error('BASELINE_PROFILE_ONLY: expected pre-repair Smart Color Groups complexity failure captured.');

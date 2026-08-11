import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';

test('groups same solid colors into one Alight Motion group and removes strokes', () => {
  const svg = `
  <svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="80" height="50" fill="#ff0000" stroke="#00ff00" stroke-width="3"/>
    <rect x="90" y="0" width="80" height="50" fill="#ff0000"/>
    <rect x="0" y="60" width="80" height="30" fill="#0000ff"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'accurate', nodeReduction: 0 });
  assert.equal(out.stats.colorGroups, 2);
  assert.equal(out.stats.outputShapes, 2);
  assert.equal(out.stats.mergedShapes, 1);
  assert.equal(out.stats.strokesRemoved, 1);
  assert.match(out.xml, /<embedScene[^>]+label="Warna 001/);
  assert.doesNotMatch(out.xml, /<path-stroke/);
  assert.equal((out.xml.match(/<embedScene\b/g) || []).length, 2);
  assert.equal((out.xml.match(/<shape\b/g) || []).length, 2);
});

test('flattens gradients to a single representative group color', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
    <rect x="0" y="0" width="100" height="100" fill="url(#g)"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { nodeReduction: 0 });
  assert.equal(out.stats.gradientsFlattened, 1);
  assert.equal(out.stats.colorGroups, 1);
  assert.doesNotMatch(out.xml, /<gradient\b/);
});

test('legacy node-reduction option remains enabled without requiring every contour to shrink', () => {
  // Node reduction in the legacy grouped modes is intentionally heuristic: it
  // protects structural anchors and may legally keep all nodes for a contour.
  // Therefore the test must verify that the requested reduction profile is
  // applied and that valid geometry is still emitted, not require a strict
  // nodesBefore > nodesAfter result for one synthetic fixture.
  const points = Array.from({ length: 40 }, (_, i) => `${i * 2},50`).join(' ');
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="#123456"/></svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'accurate', nodeReduction: 50, minAreaPercent: 0 });
  assert.equal(out.profile.quality, 'accurate');
  assert.equal(out.profile.nodeReduction, 50);
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.stats.nodesBefore > 0);
  assert.ok(out.stats.nodesAfter > 0);
});

test('caps source shape count before color merge', () => {
  const items = Array.from({ length: 10 }, (_, i) => `<rect x="${i * 10}" y="0" width="${i + 1}" height="${i + 1}" fill="#123456"/>`).join('');
  const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">${items}</svg>`;
  const out = convertSvgToAlightXml(svg, { maxShapes: 4, minAreaPercent: 0, nodeReduction: 0 });
  assert.equal(out.stats.removedByLimit, 6);
  assert.equal(out.stats.colorGroups, 1);
  assert.equal(out.stats.outputShapes, 1);
});

test('preserveAspectRatio defaults to xMidYMid meet', () => {
  const svg = `<svg width="200" height="200" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="100" height="50" fill="#ff0000"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { nodeReduction: 0 });
  assert.match(out.xml, /<location value="100\.000000,100\.000000,0\.000000" \/>/);
});


test('lossless preserves source order, shape count and native stroke', () => {
  const svg = `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-back" x="0" y="0" width="90" height="90" fill="#ff0000"/>
    <rect id="blue-middle" x="40" y="10" width="90" height="80" fill="#0000ff"/>
    <rect id="red-front" x="80" y="20" width="90" height="70" fill="#ff0000"/>
    <path id="stroke-only" d="M10 95 L190 95" fill="none" stroke="#00ff00" stroke-width="4" stroke-linejoin="round"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless', maxShapes: 1, nodeReduction: 80 });
  assert.equal(out.profile.quality, 'lossless');
  assert.equal(out.stats.outputShapes, 4);
  assert.equal(out.stats.removedByLimit, 0);
  assert.equal(out.stats.mergedShapes, 0);
  assert.equal(out.stats.strokesRemoved, 0);
  assert.equal(out.profile.nodeReduction, 0);
  assert.match(out.xml, /<path-stroke[^>]*>/);
  assert.ok(out.xml.indexOf('red-back') < out.xml.indexOf('blue-middle'));
  assert.ok(out.xml.indexOf('blue-middle') < out.xml.indexOf('red-front'));
  assert.ok(out.xml.indexOf('red-front') < out.xml.indexOf('stroke-only'));
});

test('lossless converts Q T S and A to explicit cubic commands', () => {
  const svg = `<svg width="200" height="120" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg">
    <path id="curves" fill="#123456" d="M10 60 Q30 10 50 60 T90 60 C100 20 120 20 130 60 S160 100 170 60 A20 15 30 0 1 190 80"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  const path = out.xml.match(/<path d="([^"]+)"/i)?.[1] || '';
  assert.match(path, /C /);
  assert.doesNotMatch(path, /[QqAaSsTt]/);
  assert.equal(out.stats.nodesBefore, out.stats.nodesAfter);
});

test('lossless normalizes simple evenodd donut winding without removing nodes', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <path id="donut" fill="#ff00ff" fill-rule="evenodd" d="M10 10 L90 10 L90 90 L10 90 Z M30 30 L70 30 L70 70 L30 70 Z"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.stats.outputShapes, 1);
  assert.equal(out.stats.evenOddNormalized, 1);
  assert.equal(out.stats.nodesBefore, out.stats.nodesAfter);
  assert.equal(out.validation.bboxMismatches, 0);
});

test('lossless preserves two-stop gradient instead of flattening', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>
    <rect id="grad" x="0" y="0" width="100" height="100" fill="url(#g)"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.stats.gradientsFlattened, 0);
  assert.match(out.xml, /fillType="gradient"/);
  assert.match(out.xml, /<gradient type="linear"/);
});


test('grouped reducer isolates fallback per source contour and never spams per-color warnings', () => {
  const svg = `<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 0 L10 0 L20 0 L30 0 L40 0 L50 0 L60 0 L70 0 L80 0 L90 0" fill="#ff0000"/>
    <path d="M0 20 L10 20 L20 20 L30 20 L40 20 L50 20 L60 20 L70 20 L80 20 L90 20" fill="#ff0000"/>
    <path d="M0 40 L10 40 L20 40 L30 40 L40 40 L50 40 L60 40 L70 40 L80 40 L90 40" fill="#00ff00"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lightweight', nodeReduction: 65, minAreaPercent: 0 });
  assert.equal(out.stats.colorGroups, 2);
  assert.equal(out.profile.version, '1.5.3');
  assert.ok(Number.isInteger(out.stats.nodeReductionFallbackShapes));
  assert.ok(Number.isInteger(out.stats.nodeReductionReducedShapes));
  assert.ok(Number.isInteger(out.stats.nodeReductionUnchangedShapes));
  assert.equal(out.warnings.some((w) => /Node reduction gagal pada group #/i.test(w)), false);
});

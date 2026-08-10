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

test('reduces path node count', () => {
  const points = Array.from({ length: 40 }, (_, i) => `${i * 2},${50 + Math.sin(i / 3) * 20}`).join(' ');
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="#123456"/></svg>`;
  const out = convertSvgToAlightXml(svg, { nodeReduction: 50, minAreaPercent: 0 });
  assert.ok(out.stats.nodesBefore > out.stats.nodesAfter);
  assert.ok(out.stats.nodesAfter >= 2);
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

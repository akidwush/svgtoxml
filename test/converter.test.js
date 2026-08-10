import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';

test('converts colors, transforms, gradient and removes tiny details', () => {
  const svg = `
  <svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ff0000"/>
        <stop offset="100%" stop-color="#0000ff"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="200" height="100" fill="#ffffff"/>
    <g transform="translate(10 5)">
      <path d="M0 0 L80 0 L80 40 Z" fill="rgb(10, 20, 30)" stroke="#00ff00" stroke-width="2"/>
      <circle cx="120" cy="40" r="20" fill="url(#g)"/>
      <rect x="1" y="1" width="0.1" height="0.1" fill="red"/>
    </g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { maxShapes: 20, minAreaPercent: 0.003, precision: 3 });
  assert.equal(out.width, 200);
  assert.equal(out.height, 100);
  assert.match(out.xml, /<scene /);
  assert.match(out.xml, /fillColor value="#ff0a141e"/);
  assert.match(out.xml, /<gradient type="linear" startColor="#ffff0000" endColor="#ff0000ff"/);
  assert.match(out.xml, /<path-stroke/);
  assert.equal(out.stats.outputShapes, 3);
  assert.equal(out.stats.removedTiny, 1);
});

test('caps shape count by keeping larger shapes', () => {
  const items = Array.from({ length: 10 }, (_, i) => `<rect x="${i * 10}" y="0" width="${i + 1}" height="${i + 1}" fill="#123456"/>`).join('');
  const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">${items}</svg>`;
  const out = convertSvgToAlightXml(svg, { maxShapes: 4, minAreaPercent: 0 });
  assert.equal(out.stats.outputShapes, 4);
  assert.equal(out.stats.removedByLimit, 6);
});

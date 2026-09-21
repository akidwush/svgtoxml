import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';

test('Maximum Fidelity preserves source order, native stroke and exact geometry', () => {
  const svg = `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-back" x="0" y="0" width="90" height="90" fill="#ff0000"/>
    <rect id="blue-front" x="40" y="10" width="90" height="80" fill="#0000ff"/>
    <path id="stroke-only" d="M10 95 L190 95" fill="none" stroke="#00ff00" stroke-width="4"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity' });
  assert.equal(out.profile.quality, 'lossless');
  assert.equal(out.stats.outputShapes, 3);
  assert.equal(out.profile.nodeReduction, 0);
  assert.match(out.xml, /<path-stroke[^>]*>/);
  assert.ok(out.xml.indexOf('red-back') < out.xml.indexOf('blue-front'));
  assert.ok(out.xml.indexOf('blue-front') < out.xml.indexOf('stroke-only'));
});

test('old engine names are removed and safely fall back to Maximum Fidelity', () => {
  const svg = '<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
  for (const quality of ['optimized', 'accurate', 'balanced', 'lightweight']) {
    const out = convertSvgToAlightXml(svg, { quality });
    assert.equal(out.profile.quality, 'lossless');
  }
});

test('Small Patch Cleanup removes tiny islands but keeps main silhouette', () => {
  const dots = Array.from({ length: 10 }, (_, i) => {
    const x = 5 + i * 2;
    return `M${x} 5 L${x + 0.5} 5 L${x + 0.5} 5.5 L${x} 5.5 Z`;
  }).join(' ');
  const svg = `<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path id="main" fill="red" stroke="black" stroke-width="2" d="M10 20 L90 20 L90 90 L10 90 Z ${dots}"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'small-patch-cleanup',
    patchAreaPercent: 0.01,
    protectThinPercent: 3.5
  });
  assert.equal(out.profile.quality, 'patch-clean');
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.cleanup.removedSubpaths >= 10);
  assert.ok(out.cleanup.removedNodes > 0);
  assert.match(out.xml, /<path-stroke[^>]*>/);
  assert.equal(out.profile.nodeReduction, 0);
  assert.equal(out.fidelity.exact, false);
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'small-patch-cleanup'));
});

test('Small Patch Cleanup can remove a standalone tiny shape', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="main" x="10" y="10" width="80" height="80" fill="red"/>
    <rect id="dust" x="1" y="1" width=".5" height=".5" fill="blue"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'patch-clean',
    patchAreaPercent: 0.01,
    protectThinPercent: 3.5
  });
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.cleanup.removedShapes >= 1);
  assert.doesNotMatch(out.xml, /dust/);
});

test('Small Patch Cleanup protects long thin details', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <path id="thin-line" d="M5 50 L95 50 L95 50.1 L5 50.1 Z" fill="black"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'patch-clean',
    patchAreaPercent: 0.5,
    protectThinPercent: 3.5
  });
  assert.equal(out.stats.outputShapes, 1);
  assert.equal(out.cleanup.removedShapes, 0);
  assert.match(out.xml, /thin-line/);
});

test('Maximum Fidelity keeps two-stop gradient and clipPath', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <clipPath id="clip"><circle cx="50" cy="50" r="40"/></clipPath>
    </defs>
    <rect id="grad" width="100" height="100" fill="url(#g)" clip-path="url(#clip)"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.stats.gradientsFlattened, 0);
  assert.equal(out.stats.clipPathsApplied, 1);
  assert.match(out.xml, /fillType="gradient"/);
  assert.match(out.xml, /blending="mask"/);
});

test('Maximum Fidelity preserves group opacity as nested compositing', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <g id="translucent" opacity=".5">
      <rect width="70" height="70" fill="red"/>
      <rect x="30" y="30" width="70" height="70" fill="blue"/>
    </g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.stats.groupOpacityPreserved, 1);
  assert.match(out.xml, /translucent · Opacity/);
  assert.match(out.xml, /<opacity value="0\.50000000" \/>/);
});

test('strict Maximum Fidelity rejects known unsupported visual loss', () => {
  const svg = '<svg width="100" height="100"><text x="10" y="50">Unsupported</text></svg>';
  assert.throws(
    () => convertSvgToAlightXml(svg, { quality: 'maximum-fidelity', requireExact: true }),
    (error) => error?.code === 'FIDELITY_REQUIREMENT_FAILED'
  );
});

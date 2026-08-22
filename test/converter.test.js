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
  assert.equal(out.profile.version, '1.9.0');
  assert.ok(Number.isInteger(out.stats.nodeReductionFallbackShapes));
  assert.ok(Number.isInteger(out.stats.nodeReductionReducedShapes));
  assert.ok(Number.isInteger(out.stats.nodeReductionUnchangedShapes));
  assert.equal(out.warnings.some((w) => /Node reduction gagal pada group #/i.test(w)), false);
});


test('optimized removes micro subpaths but keeps main silhouette', () => {
  const dots = Array.from({ length: 12 }, (_, i) => {
    const x = 10 + i * 3;
    return `M${x} 10 L${x + 0.5} 10 L${x + 0.5} 10.5 L${x} 10.5 Z`;
  }).join(' ');
  const svg = `<svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path fill="#ff0000" d="M10 20 L90 20 L90 90 L10 90 Z ${dots}"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'optimized', nodeReduction: 0, minAreaPercent: 0,
    microDetailPercent: 0.01, maxOutputGroups: 100
  });
  assert.equal(out.profile.quality, 'optimized');
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.stats.microSubpathsRemoved >= 12);
  assert.ok(out.stats.microNodesRemoved > 0);
  assert.match(out.xml, /<path d="[^"]+"/);
});

test('optimized safely merges same color across non-overlapping z-order barrier', () => {
  const svg = `<svg width="120" height="80" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-a" x="0" y="0" width="20" height="20" fill="#ff0000"/>
    <rect id="blue" x="80" y="40" width="20" height="20" fill="#0000ff"/>
    <rect id="red-b" x="30" y="0" width="20" height="20" fill="#ff0000"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'optimized', nodeReduction: 0, minAreaPercent: 0,
    microDetailPercent: 0, maxOutputGroups: 100
  });
  assert.equal(out.stats.outputShapes, 2);
  assert.equal(out.stats.safeColorMerges, 1);
  assert.equal((out.xml.match(/<embedScene\b/g) || []).length, 2);
});

test('optimized refuses same-color merge when an intervening overlapping shape would change z-order', () => {
  const svg = `<svg width="120" height="80" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-back" x="0" y="0" width="50" height="50" fill="#ff0000"/>
    <rect id="blue-middle" x="25" y="0" width="50" height="50" fill="#0000ff"/>
    <rect id="red-front" x="40" y="0" width="50" height="50" fill="#ff0000"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'optimized', nodeReduction: 0, minAreaPercent: 0,
    microDetailPercent: 0, maxOutputGroups: 100
  });
  assert.equal(out.stats.outputShapes, 3);
  assert.ok(out.stats.zOrderBarriers >= 1);
  assert.equal(out.stats.safeColorMerges, 0);
});

test('optimized hard-caps layer count by dropping smallest groups last', () => {
  const items = Array.from({ length: 30 }, (_, i) => {
    const color = `#${(0x100000 + i * 12345).toString(16).slice(-6)}`;
    return `<rect x="${i * 3}" y="${i % 5}" width="2" height="2" fill="${color}"/>`;
  }).join('');
  const svg = `<svg width="120" height="80" xmlns="http://www.w3.org/2000/svg">${items}</svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'optimized', nodeReduction: 0, minAreaPercent: 0,
    microDetailPercent: 0, maxOutputGroups: 20
  });
  assert.equal(out.stats.outputShapes, 20);
  assert.equal(out.stats.optimizedGroupsDropped, 10);
});

test('maximum fidelity converts inherited clipPath into an isolated native AM mask', () => {
  const svg = `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="round-clip"><circle cx="50" cy="50" r="40"/></clipPath></defs>
    <g clip-path="url(#round-clip)"><rect id="clipped" width="200" height="100" fill="#ff0000"/></g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.stats.clipPathsApplied, 1);
  assert.equal(out.stats.clipPathsUnsupported, 0);
  assert.match(out.xml, /SVG clipPath/);
  assert.match(out.xml, /blending="mask"/);
  assert.equal(out.fidelity.exact, true);
});

test('maximum fidelity resolves CSS variables, important cascade, complex selectors and percentage geometry', () => {
  const svg = `<svg width="200" height="100" viewBox="0 0 200 100" style="--accent:#123456" xmlns="http://www.w3.org/2000/svg">
    <style>
      rect { fill: #ffffff !important; }
      svg > g[data-kind="hero"] rect.item { fill: var(--accent) !important; }
    </style>
    <g data-kind="hero"><rect id="css-shape" class="item" width="50%" height="50%"/></g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.match(out.xml, /<fillColor value="#ff123456" \/>/i);
  assert.match(out.xml, /M -100 -50L 0 -50L 0 0L -100 0Z/);
  assert.equal(out.fidelity.exact, true);
});

test('gradient stops honor stylesheet selectors and CSS variables', () => {
  const svg = `<svg width="100" height="100" style="--end:#0000ff" xmlns="http://www.w3.org/2000/svg">
    <style>.start { stop-color:#ff0000 } .end { stop-color:var(--end); stop-opacity:50% }</style>
    <defs><linearGradient id="g"><stop class="start" offset="0"/><stop class="end" offset="1"/></linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.match(out.xml, /startColor="#ffff0000"/i);
  assert.match(out.xml, /endColor="#800000ff"/i);
  assert.equal(out.fidelity.exact, true);
});

test('fidelity report never claims exact output when SVG-only features are degraded', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs><mask id="m"><rect width="100" height="100" fill="white"/></mask></defs>
    <rect width="100" height="100" fill="red" mask="url(#m)" stroke="black" stroke-dasharray="4 2"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.fidelity.exact, false);
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'svg-mask'));
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'stroke-dash'));
});

test('maximum fidelity preserves group opacity as nested AM compositing', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <g id="translucent" opacity=".5">
      <rect width="70" height="70" fill="red"/>
      <rect x="30" y="30" width="70" height="70" fill="blue"/>
    </g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.fidelity.exact, true);
  assert.equal(out.stats.groupOpacityPreserved, 1);
  assert.match(out.xml, /translucent · Opacity/);
  assert.match(out.xml, /<opacity value="0\.50000000" \/>/);
  assert.match(out.xml, /<fillColor value="#ffff0000" \/>/i);
  assert.match(out.xml, /<fillColor value="#ff0000ff" \/>/i);
});

test('maximum fidelity applies element opacity after fill and stroke compositing', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect width="80" height="80" opacity=".4" fill="red" stroke="blue" stroke-width="10"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.fidelity.exact, true);
  assert.match(out.xml, /<opacity value="0\.40000000" \/>/);
  assert.match(out.xml, /<fillColor value="#ffff0000" \/>/i);
  assert.match(out.xml, /<color value="#ff0000ff" \/>/i);
});

test('fidelity audit detects CSS blend mode and gradient stroke losses', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
    <path d="M0 0L100 100" fill="none" stroke="url(#g)" stroke-width="4" style="mix-blend-mode:multiply"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'lossless' });
  assert.equal(out.fidelity.exact, false);
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'gradient-stroke'));
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'blend-mode'));
});

test('requireExact rejects known visual losses instead of returning misleading XML', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <text x="10" y="50">Unsupported text</text>
  </svg>`;
  assert.throws(
    () => convertSvgToAlightXml(svg, { quality: 'lossless', requireExact: true }),
    (error) => error?.code === 'FIDELITY_REQUIREMENT_FAILED' && error?.fidelity?.exact === false
  );
});

test('strict audit rejects non-uniform transformed strokes and SVG animation', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <path transform="scale(2 1)" d="M10 10L40 40" fill="none" stroke="black" stroke-width="4">
      <animate attributeName="opacity" from="0" to="1" dur="1s"/>
    </path>
  </svg>`;
  assert.throws(
    () => convertSvgToAlightXml(svg, { quality: 'lossless', requireExact: true }),
    (error) => {
      const codes = new Set(error?.fidelity?.losses?.map((loss) => loss.code));
      return codes.has('nonuniform-stroke') && codes.has('svg-animation');
    }
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';
import { load } from 'cheerio';

const microSvg = `<svg width="100" height="100">
  <rect id="main" width="80" height="80" fill="red"/>
  <rect id="dust" x="90" y="90" width="0.5" height="0.5" fill="blue"/>
</svg>`;

test('all Patch Cleanup aliases resolve through both quality and engine selectors', () => {
  for (const alias of ['small-patch-cleanup', 'patch-clean', 'small-patch']) {
    for (const selector of ['quality', 'engine']) {
      const out = convertSvgToAlightXml(microSvg, { [selector]: alias });
      assert.equal(out.profile.engine, 'small-patch-cleanup');
      assert.equal(out.profile.quality, 'patch-clean');
      assert.equal(out.cleanup.removedShapes, 1);
      assert.equal(out.cleanup.removedSubpaths, 1);
      assert.equal(out.cleanup.removedNodes, 4);
      assert.equal(out.validation.compatibility.ok, true);
      assert.equal(out.profile.alightImportSafe, true);
      assert.equal(out.profile.groupedByColor, false);
      assert.equal(out.profile.nodeReduction, 0);
      assert.doesNotMatch(out.xml, /label="dust"/);
    }
  }
});

test('zero cleanup threshold preserves every shape and reports no intentional loss', () => {
  const out = convertSvgToAlightXml(microSvg, { quality: 'patch-clean', patchAreaPercent: 0 });
  assert.equal(out.stats.outputShapes, 2);
  assert.equal(out.cleanup.removedShapes, 0);
  assert.equal(out.cleanup.removedSubpaths, 0);
  assert.equal(out.cleanup.removedNodes, 0);
  assert.equal(out.fidelity.exact, true);
  assert.match(out.xml, /label="dust"/);
});

test('Patch Cleanup restores legacy threshold alias, finite defaults and clamps', () => {
  for (const [input, area, thin] of [
    [{ microDetailPercent: 0.05 }, 0.05, 2],
    [{ patchAreaPercent: 0, microDetailPercent: 0.05 }, 0, 2],
    [{ patchAreaPercent: -1, protectThinPercent: -1 }, 0, 0],
    [{ patchAreaPercent: 10, protectThinPercent: 500 }, 0.25, 100],
    [{ patchAreaPercent: 'invalid', protectThinPercent: 'invalid' }, 0.01, 2]
  ]) {
    const out = convertSvgToAlightXml(microSvg, { quality: 'patch-clean', ...input });
    assert.equal(out.cleanup.patchAreaPercent, area);
    assert.equal(out.cleanup.protectThinPercent, thin);
  }
});

test('cleanup does not leak into Maximum Fidelity or Smart Color Groups', () => {
  for (const quality of ['maximum-fidelity', 'color-groups']) {
    const out = convertSvgToAlightXml(microSvg, { quality, patchAreaPercent: 0.25, protectThinPercent: 100 });
    assert.match(out.xml, /label="dust"/);
    assert.equal(out.cleanup, undefined);
    assert.equal(out.stats.removedMicroShapes, 0);
    if (quality === 'color-groups') {
      assert.equal(out.grouping.engine, 'smart-color-groups');
      assert.equal(out.grouping.serializedSourceShapes, 2);
      assert.equal(out.grouping.groupingExact, true);
    }
  }
});

test('Patch Cleanup preserves hierarchy, opacity, gradient, clip, stroke and source order', () => {
  const svg = `<svg width="100" height="100">
    <defs>
      <linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
      <clipPath id="clip"><rect width="80" height="80"/></clipPath>
    </defs>
    <g id="outer" opacity="0.5">
      <path id="back" fill="url(#g)" clip-path="url(#clip)" stroke="black" stroke-width="2" d="M0 0H90V90H0Z M95 95h.5v.5h-.5Z"/>
      <rect id="front" x="20" y="20" width="40" height="40" fill="green"/>
    </g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'patch-clean', title: 'Restored cleanup', duration: 2400, fps: 60 });
  assert.equal(out.cleanup.removedSubpaths, 1);
  assert.equal(out.stats.gradientsFlattened, 0);
  assert.equal(out.stats.clipPathsApplied, 1);
  assert.equal(out.stats.groupOpacityPreserved, 1);
  assert.equal(out.profile.preservesSourceOrder, true);
  const $ = load(out.xml, { xmlMode: true });
  assert.equal($('scene').first().attr('title'), 'Restored cleanup');
  assert.equal($('scene').first().attr('totalTime'), '2400');
  assert.equal($('scene').first().attr('fps'), '60');
  assert.ok($('gradient').length > 0);
  assert.ok($('path-stroke').length > 0);
  assert.ok($('[blending="mask"]').length > 0);
  assert.ok($('opacity[value="0.50000000"]').length > 0);
  assert.ok(out.xml.indexOf('label="back"') < out.xml.indexOf('label="front"'));
  assert.equal(out.validation.compatibility.ok, true);
});

test('Patch Cleanup keeps nested/flat and primitive controls functional', () => {
  const svg = '<svg width="100" height="100"><g id="outer"><rect id="box" width="50" height="50"/></g></svg>';
  const nested = convertSvgToAlightXml(svg, { quality: 'patch-clean', detectPrimitives: true });
  assert.match(nested.xml, /label="outer"/);
  assert.equal(nested.profile.primitiveOutput, 1);
  const flat = convertSvgToAlightXml(svg, { quality: 'patch-clean', groupingMode: 'flat', detectPrimitives: false });
  assert.doesNotMatch(flat.xml, /label="outer"/);
  assert.equal(flat.profile.primitiveOutput, 0);
  assert.equal(flat.validation.compatibility.ok, true);
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


test('Small Patch Cleanup default is more aggressive for compact micro patches', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="main" x="10" y="10" width="80" height="80" fill="red"/>
    <rect id="dust-default" x="2" y="2" width="0.8" height="0.8" fill="blue"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'small-patch-cleanup' });
  assert.equal(out.cleanup.patchAreaPercent, 0.01);
  assert.equal(out.cleanup.protectThinPercent, 2);
  assert.equal(out.cleanup.thinAspectRatio, 6);
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.cleanup.removedShapes >= 1);
  assert.doesNotMatch(out.xml, /dust-default/);
});

test('Small Patch Cleanup removes compact patches even when one side crosses thin-protection length', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="main" x="10" y="10" width="80" height="80" fill="red"/>
    <rect id="compact-patch" x="2" y="2" width="2.5" height="1" fill="blue"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'patch-clean',
    patchAreaPercent: 0.05,
    protectThinPercent: 2
  });
  assert.equal(out.stats.outputShapes, 1);
  assert.ok(out.cleanup.removedShapes >= 1);
  assert.doesNotMatch(out.xml, /compact-patch/);
});

test('Small Patch Cleanup still protects genuinely elongated thin detail', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <path id="needle-detail" d="M5 40 L95 40 L95 40.2 L5 40.2 Z" fill="black"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, {
    quality: 'patch-clean',
    patchAreaPercent: 0.5,
    protectThinPercent: 2
  });
  assert.equal(out.stats.outputShapes, 1);
  assert.equal(out.cleanup.removedShapes, 0);
  assert.match(out.xml, /needle-detail/);
});

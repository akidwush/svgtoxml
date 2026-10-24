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

test('unknown and removed engine names fail clearly', () => {
  const svg = '<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
  for (const quality of ['optimized', 'accurate', 'balanced', 'lightweight', 'unknown-engine']) {
    assert.throws(
      () => convertSvgToAlightXml(svg, { quality }),
      (error) => error?.code === 'ENGINE_NOT_SUPPORTED' && error?.engine === quality
    );
  }
});

test('Color Groups converts 100 flat-color shapes with 10 colors into 10 layers', () => {
  const colors = ['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#222222','#777777','#ffaa00','#6633ff'];
  const shapes = Array.from({ length: 100 }, (_, index) => {
    const color = colors[index % colors.length];
    const x = (index % 20) * 5;
    const y = Math.floor(index / 20) * 10;
    return `<rect id="shape-${index}" x="${x}" y="${y}" width="4" height="8" fill="${color}"/>`;
  }).join('');
  const svg = `<svg width="100" height="50" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });

  assert.equal(out.profile.quality, 'color-group');
  assert.equal(out.profile.engine, 'smart-color-groups');
  assert.equal(out.profile.groupedByColor, true);
  assert.equal(out.grouping.inputShapes, 100);
  assert.equal(out.grouping.groupedColors, 10);
  assert.equal(out.grouping.outputLayers, 10);
  assert.equal(out.grouping.mergedShapes, 90);
  assert.equal(out.grouping.packedShapes, 90);
  assert.equal(out.grouping.geometryMerged, false);
  assert.equal(out.grouping.preservesInternalShapes, true);
  assert.equal(out.stats.outputShapes, 10);
  assert.equal(out.profile.version, '3.1.0');
  assert.equal(out.profile.alightImportSafe, true);
  assert.equal((out.xml.match(/label="Color \d{2} - #[0-9a-f]{6}"/gi) || []).length, 10);
  assert.equal((out.xml.match(/<shape\b/g) || []).length, 100);
  assert.equal((out.xml.match(/<embedScene\b[^>]*\boutTime="\d+"/g) || []).length, 11);
  assert.equal((out.xml.match(/<fillColor value="#FF000000" \/>/g) || []).length, 10);
  assert.match(out.xml, /<fillColor value="#ff000000" \/>/);
  assert.doesNotMatch(out.xml, /<scene title="Color \d{2}/);
  assert.equal(out.grouping.zOrderBarriers, 0);
  assert.equal(out.fidelity.losses.some((loss) => loss.code === 'color-group-zorder'), false);
});

test('Color Groups emits Alight-safe group wrappers', () => {
  const svg = `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
    <rect id="red" x="0" y="0" width="24" height="24" fill="#ff0000"/>
    <rect id="blue" x="32" y="32" width="24" height="24" fill="#0000ff"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups', duration: 1800, fps: 60 });

  const embedTags = out.xml.match(/<embedScene\b[^>]*>/g) || [];
  assert.equal(embedTags.length, 3);
  for (const tag of embedTags) {
    assert.match(tag, /outTime="1800"/);
  }
  assert.match(out.xml, /label="Color 01 - #[0-9A-F]{6}"/);
  assert.match(out.xml, /label="Color 02 - #[0-9A-F]{6}"/);
  assert.equal((out.xml.match(/<scene title=""/g) || []).length >= 3, true);
  assert.doesNotMatch(out.xml, /·/);
  assert.doesNotMatch(out.xml, /\b(?:NaN|Infinity|undefined)\b/);
});

test('Color Groups keeps overlapping same-color source shapes separate inside one color layer', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-back" x="10" y="10" width="60" height="60" fill="#ff0000"/>
    <rect id="red-front" x="30" y="30" width="60" height="60" fill="#ff0000"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });

  assert.equal(out.grouping.groupedColors, 1);
  assert.equal(out.grouping.outputLayers, 1);
  assert.equal(out.grouping.geometryMerged, false);
  assert.equal(out.grouping.preservesInternalShapes, true);
  assert.equal((out.xml.match(/<shape\b/g) || []).length, 2);
  assert.match(out.xml, /label="red-back"/);
  assert.match(out.xml, /label="red-front"/);
});

test('Color Groups reports only real overlapping z-order conflicts', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-back" x="0" y="0" width="80" height="80" fill="#ff0000"/>
    <rect id="blue-mid" x="10" y="10" width="80" height="80" fill="#0000ff"/>
    <rect id="red-front" x="20" y="20" width="70" height="70" fill="#ff0000"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });

  assert.equal(out.grouping.groupedColors, 2);
  assert.ok(out.grouping.overlapConstraints >= 2);
  assert.equal(out.grouping.zOrderConflicts, 1);
  assert.equal(out.grouping.zOrderBarriers, 1);
  assert.equal(out.profile.preservesSourceOrder, false);
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'color-group-zorder'));
});

test('Color Groups keeps complex paint as fallback instead of destructive merge', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect id="red-a" x="0" y="0" width="20" height="20" fill="#ff0000"/>
    <rect id="red-b" x="25" y="0" width="20" height="20" fill="#ff0000"/>
    <path id="stroke-only" d="M0 50L100 50" fill="none" stroke="#ff0000" stroke-width="4"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-group' });
  assert.equal(out.grouping.groupedColors, 1);
  assert.equal(out.grouping.fallbackLayers, 1);
  assert.equal(out.grouping.outputLayers, 2);
  assert.match(out.xml, /<path-stroke/);
});

test('Color Groups isolates filter or mask affected shapes from color packing', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <defs><filter id="fx"><feGaussianBlur stdDeviation="1"/></filter></defs>
    <rect id="safe-red" x="0" y="0" width="20" height="20" fill="#ff0000"/>
    <rect id="filtered-red" x="30" y="0" width="20" height="20" fill="#ff0000" filter="url(#fx)"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });

  assert.equal(out.grouping.groupedColors, 1);
  assert.equal(out.grouping.fallbackLayers, 1);
  assert.equal(out.grouping.outputLayers, 2);
  assert.match(out.xml, /label="filtered-red"/);
  assert.ok(out.fidelity.losses.some((loss) => loss.code === 'filter'));
});

test('Smart Color Groups canonicalizes equivalent paint syntax and inheritance', () => {
  const svg = `<svg width="120" height="20" xmlns="http://www.w3.org/2000/svg">
    <style>.white { fill: rgb(255,255,255) } #last { fill: hsl(0 0% 100%) }</style>
    <g fill="#fff" color="#ffffff">
      <rect x="0" width="18" height="18"/>
      <rect x="20" width="18" height="18" fill="currentColor"/>
      <rect class="white" x="40" width="18" height="18"/>
      <rect id="last" x="60" width="18" height="18"/>
      <rect x="80" width="18" height="18" style="fill:rgba(255,255,255,1)"/>
    </g>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  assert.equal(out.grouping.groupedColors, 1);
  assert.equal(out.grouping.solidCandidates, 5);
  assert.ok(out.grouping.canonicalColorAliases >= 3);
  assert.equal(out.grouping.fallbackLayers, 0);
});

test('Smart Color Groups returns auditable fallback reasons for complex paint', () => {
  const svg = `<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>
    <rect width="20" height="20" fill="url(#g)"/>
    <rect x="25" width="20" height="20" fill="red" opacity=".5"/>
    <rect x="50" width="20" height="20" fill="red" stroke="black"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  assert.equal(out.grouping.fallbackLayers, 3);
  assert.equal(out.grouping.fallbackReasons.HAS_GRADIENT, 1);
  assert.equal(out.grouping.fallbackReasons.PARTIAL_ALPHA, 1);
  assert.equal(out.grouping.fallbackReasons.HAS_STROKE, 1);
  assert.equal(out.stats.gradientsFlattened, 0);
});

test('Smart Color Groups ignores bbox overlap when a shape is inside a path hole', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <path id="donut" fill="red" fill-rule="evenodd" d="M0 0H100V100H0Z M30 30H70V70H30Z"/>
    <rect id="inside-hole" x="40" y="40" width="20" height="20" fill="blue"/>
    <path id="red-front" fill="red" d="M0 0H10V10H0Z"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  assert.ok(out.grouping.overlapCandidates >= 1);
  assert.equal(out.grouping.actualOverlaps, 0);
  assert.equal(out.grouping.zOrderConflicts, 0);
  assert.equal(out.grouping.groupingExact, true);
});

test('Smart Color Groups distinguishes touching from positive-area overlap', () => {
  const svg = `<svg width="100" height="50" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="50" height="50" fill="red"/>
    <rect x="50" y="0" width="50" height="50" fill="blue"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  assert.equal(out.grouping.zOrderConstraints, 0);
  assert.equal(out.grouping.actualOverlaps, 0);
  assert.equal(out.grouping.touchingPairs, 1);
});

test('Smart Color Groups plan and audit metadata are deterministic by default', () => {
  const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="60" height="60" fill="#f00"/>
    <rect x="20" y="20" width="60" height="60" fill="blue"/>
    <rect x="40" y="40" width="50" height="50" fill="rgb(255,0,0)"/>
  </svg>`;
  const first = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  const second = convertSvgToAlightXml(svg, { quality: 'color-groups' });
  assert.deepEqual(first.grouping, second.grouping);
  assert.equal(first.grouping.timingsMs, undefined);
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


test('control surface applies FPS, duration and nested group hierarchy', () => {
  const svg = `<svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
    <g id="outer"><g id="inner"><rect id="box" x="10" y="10" width="80" height="40" fill="#ff0000"/></g></g>
  </svg>`;
  const nested = convertSvgToAlightXml(svg, {
    quality: 'maximum-fidelity',
    duration: 2000,
    fps: 60,
    groupingMode: 'nested',
    detectPrimitives: false
  });
  assert.match(nested.xml, /totalTime="2000" fps="60"/);
  assert.match(nested.xml, /label="outer"/);
  assert.match(nested.xml, /label="inner"/);
  assert.equal(nested.profile.groupingMode, 'nested');

  const flat = convertSvgToAlightXml(svg, {
    quality: 'maximum-fidelity',
    duration: 2000,
    fps: 60,
    groupingMode: 'flat',
    detectPrimitives: false
  });
  assert.doesNotMatch(flat.xml, /label="outer"/);
  assert.doesNotMatch(flat.xml, /label="inner"/);
  assert.match(flat.xml, /label="box"/);
  assert.equal(flat.profile.groupingMode, 'flat');
});

test('primitive detection emits conservative native rectangle and can fall back to path', () => {
  const svg = '<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg"><rect id="box" x="20" y="10" width="80" height="40" fill="#123456"/></svg>';
  const native = convertSvgToAlightXml(svg, {
    quality: 'maximum-fidelity',
    detectPrimitives: true
  });
  assert.match(native.xml, /label="box"[^>]*s="\.rect"/);
  assert.match(native.xml, /property name="size" type="vec2" value="80\.00000000,40\.00000000"/);
  assert.equal(native.stats.primitiveOutput, 1);

  const path = convertSvgToAlightXml(svg, {
    quality: 'maximum-fidelity',
    detectPrimitives: false
  });
  assert.doesNotMatch(path.xml, /s="\.rect"/);
  assert.match(path.xml, /<path d=/);
  assert.equal(path.stats.primitiveOutput, 0);
});

test('unsupported or transformed primitives stay on path fallback', () => {
  const svg = '<svg width="100" height="100"><rect id="rounded" x="10" y="10" width="40" height="20" rx="4" fill="red"/><rect id="rotated" x="60" y="10" width="20" height="20" transform="rotate(20 70 20)" fill="blue"/></svg>';
  const out = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity', detectPrimitives: true });
  assert.equal(out.stats.primitiveOutput, 0);
  assert.ok(out.stats.primitiveFallback >= 2);
  assert.match(out.xml, /<path d=/);
});

test('every converter mode returns only compatibility-validated XML', () => {
  const svg = `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(2 3)">
      <path d="M2 2 C8 0 12 8 18 4" fill="none" stroke="#123456" stroke-width="2"/>
      <rect x="8" y="12" width="24" height="20" fill="#abcdef"/>
    </g>
  </svg>`;

  for (const quality of ['maximum-fidelity', 'color-groups', 'small-patch-cleanup']) {
    const out = convertSvgToAlightXml(svg, { quality, duration: 1800, fps: 60 });
    assert.equal(out.profile.alightImportSafe, true, `${quality} must be gated`);
    assert.equal(out.validation.compatibility.ok, true, `${quality} must expose validation result`);
    assert.equal(out.validation.compatibility.profile, 'alight-5.0.273-android-ff106');
    assert.ok(out.validation.compatibility.checks.includes('xml-well-formed'));
    for (const tag of out.xml.match(/<embedScene\b[^>]*>/g) || []) {
      assert.match(tag, /\boutTime="\d+"/, `${quality} emitted an ambiguous embedScene timeline`);
    }
  }
});

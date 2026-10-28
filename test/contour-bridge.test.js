import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { bridgeClosedContourPair, bridgeFilledSubpaths } from '../lib/contour-bridge.js';
import { convertSvgToAlightXml } from '../lib/converter.js';

const ring = 'M 10 10L 90 10L 90 90L 10 90Z' +
  'M 30 30L 30 70L 70 70L 70 30Z';

test('two closed contours are joined by a retraced bridge without touching Bézier commands', () => {
  const source = 'M 0 0C 0 10, 10 10, 10 0L 0 0Z' +
    'M 2 2C 4 4, 5 4, 6 2L 2 2Z';
  const result = bridgeClosedContourPair(source);
  assert.equal(result.bridged, true);
  assert.equal((result.path.match(/M\s/g) || []).length, 1);
  assert.equal((result.path.match(/C\s/g) || []).length, 2);
  assert.match(result.path, /L 0 0L 2 2/);
  assert.match(result.path, /L 2 2L 0 0Z$/);
});

test('open and three-contour paths are left unchanged', () => {
  for (const source of [
    'M 0 0L 10 0Z M 20 0L 30 0',
    'M 0 0L 10 0Z M 20 0L 30 0Z M 40 0L 50 0Z'
  ]) {
    const result = bridgeClosedContourPair(source);
    assert.equal(result.bridged, false);
    assert.equal(result.path, source);
  }
});

test('Alight XML bridges the donut for Maximum Fidelity, Patch Cleanup and Color Groups', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <path id="ring" fill="#2253e9" d="${ring}"/>
  </svg>`;
  for (const quality of ['maximum-fidelity', 'patch-clean', 'color-groups']) {
    const out = convertSvgToAlightXml(svg, { quality, patchAreaPercent: 0 });
    const $ = load(out.xml, { xmlMode: true });
    const path = $('shape[label="ring"] > path').attr('d');
    assert.ok(path, `${quality}: output ring missing`);
    assert.equal((path.match(/M\s/g) || []).length, 1, `${quality}: ring hole requires one bridged contour`);
    assert.equal(out.validation.compatibility.ok, true);
    assert.match(out.xml, /#ff2253e9/i);
  }
});

test('bridge is not applied to a stroked compound path', () => {
  const svg = `<svg width="100" height="100">
    <path id="stroked-ring" fill="#2253e9" stroke="#000000" stroke-width="3" d="${ring}"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity' });
  const $ = load(out.xml, { xmlMode: true });
  const path = $('shape[label="stroked-ring"] > path').attr('d');
  assert.equal((path.match(/M\s/g) || []).length, 2);
  assert.equal($('path-stroke').length, 1);
});

test('implicitly closed Vector Magic-style contours are joined without losing curve commands', () => {
  const source = [
    'M 0 0 C 0 10 10 10 10 0 L 0 0',
    'M 2 2 C 4 4 5 4 6 2 L 2 2 Z'
  ].join(' ');
  const result = bridgeFilledSubpaths(source);
  assert.equal(result.bridged, true);
  assert.equal((result.path.match(/M\s/g) || []).length, 1);
  assert.equal((result.path.match(/C\s/g) || []).length, 2);
  assert.match(result.path, /L 0 0 L 2 2/);
  assert.match(result.path, /L 2 2 L 0 0 Z$/);
});

test('six subpaths with a single final Z become one contour, preserving all sections', () => {
  const source = [
    'M 0 0 L 100 0 L 100 100 L 0 100',
    'M 10 10 L 10 20 L 20 20 L 20 10',
    'M 30 10 L 30 20 L 40 20 L 40 10',
    'M 50 10 L 50 20 L 60 20 L 60 10',
    'M 70 10 L 70 20 L 80 20 L 80 10',
    'M 85 10 L 85 20 L 95 20 L 95 10 Z'
  ].join(' ');
  const result = bridgeFilledSubpaths(source);
  assert.equal(result.bridged, true);
  assert.equal((result.path.match(/M\s/g) || []).length, 1);
  assert.equal((result.path.match(/L\s/g) || []).length > (source.match(/L\s/g) || []).length, true);
  assert.equal(result.path.endsWith('Z'), true);
});

test('all engines bridge Vector Magic-style implicit ring holes; strokes stay untouched', () => {
  const ringWithImplicitClose = 'M 10 10 L 90 10 L 90 90 L 10 90 ' +
    'M 30 30 L 30 70 L 70 70 L 70 30 Z';
  const svg = `<svg width="100" height="100"><path id="implicit-ring" fill="#2253e9" d="${ringWithImplicitClose}"/></svg>`;
  for (const quality of ['maximum-fidelity', 'patch-clean', 'color-groups']) {
    const out = convertSvgToAlightXml(svg, { quality, patchAreaPercent: 0 });
    const $ = load(out.xml, { xmlMode: true });
    const path = $('shape[label="implicit-ring"] > path').attr('d');
    assert.equal((path.match(/M\s/g) || []).length, 1, quality);
    assert.equal(out.validation.compatibility.ok, true, quality);
  }
});

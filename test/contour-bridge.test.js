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

test('Alight XML uses native excluded contours for all three engines', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <path id="ring" fill="#2253e9" d="${ring}"/>
  </svg>`;
  for (const quality of ['maximum-fidelity', 'patch-clean', 'color-groups']) {
    const out = convertSvgToAlightXml(svg, { quality, patchAreaPercent: 0 });
    const $ = load(out.xml, { xmlMode: true });
    const contours = $('shape[label="ring"] > path > contour');
    assert.equal(contours.length, 2, `${quality}: two native contours expected`);
    assert.equal(contours.eq(0).attr('exclude'), undefined);
    assert.equal(contours.eq(1).attr('exclude'), 'true');
    assert.ok(contours.toArray().every(n => $(n).attr('d').startsWith('M ')));
    assert.equal(out.validation.compatibility.ok, true);
    assert.match(out.xml, /#ff2253e9/i);
  }
});

test('stroked compound path keeps separate native contours and native stroke', () => {
  const svg = `<svg width="100" height="100">
    <path id="stroked-ring" fill="#2253e9" stroke="#000000" stroke-width="3" d="${ring}"/>
  </svg>`;
  const out = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity' });
  const $ = load(out.xml, { xmlMode: true });
  const contours = $('shape[label="stroked-ring"] > path > contour');
  assert.equal(contours.length, 2);
  assert.equal(contours.eq(1).attr('exclude'), 'true');
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
  assert.equal(result.bridges.length, 1);
  assert.ok(result.bridges[0].distance < 5, 'bridge should attach to nearby painted edge');
  assert.match(result.path, /L 2 2/);
  assert.match(result.path, /Z$/);
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

test('all engines preserve implicit-closed ring holes using native contour exclude', () => {
  const ringWithImplicitClose = 'M 10 10 L 90 10 L 90 90 L 10 90 ' +
    'M 30 30 L 30 70 L 70 70 L 70 30 Z';
  const svg = `<svg width="100" height="100"><path id="implicit-ring" fill="#2253e9" d="${ringWithImplicitClose}"/></svg>`;
  for (const quality of ['maximum-fidelity', 'patch-clean', 'color-groups']) {
    const out = convertSvgToAlightXml(svg, { quality, patchAreaPercent: 0 });
    const $ = load(out.xml, { xmlMode: true });
    const contours = $('shape[label="implicit-ring"] > path > contour');
    assert.equal(contours.length, 2, quality);
    assert.equal(contours.eq(1).attr('exclude'), 'true', quality);
    assert.equal(out.validation.compatibility.ok, true, quality);
  }
});

test('short bridges attach each hole to nearest painted edge instead of drawing diagonals', () => {
  const source = [
    'M 0 0 L 400 0 L 400 400 L 0 400 Z',
    'M 10 200 L 10 220 L 30 220 L 30 200 Z',
    'M 370 180 L 370 200 L 390 200 L 390 180 Z'
  ].join(' ');
  const result = bridgeFilledSubpaths(source);
  assert.equal(result.bridged, true);
  assert.equal(result.bridges.length, 2);
  // The old approach linked both holes to M 0 0 through the empty interior.
  assert.ok(result.bridges.every((b) => b.distance < 230));
  assert.equal((result.path.match(/M\s/g) || []).length, 1);
});

test('disconnected filled islands are not stitched into fabricated bridges', () => {
  const path = 'M 0 0 L 30 0 L 30 30 L 0 30 Z M 40 0 L 70 0 L 70 30 L 40 30 Z';
  const result = bridgeFilledSubpaths(path);
  assert.equal(result.bridged, false);
  assert.equal(result.path, path);
});

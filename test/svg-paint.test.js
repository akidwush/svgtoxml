import test from 'node:test';
import assert from 'node:assert/strict';
import { convertSvgToAlightXml } from '../lib/converter.js';

const source = paint => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect id="paint" width="40" height="40" fill="${paint}"/><rect id="control" x="60" width="40" height="40" fill="red"/></svg>`;
const paints = [
  ['#0a5', '#ff00aa55'], ['#00aa5a', '#ff00aa5a'], ['#00aa5a80', '#8000aa5a'],
  ['rgb(0,170,90)', '#ff00aa5a'], ['rgb(0 170 90 / 50%)', '#8000aa5a'],
  ['rgba(0,170,90,0.5)', '#8000aa5a'], ['hsl(.5turn 100% 50%)', '#ff00ffff'],
  ['hsl(200grad 100% 50%)', '#ff00ffff'], ['hsl(3.141592653589793rad 100% 50%)', '#ff00ffff'],
  ['hwb(150 0% 20%)', '#ff00cc66'], ['color(srgb 0 .6666666667 .3529411765)', '#ff00aa5a'],
  ['color(srgb-linear 0 1 0)', '#ff00ff00'], ['lab(50% 0 0)', '#ff777777'],
  ['lch(50% 0 0)', '#ff777777'], ['oklab(.5 0 0)', '#ff636363'],
  ['oklch(.7 .1 150)', '#ff6fb07d'], ['rebeccapurple', '#ff663399'],
  ['RGB(0,170,90)', '#ff00aa5a'], ['ReD', '#ffff0000'],
  ['rgb(none 170 90)', '#ff00aa5a'], ['oklab(.5 none none)', '#ff636363'],
  ['hsl(none 100% 50%)', '#ffff0000'], ['rgb(0 170 90 / none)', '#0000aa5a']
];
for (const quality of ['maximum-fidelity', 'color-groups', 'small-patch-cleanup']) {
  for (const [paint, expected] of paints) test(`${quality} preserves ${paint}`, () => {
    const result = convertSvgToAlightXml(source(paint), { quality, requireExact: true, patchAreaPercent: 0 });
    assert.match(result.xml, new RegExp(`<fillColor value="${expected}"`));
    assert.equal(result.fidelity.exact, true);
    assert.equal((result.xml.match(/<shape\b/g) || []).length, 2);
    assert.equal(result.stats.nodesBefore, result.stats.nodesAfter);
    assert.equal(result.validation.compatibility.ok, true);
  });
}
function converted(content, options = {}) {
  return convertSvgToAlightXml(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">${content}</svg>`, { quality: 'maximum-fidelity', requireExact: true, ...options });
}
test('nested variable fallbacks and case-sensitive custom property names retain distinct colors', () => {
  const r = converted(`<g style="--Brand:#00aa5a;--brand:#0000ff">
    <rect width="20" height="20" fill="var(--Brand, rgb(255,0,0))"/>
    <rect x="25" width="20" height="20" fill="var(--brand)"/>
    <rect x="50" width="20" height="20" fill="var(--missing,var(--also-missing,rgb(0,170,90)))"/>
  </g>`);
  assert.equal((r.xml.match(/<fillColor value="#ff00aa5a"/g) || []).length, 2);
  assert.match(r.xml, /<fillColor value="#ff0000ff"/);
  assert.equal(r.stats.outputShapes, 3);
});
test('cyclic variables use an outer fallback and inherited custom values are computed at the defining element', () => {
  const r = converted(`<g style="--a:var(--b);--b:var(--a);--red:red;--paint:var(--red)">
    <rect width="20" height="20" fill="var(--a,blue)"/>
    <g style="--red:green"><rect x="30" width="20" height="20" fill="var(--paint)"/></g>
  </g>`);
  assert.match(r.xml, /<fillColor value="#ff0000ff"/); assert.match(r.xml, /<fillColor value="#ffff0000"/);
});
test('currentColor on color inherits; CSS initial and unset preserve specified inheritance', () => {
  const r = converted(`<g color="#00aa5a" fill="red"><g color="currentColor">
    <rect width="20" height="20" fill="currentColor"/>
    <rect x="25" width="20" height="20" style="fill:initial"/>
    <rect x="50" width="20" height="20" style="fill:unset"/>
  </g></g>`);
  assert.match(r.xml, /<fillColor value="#ff00aa5a"/); assert.match(r.xml, /<fillColor value="#ffff0000"/);
  assert.equal(r.stats.outputShapes, 3);
});
test('visible descendants of a hidden container retain their shape and color', () => {
  const r = converted('<g visibility="hidden"><rect width="20" height="20" fill="red"/><rect x="25" width="20" height="20" visibility="visible" fill="blue"/></g><rect x="60" width="20" height="20" fill="lime"/>');
  assert.equal(r.stats.outputShapes, 2);assert.match(r.xml, /<fillColor value="#ff0000ff"/);assert.match(r.xml, /<fillColor value="#ff00ff00"/);
});
test('CSS selector lists inside :is/:where and !important cascade do not lose paint', () => {
  const r = converted(`<style><![CDATA[
    :where(.a,.b) {fill:blue} rect:is(.a,.b) {fill:#00aa5a}
    #paint {fill:red!important;fill:blue}
  ]]></style><rect class="a" width="20" height="20"/>
  <rect id="paint" x="25" width="20" height="20" style="fill:lime!important;fill:black"/>`);
  assert.match(r.xml, /<fillColor value="#ff00aa5a"/); assert.match(r.xml, /<fillColor value="#ff00ff00"/);
});
test('an ID selector outranks more than ten class selectors', () => {
  const classes = Array.from({ length: 12 }, (_, i) => `c${i}`);
  const r = converted(`<style>#paint{fill:red}${classes.map(c => '.' + c).join('')}{fill:blue}</style>
    <rect id="paint" class="${classes.join(' ')}" width="40" height="40"/>`);
  assert.match(r.xml, /<fillColor value="#ffff0000"/); assert.doesNotMatch(r.xml, /<fillColor value="#ff0000ff"/);
});
test('invalid later paint declarations leave the previous valid CSS fallback active', () => {
  const r = converted('<rect width="40" height="40" style="fill:lime;fill:not-a-color"/>');
  assert.match(r.xml, /<fillColor value="#ff00ff00"/);
});
test('legacy uppercase RGB functions in inline CSS preserve fill and stroke', () => {
  const r = converted('<rect width="40" height="40" style="fill:RGB(0,170,90);stroke:RGB(255,0,0);stroke-width:2"/>');
  assert.match(r.xml, /<fillColor value="#ff00aa5a"/); assert.match(r.xml, /<color value="#ffff0000"/);
});
test('unmapped ICC/future paint functions do not silently expose default black', () => {
  assert.throws(() => converted('<rect width="40" height="40" style="fill:rgb(0,170,90) icc-color(Legacy,0,.7,.3)"/><rect x="60" width="20" height="20" fill="lime"/>'),
    e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'unsupported-paint' || l.code === 'css-unsupported'));
});
test('gradient stop-color and stop-opacity do not inherit implicitly', () => {
  const r = converted('<defs><linearGradient id="g" stop-color="red" stop-opacity=".2"><stop/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="80" height="40" fill="url(#g)"/>');
  assert.match(r.xml, /startColor="#ff000000" endColor="#ff0000ff"/);
});
test('gradient stop CSS variables/currentColor use the stop context and preserve alpha', () => {
  const r = converted(`<defs><linearGradient id="g" color="#00aa5a" style="--Stop:currentColor">
    <stop stop-color="var(--Stop)" stop-opacity=".5"/>
    <stop offset="1" style="stop-color:rgb(0 0 255)"/>
  </linearGradient></defs><rect width="80" height="40" color="red" fill="url(#g)"/>`);
  assert.match(r.xml, /startColor="#8000aa5a" endColor="#ff0000ff"/);
});
test('unknown fill/stroke functions cannot be reported as exact or silently replaced with black', () => {
  for (const attrs of ['fill="color-mix(in srgb,red,blue)"', 'fill="red" stroke="rgb(from blue r g b)"']) {
    const svg = `<svg width="100" height="50"><rect width="40" height="40" ${attrs}/><rect x="60" width="40" height="40" fill="lime"/></svg>`;
    assert.throws(() => convertSvgToAlightXml(svg, { quality: 'maximum-fidelity', requireExact: true }),
      e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'unsupported-paint'));
    const result = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity' });
    assert.equal(result.fidelity.exact, false); assert.ok(result.stats.unsupportedPaints > 0);
  }
});
test('wide-gamut clipping is explicit and rejected by requireExact', () => {
  assert.throws(() => convertSvgToAlightXml(source('color(display-p3 1 0 0)'), { quality: 'maximum-fidelity', requireExact: true }),
    e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'color-gamut'));
});
test('gradient color-space differences cannot be reported as exact', () => {
  for (const attrs of ['color="color(srgb 0 .7 .3)"', 'color="green" color-interpolation="linearRGB"']) {
    const content = `<defs><linearGradient id="g" ${attrs}><stop stop-color="currentColor"/><stop offset="1" stop-color="cyan"/></linearGradient></defs><rect width="80" height="40" fill="url(#g)"/>`;
    assert.throws(() => converted(content), e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'gradient-color-space'));
  }
});
test('linear two-stop gradients retain nonzero start and nonunit end offsets', () => {
  const r = converted('<defs><linearGradient id="g"><stop offset=".2" stop-color="lime"/><stop offset=".8" stop-color="blue"/></linearGradient></defs><rect width="80" height="40" fill="url(#g)"/>');
  assert.match(r.xml, /start="0.20000000,0.00000000" end="0.80000000,0.00000000"/);
});
test('unrepresentable radial offsets and coincident hard stops are not called exact', () => {
  for (const gradient of ['<radialGradient id="g"><stop offset=".2" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient>', '<linearGradient id="g"><stop offset=".5" stop-color="red"/><stop offset=".5" stop-color="blue"/></linearGradient>']) {
    assert.throws(() => converted(`<defs>${gradient}</defs><rect width="80" height="40" fill="url(#g)"/>`), e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'gradient-stop-offset'));
  }
});
test('conditional styles are not applied unconditionally or called exact', () => {
  const content = '<style>@media print{rect{fill:blue}}</style><rect width="40" height="40" fill="red"/>';
  assert.throws(() => converted(content), e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'css-unsupported'));
  const result = converted(content, { requireExact: false });
  assert.match(result.xml, /<fillColor value="#ffff0000"/); assert.doesNotMatch(result.xml, /<fillColor value="#ff0000ff"/);
});
test('unmapped CSS geometry/reset and excessive variable expansion cannot claim exact fidelity', () => {
  const expanding = Array.from({ length: 15 }, (_, i) => `--v${i}:` + (i ? `var(--v${i-1}) `.repeat(4) : 'red')).join(';');
  for (const style of ['all:initial', 'transform:translate(10px)', 'stroke:blue;stroke-width:calc(2px + 1px)', expanding + ';fill:var(--v14)']) {
    assert.throws(() => converted(`<rect width="40" height="40" style="${style}"/><rect x="60" width="20" height="20" fill="lime"/>`),
      e => e.code === 'FIDELITY_REQUIREMENT_FAILED' && e.fidelity.losses.some(l => l.code === 'css-unsupported'));
  }
});

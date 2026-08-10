import { load } from 'cheerio';
import svgpath from 'svgpath';
import pathBounds from 'svg-path-bounds';
import colorNames from 'color-name';

const DRAWABLE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'symbol', 'switch']);
const SKIP_TAGS = new Set([
  'defs', 'lineargradient', 'radialgradient', 'style', 'metadata', 'title', 'desc',
  'clippath', 'mask', 'pattern', 'marker', 'filter', 'foreignobject', 'script'
]);
const INHERITED_STYLE_KEYS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linejoin', 'stroke-linecap', 'color', 'visibility'
];
const DEFAULT_STYLE = {
  fill: '#000000',
  'fill-opacity': '1',
  'fill-rule': 'nonzero',
  stroke: 'none',
  'stroke-opacity': '1',
  'stroke-width': '1',
  'stroke-linejoin': 'miter',
  'stroke-linecap': 'butt',
  color: '#000000',
  visibility: 'visible'
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function finiteNumber(value, fallback = 0) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseOpacity(value, fallback = 1) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  if (text.endsWith('%')) return clamp(finiteNumber(text, fallback * 100) / 100, 0, 1);
  return clamp(finiteNumber(text, fallback), 0, 1);
}

function parseLength(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : fallback;
}

function parseUnitValue(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  if (text.endsWith('%')) return finiteNumber(text, fallback * 100) / 100;
  return finiteNumber(text, fallback);
}

function hexByte(v) {
  return clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

function parseRgbComponent(value) {
  const t = String(value).trim();
  if (t.endsWith('%')) return clamp(finiteNumber(t) * 2.55, 0, 255);
  return clamp(finiteNumber(t), 0, 255);
}

function parseCssColor(input, opacity = 1, currentColor = '#000000') {
  if (input == null) return null;
  let raw = String(input).trim();
  if (!raw || raw.toLowerCase() === 'none') return null;
  if (raw.toLowerCase() === 'currentcolor') raw = currentColor || '#000000';
  const lower = raw.toLowerCase();
  if (lower === 'transparent') return '#00000000';

  let r, g, b, a = 1;

  if (lower.startsWith('#')) {
    const h = lower.slice(1);
    if (/^[0-9a-f]{3}$/i.test(h)) {
      r = Number.parseInt(h[0] + h[0], 16); g = Number.parseInt(h[1] + h[1], 16); b = Number.parseInt(h[2] + h[2], 16);
    } else if (/^[0-9a-f]{4}$/i.test(h)) {
      r = Number.parseInt(h[0] + h[0], 16); g = Number.parseInt(h[1] + h[1], 16); b = Number.parseInt(h[2] + h[2], 16); a = Number.parseInt(h[3] + h[3], 16) / 255;
    } else if (/^[0-9a-f]{6}$/i.test(h)) {
      r = Number.parseInt(h.slice(0, 2), 16); g = Number.parseInt(h.slice(2, 4), 16); b = Number.parseInt(h.slice(4, 6), 16);
    } else if (/^[0-9a-f]{8}$/i.test(h)) {
      r = Number.parseInt(h.slice(0, 2), 16); g = Number.parseInt(h.slice(2, 4), 16); b = Number.parseInt(h.slice(4, 6), 16); a = Number.parseInt(h.slice(6, 8), 16) / 255;
    }
  } else if (/^rgba?\(/i.test(raw)) {
    const inside = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')).trim();
    let alphaPart = null;
    let colorPart = inside;
    if (inside.includes('/')) {
      [colorPart, alphaPart] = inside.split('/', 2).map((s) => s.trim());
    }
    const parts = colorPart.includes(',') ? colorPart.split(',').map((s) => s.trim()) : colorPart.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      [r, g, b] = parts.slice(0, 3).map(parseRgbComponent);
      if (parts.length >= 4 && alphaPart == null) alphaPart = parts[3];
      if (alphaPart != null) a = parseOpacity(alphaPart, 1);
    }
  } else if (/^hsla?\(/i.test(raw)) {
    const inside = raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')).trim();
    let alphaPart = null;
    let colorPart = inside;
    if (inside.includes('/')) {
      [colorPart, alphaPart] = inside.split('/', 2).map((s) => s.trim());
    }
    const parts = colorPart.includes(',') ? colorPart.split(',').map((s) => s.trim()) : colorPart.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      const h = finiteNumber(parts[0]);
      const s = String(parts[1]).trim().endsWith('%') ? finiteNumber(parts[1]) / 100 : finiteNumber(parts[1]);
      const l = String(parts[2]).trim().endsWith('%') ? finiteNumber(parts[2]) / 100 : finiteNumber(parts[2]);
      [r, g, b] = hslToRgb(h, s, l);
      if (parts.length >= 4 && alphaPart == null) alphaPart = parts[3];
      if (alphaPart != null) a = parseOpacity(alphaPart, 1);
    }
  } else {
    const named = colorNames[lower];
    if (Array.isArray(named)) [r, g, b] = named;
  }

  if (![r, g, b].every(Number.isFinite)) return null;
  a = clamp(a * opacity, 0, 1);
  // Alight Motion memakai format #AARRGGBB.
  return `#${hexByte(a * 255)}${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

function parseStyleDeclarations(text) {
  const out = {};
  if (!text) return out;
  for (const part of String(text).split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim().replace(/\s*!important\s*$/i, '');
    if (key) out[key] = value;
  }
  return out;
}

function selectorSpecificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length;
  const tags = /^[a-z][\w-]*/i.test(selector.trim()) ? 1 : 0;
  return ids * 100 + classes * 10 + tags;
}

function parseCssRules($) {
  const rules = [];
  let order = 0;
  $('style').each((_, node) => {
    const css = $(node).text().replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const declarations = parseStyleDeclarations(m[2]);
      for (const rawSelector of m[1].split(',')) {
        const selector = rawSelector.trim();
        if (!selector || /[>+~:\[]/.test(selector) || /\s/.test(selector)) continue;
        rules.push({ selector, declarations, specificity: selectorSpecificity(selector), order: order++ });
      }
    }
  });
  return rules;
}

function matchesSimpleSelector(node, selector) {
  const attrs = node.attribs || {};
  const tag = String(node.name || '').toLowerCase();
  if (selector === '*') return true;

  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch && attrs.id !== idMatch[1]) return false;

  const classes = (attrs.class || '').split(/\s+/).filter(Boolean);
  const classMatches = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  if (classMatches.some((c) => !classes.includes(c))) return false;

  const tagMatch = selector.match(/^([a-z][\w-]*)/i);
  if (tagMatch && tag !== tagMatch[1].toLowerCase()) return false;

  return Boolean(tagMatch || idMatch || classMatches.length || selector === '*');
}

function computedStyle(node, parentStyle, cssRules) {
  const attrs = node.attribs || {};
  const style = {};
  for (const key of INHERITED_STYLE_KEYS) {
    if (parentStyle?.[key] != null) style[key] = parentStyle[key];
    else if (DEFAULT_STYLE[key] != null) style[key] = DEFAULT_STYLE[key];
  }

  const presentationKeys = [
    ...INHERITED_STYLE_KEYS, 'display', 'opacity', 'clip-path', 'mask',
    'vector-effect', 'paint-order', 'filter'
  ];
  for (const key of presentationKeys) {
    if (attrs[key] != null) style[key] = attrs[key];
  }

  const matched = cssRules.filter((r) => matchesSimpleSelector(node, r.selector))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of matched) Object.assign(style, rule.declarations);
  Object.assign(style, parseStyleDeclarations(attrs.style));
  return style;
}

function parseViewBox(rootAttrs) {
  const vb = String(rootAttrs.viewBox || rootAttrs.viewbox || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb;
  return null;
}

function rootGeometry(rootAttrs) {
  const viewBox = parseViewBox(rootAttrs);
  let width = parseLength(rootAttrs.width, NaN);
  let height = parseLength(rootAttrs.height, NaN);
  if (!Number.isFinite(width) || width <= 0) width = viewBox?.[2] || 1080;
  if (!Number.isFinite(height) || height <= 0) height = viewBox?.[3] || 1080;
  width = clamp(Math.round(width), 1, 8192);
  height = clamp(Math.round(height), 1, 8192);

  if (!viewBox) return { width, height, rootMatrix: [1, 0, 0, 1, 0, 0] };
  const [x, y, w, h] = viewBox;
  const sx = width / w;
  const sy = height / h;
  return { width, height, rootMatrix: [sx, 0, 0, sy, -x * sx, -y * sy] };
}

function roundedRectPath(attrs) {
  const x = parseLength(attrs.x, 0), y = parseLength(attrs.y, 0);
  const w = Math.max(0, parseLength(attrs.width, 0)), h = Math.max(0, parseLength(attrs.height, 0));
  if (w <= 0 || h <= 0) return null;
  let rx = Math.max(0, parseLength(attrs.rx, 0));
  let ry = Math.max(0, parseLength(attrs.ry, rx));
  if (attrs.rx == null && attrs.ry != null) rx = ry;
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (rx <= 0 && ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  if (rx <= 0) rx = ry; if (ry <= 0) ry = rx;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

function drawableToPath(tag, attrs) {
  switch (tag) {
    case 'path': return attrs.d?.trim() || null;
    case 'rect': return roundedRectPath(attrs);
    case 'circle': {
      const cx = parseLength(attrs.cx, 0), cy = parseLength(attrs.cy, 0), r = Math.max(0, parseLength(attrs.r, 0));
      if (!r) return null;
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
    }
    case 'ellipse': {
      const cx = parseLength(attrs.cx, 0), cy = parseLength(attrs.cy, 0);
      const rx = Math.max(0, parseLength(attrs.rx, 0)), ry = Math.max(0, parseLength(attrs.ry, 0));
      if (!rx || !ry) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line': {
      const x1 = parseLength(attrs.x1, 0), y1 = parseLength(attrs.y1, 0), x2 = parseLength(attrs.x2, 0), y2 = parseLength(attrs.y2, 0);
      return `M${x1} ${y1}L${x2} ${y2}`;
    }
    case 'polyline':
    case 'polygon': {
      const nums = String(attrs.points || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (nums.length < 4) return null;
      let d = `M${nums[0]} ${nums[1]}`;
      for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`;
      if (tag === 'polygon') d += 'Z';
      return d;
    }
    default: return null;
  }
}

function normalizePathForAlight(d, transformChain, rootMatrix, precision) {
  let p = svgpath(d).abs().unshort().unarc();
  for (let i = transformChain.length - 1; i >= 0; i--) {
    const transform = transformChain[i];
    if (transform) p.transform(transform);
  }
  p.matrix(rootMatrix).abs().unshort().unarc();

  p.iterate((seg, _idx, x, y) => {
    const cmd = seg[0];
    if (cmd === 'H') return [['L', seg[1], y]];
    if (cmd === 'V') return [['L', x, seg[1]]];
    if (cmd === 'Q') {
      const [, x1, y1, x2, y2] = seg;
      const c1x = x + (2 / 3) * (x1 - x);
      const c1y = y + (2 / 3) * (y1 - y);
      const c2x = x2 + (2 / 3) * (x1 - x2);
      const c2y = y2 + (2 / 3) * (y1 - y2);
      return [['C', c1x, c1y, c2x, c2y, x2, y2]];
    }
    return undefined;
  });

  return p.round(precision).toString();
}


function pathNumber(value, precision = 3) {
  if (!Number.isFinite(value)) throw new Error('Path berisi koordinat non-finite.');
  const fixed = value.toFixed(precision);
  const cleaned = fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return cleaned === '-0' || cleaned === '' ? '0' : cleaned;
}

// Alight Motion export memakai bentuk path yang lebih eksplisit daripada serializer
// SVG biasa: command diulang per segment, ada spasi setelah M/L/C, dan pasangan
// control-point cubic dipisahkan koma. Jangan gunakan svgpath().toString() untuk
// output final karena serializer itu mengompakkan angka negatif dan command
// berulang (contoh M-5-10C-1-2...), yang valid di SVG tetapi ditolak importer AM.
function serializePathForAlight(d, precision = 3) {
  const p = svgpath(d).abs().unshort().unarc();
  const out = [];

  p.iterate((seg, _idx, x, y) => {
    const cmd = String(seg[0] || '').toUpperCase();
    const n = (v) => pathNumber(Number(v), precision);

    if (cmd === 'M') {
      out.push(`M ${n(seg[1])} ${n(seg[2])}`);
      return undefined;
    }
    if (cmd === 'L') {
      out.push(`L ${n(seg[1])} ${n(seg[2])}`);
      return undefined;
    }
    if (cmd === 'H') {
      out.push(`L ${n(seg[1])} ${n(y)}`);
      return undefined;
    }
    if (cmd === 'V') {
      out.push(`L ${n(x)} ${n(seg[1])}`);
      return undefined;
    }
    if (cmd === 'Q') {
      const [, x1, y1, x2, y2] = seg;
      const c1x = x + (2 / 3) * (x1 - x);
      const c1y = y + (2 / 3) * (y1 - y);
      const c2x = x2 + (2 / 3) * (x1 - x2);
      const c2y = y2 + (2 / 3) * (y1 - y2);
      out.push(`C ${n(c1x)} ${n(c1y)}, ${n(c2x)} ${n(c2y)}, ${n(x2)} ${n(y2)}`);
      return undefined;
    }
    if (cmd === 'C') {
      out.push(`C ${n(seg[1])} ${n(seg[2])}, ${n(seg[3])} ${n(seg[4])}, ${n(seg[5])} ${n(seg[6])}`);
      return undefined;
    }
    if (cmd === 'Z') {
      out.push('Z');
      return undefined;
    }

    throw new Error(`Command path ${cmd || '?'} tidak didukung profil Alight Motion.`);
  });

  const result = out.join('');
  if (!result.startsWith('M ')) throw new Error('Path Alight Motion harus dimulai dengan M.');
  return result;
}

function safeBounds(d) {
  try {
    const b = pathBounds(d);
    if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) return b;
  } catch {}
  return null;
}

function pointViaTransforms(x, y, transformChain, rootMatrix) {
  try {
    let p = svgpath(`M${x} ${y}`);
    for (let i = transformChain.length - 1; i >= 0; i--) {
      if (transformChain[i]) p.transform(transformChain[i]);
    }
    p.matrix(rootMatrix).abs().round(8);
    const m = p.toString().match(/M\s*(-?[\d.]+(?:e[-+]?\d+)?)\s*,?\s*(-?[\d.]+(?:e[-+]?\d+)?)/i);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch {}
  return [x, y];
}

function transformedStrokeWidth(width, transformChain, rootMatrix) {
  const w = Math.max(0, width);
  if (!w) return 0;
  const p0 = pointViaTransforms(0, 0, transformChain, rootMatrix);
  const px = pointViaTransforms(w, 0, transformChain, rootMatrix);
  const py = pointViaTransforms(0, w, transformChain, rootMatrix);
  const dx = Math.hypot(px[0] - p0[0], px[1] - p0[1]);
  const dy = Math.hypot(py[0] - p0[0], py[1] - p0[1]);
  const value = (dx + dy) / 2;
  return Number.isFinite(value) ? value : w;
}

function gradientRef(value) {
  const m = String(value || '').match(/^url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)$/i);
  return m ? m[1] : null;
}

function stopInfo($, stopNode) {
  const attrs = stopNode.attribs || {};
  const style = { ...attrs, ...parseStyleDeclarations(attrs.style) };
  return {
    offset: clamp(parseUnitValue(style.offset, 0), 0, 1),
    color: style['stop-color'] || '#000000',
    opacity: parseOpacity(style['stop-opacity'], 1)
  };
}

function collectGradientNodes($) {
  const nodes = new Map();
  $('linearGradient, radialGradient').each((_, node) => {
    const id = node.attribs?.id;
    if (id) nodes.set(id, node);
  });
  return nodes;
}

function resolveGradient($, gradientNodes, id, stack = new Set()) {
  if (!id || stack.has(id)) return null;
  const node = gradientNodes.get(id);
  if (!node) return null;
  stack.add(id);
  const attrs = { ...(node.attribs || {}) };
  const href = attrs.href || attrs['xlink:href'];
  let base = null;
  if (href?.startsWith('#')) base = resolveGradient($, gradientNodes, href.slice(1), stack);

  const ownStops = $(node).children('stop').toArray().map((s) => stopInfo($, s));
  const stops = (ownStops.length ? ownStops : base?.stops || []).sort((a, b) => a.offset - b.offset);
  return {
    type: String(node.name).toLowerCase() === 'radialgradient' ? 'radial' : 'linear',
    attrs: { ...(base?.attrs || {}), ...attrs },
    stops
  };
}

function gradientForShape({ $, gradientNodes, id, localBounds, finalBounds, transformChain, rootMatrix, fillOpacity, currentColor }) {
  const gradient = resolveGradient($, gradientNodes, id);
  if (!gradient || gradient.stops.length === 0) return null;
  const first = gradient.stops[0], last = gradient.stops.at(-1);
  const attrs = gradient.attrs;
  const units = String(attrs.gradientUnits || 'objectBoundingBox').toLowerCase();
  const local = localBounds || finalBounds;
  if (!local) return null;
  const [lx1, ly1, lx2, ly2] = local;
  const lw = Math.max(1e-9, lx2 - lx1), lh = Math.max(1e-9, ly2 - ly1);
  const [fx1, fy1, fx2, fy2] = finalBounds;
  const fw = Math.max(1e-9, fx2 - fx1), fh = Math.max(1e-9, fy2 - fy1);

  let pStart, pEnd;
  if (gradient.type === 'linear') {
    const x1 = attrs.x1 ?? '0%', y1 = attrs.y1 ?? '0%', x2 = attrs.x2 ?? '100%', y2 = attrs.y2 ?? '0%';
    if (units === 'userspaceonuse') {
      pStart = [parseLength(x1, 0), parseLength(y1, 0)];
      pEnd = [parseLength(x2, lw), parseLength(y2, 0)];
    } else {
      pStart = [parseUnitValue(x1, 0), parseUnitValue(y1, 0)];
      pEnd = [parseUnitValue(x2, 1), parseUnitValue(y2, 0)];
      if (attrs.gradientTransform) {
        pStart = pointViaTransforms(pStart[0], pStart[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
        pEnd = pointViaTransforms(pEnd[0], pEnd[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
      }
      pStart = [lx1 + pStart[0] * lw, ly1 + pStart[1] * lh];
      pEnd = [lx1 + pEnd[0] * lw, ly1 + pEnd[1] * lh];
    }
  } else {
    const cx = attrs.cx ?? '50%', cy = attrs.cy ?? '50%', r = attrs.r ?? '50%';
    if (units === 'userspaceonuse') {
      const c = [parseLength(cx, (lx1 + lx2) / 2), parseLength(cy, (ly1 + ly2) / 2)];
      const radius = parseLength(r, Math.min(lw, lh) / 2);
      pStart = c; pEnd = [c[0] + radius, c[1]];
    } else {
      let c = [parseUnitValue(cx, 0.5), parseUnitValue(cy, 0.5)];
      let e = [c[0] + parseUnitValue(r, 0.5), c[1]];
      if (attrs.gradientTransform) {
        c = pointViaTransforms(c[0], c[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
        e = pointViaTransforms(e[0], e[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
      }
      pStart = [lx1 + c[0] * lw, ly1 + c[1] * lh];
      pEnd = [lx1 + e[0] * lw, ly1 + e[1] * lh];
    }
  }

  if (units === 'userspaceonuse' && attrs.gradientTransform) {
    pStart = pointViaTransforms(pStart[0], pStart[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
    pEnd = pointViaTransforms(pEnd[0], pEnd[1], [attrs.gradientTransform], [1, 0, 0, 1, 0, 0]);
  }

  const fs = pointViaTransforms(pStart[0], pStart[1], transformChain, rootMatrix);
  const fe = pointViaTransforms(pEnd[0], pEnd[1], transformChain, rootMatrix);
  const start = [(fs[0] - fx1) / fw, (fs[1] - fy1) / fh];
  const end = [(fe[0] - fx1) / fw, (fe[1] - fy1) / fh];
  const startColor = parseCssColor(first.color, first.opacity * fillOpacity, currentColor) || '#ff000000';
  const endColor = parseCssColor(last.color, last.opacity * fillOpacity, currentColor) || startColor;

  return {
    type: gradient.type,
    startColor,
    endColor,
    start,
    end,
    reducedStops: gradient.stops.length > 2
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmt(value, precision = 6) {
  if (!Number.isFinite(value)) return '0.000000';
  const fixed = value.toFixed(precision);
  return fixed === '-0.000000' ? '0.000000' : fixed;
}

function sanitizeTitle(value) {
  const t = String(value || 'SVG Import').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return t.slice(0, 80) || 'SVG Import';
}

function buildShapeXml(shape, index, duration, precision) {
  const id = 200000001 + index;
  const label = `Vector ${String(index + 1).padStart(3, '0')}`;
  const fillType = shape.gradient ? 'gradient' : shape.fillColor ? 'color' : 'none';
  const lines = [];
  lines.push(`  <shape id="${id}" label="${label}" startTime="0" endTime="${duration}" fillType="${fillType}" mediaFillMode="fill">`);
  lines.push('    <transform>');
  lines.push(`      <location value="${fmt(shape.cx)},${fmt(shape.cy)},0.000000" />`);
  // Semua shape path pada XML referensi resmi memiliki scale eksplisit.
  // Identity scale tetap ditulis agar importer Alight Motion tidak bergantung
  // pada default transform internal.
  lines.push('      <scale value="1.000000,1.000000" />');
  lines.push('    </transform>');
  lines.push(`    <fillColor value="${shape.fillColor || shape.gradient?.startColor || '#00000000'}" />`);
  if (shape.gradient) {
    const g = shape.gradient;
    lines.push(`    <gradient type="${g.type}" startColor="${g.startColor}" endColor="${g.endColor}" start="${fmt(g.start[0])},${fmt(g.start[1])}" end="${fmt(g.end[0])},${fmt(g.end[1])}" />`);
  }
  if (shape.strokeColor && shape.strokeWidth > 0) {
    const join = ['round', 'bevel', 'miter'].includes(shape.strokeJoin) ? shape.strokeJoin : 'miter';
    lines.push(`    <path-stroke direction="centered" join="${join}" end-size="1.500000">`);
    lines.push(`      <color value="${shape.strokeColor}" />`);
    lines.push(`      <size value="${fmt(shape.strokeWidth, Math.min(precision + 2, 6))}" />`);
    lines.push('    </path-stroke>');
  }
  lines.push(`    <path d="${xmlEscape(shape.localPath)}" />`);
  lines.push('  </shape>');
  return lines.join('\n');
}

export function convertSvgToAlightXml(svgInput, rawOptions = {}) {
  if (typeof svgInput !== 'string' || !svgInput.trim()) throw new Error('SVG kosong.');
  if (!/<svg\b/i.test(svgInput)) throw new Error('Input bukan dokumen SVG yang valid.');

  const options = {
    minAreaPercent: clamp(finiteNumber(rawOptions.minAreaPercent, 0.003), 0, 5),
    maxShapes: clamp(Math.round(finiteNumber(rawOptions.maxShapes, 180)), 1, 1000),
    precision: clamp(Math.round(finiteNumber(rawOptions.precision, 3)), 0, 6),
    duration: clamp(Math.round(finiteNumber(rawOptions.duration, 1000)), 100, 600000),
    fps: clamp(Math.round(finiteNumber(rawOptions.fps, 30)), 1, 240),
    title: sanitizeTitle(rawOptions.title || 'SVG to Alight Motion')
  };

  const $ = load(svgInput, { xml: { xmlMode: true, decodeEntities: false } });
  const root = $('svg').first();
  if (!root.length) throw new Error('Elemen <svg> tidak ditemukan.');
  const rootNode = root.get(0);
  const rootAttrs = rootNode.attribs || {};
  const { width, height, rootMatrix } = rootGeometry(rootAttrs);
  const sceneArea = width * height;
  const minArea = sceneArea * (options.minAreaPercent / 100);
  const cssRules = parseCssRules($);
  const gradientNodes = collectGradientNodes($);
  const idNodes = new Map();
  $('[id]').each((_, node) => idNodes.set(node.attribs.id, node));

  const stats = {
    inputBytes: Buffer.byteLength(svgInput, 'utf8'),
    drawableElements: 0,
    candidateShapes: 0,
    outputShapes: 0,
    removedTiny: 0,
    removedByLimit: 0,
    gradients: 0,
    strokes: 0,
    skippedUnsupported: 0,
    unresolvedUses: 0,
    gradientStopsReduced: 0,
    clipOrMaskWarnings: 0
  };
  const warnings = new Set();
  const candidates = [];
  let sourceOrder = 0;

  const walk = (node, context, useStack = new Set()) => {
    if (!node || node.type !== 'tag') return;
    const tag = String(node.name || '').toLowerCase();
    const attrs = node.attribs || {};
    const style = computedStyle(node, context.style, cssRules);
    if (String(style.display || '').toLowerCase() === 'none' || ['hidden', 'collapse'].includes(String(style.visibility || '').toLowerCase())) return;

    const ownOpacity = parseOpacity(style.opacity, 1);
    const cumulativeOpacity = context.opacity * ownOpacity;
    if (cumulativeOpacity <= 0) return;
    const transforms = attrs.transform ? [...context.transforms, attrs.transform] : context.transforms;

    if (tag === 'use') {
      const href = attrs.href || attrs['xlink:href'];
      const id = href?.startsWith('#') ? href.slice(1) : null;
      if (!id || useStack.has(id) || !idNodes.has(id)) {
        stats.unresolvedUses++;
        warnings.add('Ada <use> yang tidak bisa di-resolve.');
        return;
      }
      const useTransforms = [...context.transforms];
      if (attrs.transform) useTransforms.push(attrs.transform);
      const x = parseLength(attrs.x, 0), y = parseLength(attrs.y, 0);
      if (x || y) useTransforms.push(`translate(${x} ${y})`);
      const nextStack = new Set(useStack); nextStack.add(id);
      walk(idNodes.get(id), { style, opacity: cumulativeOpacity, transforms: useTransforms }, nextStack);
      return;
    }

    if (SKIP_TAGS.has(tag)) return;

    if (CONTAINER_TAGS.has(tag)) {
      const childContext = { style, opacity: cumulativeOpacity, transforms };
      for (const child of node.children || []) walk(child, childContext, useStack);
      return;
    }

    if (!DRAWABLE_TAGS.has(tag)) {
      if (!['stop'].includes(tag)) {
        stats.skippedUnsupported++;
        if (['text', 'image'].includes(tag)) warnings.add(`Elemen <${tag}> dilewati karena bukan path vector.`);
      }
      return;
    }

    stats.drawableElements++;
    const d = drawableToPath(tag, attrs);
    if (!d) return;
    let localBounds = safeBounds(d);
    let transformed;
    try {
      transformed = normalizePathForAlight(d, transforms, rootMatrix, options.precision + 2);
    } catch {
      stats.skippedUnsupported++;
      warnings.add('Ada path SVG yang sintaksnya tidak dapat diproses.');
      return;
    }
    const b = safeBounds(transformed);
    if (!b) return;
    const [x1, y1, x2, y2] = b;
    const bw = Math.max(0, x2 - x1), bh = Math.max(0, y2 - y1);
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;

    const currentColor = style.color || '#000000';
    const fillOpacity = cumulativeOpacity * parseOpacity(style['fill-opacity'], 1);
    const strokeOpacity = cumulativeOpacity * parseOpacity(style['stroke-opacity'], 1);
    const fillValue = style.fill ?? '#000000';
    const strokeValue = style.stroke ?? 'none';
    const gradId = gradientRef(fillValue);
    let gradient = null;
    let fillColor = null;
    if (gradId) {
      gradient = gradientForShape({
        $, gradientNodes, id: gradId, localBounds, finalBounds: b,
        transformChain: transforms, rootMatrix, fillOpacity, currentColor
      });
      if (gradient) {
        fillColor = gradient.startColor;
        stats.gradients++;
        if (gradient.reducedStops) {
          stats.gradientStopsReduced++;
          warnings.add('Gradient dengan >2 stop disederhanakan menjadi warna awal dan akhir agar cocok dengan format referensi Alight Motion.');
        }
      } else {
        warnings.add(`Gradient #${gradId} tidak ditemukan; fill dilewati.`);
      }
    } else {
      fillColor = parseCssColor(fillValue, fillOpacity, currentColor);
    }

    const strokeColor = parseCssColor(strokeValue, strokeOpacity, currentColor);
    const rawStrokeWidth = Math.max(0, parseLength(style['stroke-width'], 1));
    const strokeWidth = strokeColor ? transformedStrokeWidth(rawStrokeWidth, transforms, rootMatrix) : 0;
    if (!fillColor && !gradient && !strokeColor) return;
    if (strokeColor && strokeWidth > 0) stats.strokes++;

    if ((style['clip-path'] && style['clip-path'] !== 'none') || (style.mask && style.mask !== 'none')) {
      stats.clipOrMaskWarnings++;
      warnings.add('clip-path/mask belum dapat dipetakan 1:1 ke XML Alight Motion; bentuk utama tetap dipertahankan.');
    }
    if (style.filter && style.filter !== 'none') {
      warnings.add('Filter SVG kompleks dilewati; geometri dan warna dasar tetap dikonversi.');
    }
    if (String(style['fill-rule'] || '').toLowerCase() === 'evenodd') {
      warnings.add('fill-rule="evenodd" dipertahankan sebagai path, tetapi hasil lubang/overlap perlu dicek di Alight Motion.');
    }

    const area = bw * bh;
    const effectiveArea = Math.max(area, Math.max(bw, bh) * strokeWidth);
    if (effectiveArea < minArea) {
      stats.removedTiny++;
      return;
    }

    let localPath;
    try {
      localPath = serializePathForAlight(svgpath(transformed).translate(-cx, -cy).abs().round(options.precision).toString(), options.precision);
    } catch {
      return;
    }
    if (!localPath) return;

    candidates.push({
      sourceOrder: sourceOrder++,
      area: effectiveArea,
      cx, cy, localPath,
      fillColor,
      gradient,
      strokeColor,
      strokeWidth,
      strokeJoin: String(style['stroke-linejoin'] || 'miter').toLowerCase()
    });
  };

  const rootStyle = computedStyle(rootNode, DEFAULT_STYLE, cssRules);
  const rootOpacity = parseOpacity(rootStyle.opacity, 1);
  for (const child of rootNode.children || []) {
    walk(child, { style: rootStyle, opacity: rootOpacity, transforms: [] });
  }

  stats.candidateShapes = candidates.length;
  let kept = candidates;
  if (candidates.length > options.maxShapes) {
    const keepOrders = new Set([...candidates]
      .sort((a, b) => b.area - a.area || a.sourceOrder - b.sourceOrder)
      .slice(0, options.maxShapes)
      .map((s) => s.sourceOrder));
    kept = candidates.filter((s) => keepOrders.has(s.sourceOrder));
    stats.removedByLimit = candidates.length - kept.length;
    warnings.add(`Jumlah shape dibatasi ke ${options.maxShapes}; detail terkecil dibuang lebih dulu.`);
  }
  stats.outputShapes = kept.length;

  const shapeXml = kept.map((shape, i) => buildShapeXml(shape, i, options.duration, options.precision)).join('\n');
  const scene = [
    `<?xml version='1.0' encoding='UTF-8' ?>`,
    `<!-- Generated from SVG using the supplied Alight Motion XML schema reference -->`,
    `<scene title="${xmlEscape(options.title)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${options.duration}" fps="${options.fps}" modifiedTime="${Date.now()}" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="freeze" retimeAdaptFPS="false">`,
    shapeXml,
    `</scene>`
  ].filter(Boolean).join('\n');

  stats.outputBytes = Buffer.byteLength(scene, 'utf8');
  return {
    xml: scene,
    width,
    height,
    options,
    stats,
    warnings: [...warnings]
  };
}

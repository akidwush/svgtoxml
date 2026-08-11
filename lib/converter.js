import { load } from 'cheerio';
import svgpath from 'svgpath';
import pathBounds from 'svg-path-bounds';
import colorNames from 'color-name';
import { normalizePathForAlight, serializePathForAlight, pathNodeCount, normalizeEvenOddToNonZero } from './path-geometry.js';

const DRAWABLE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'symbol', 'switch']);
const SKIP_TAGS = new Set([
  'defs', 'lineargradient', 'radialgradient', 'style', 'metadata', 'title', 'desc',
  'clippath', 'mask', 'pattern', 'marker', 'filter', 'foreignobject', 'script'
]);
const INHERITED_STYLE_KEYS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linejoin', 'stroke-linecap', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'color', 'visibility'
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
  'stroke-dasharray': 'none',
  'stroke-dashoffset': '0',
  'stroke-miterlimit': '4',
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
        // Keep the common SVG subset: tag/id/class compounds and descendant chains.
        // Pseudo classes, attribute selectors and sibling/child combinators are skipped.
        if (!selector || /[>+~:\[]/.test(selector)) continue;
        rules.push({ selector, declarations, specificity: selectorSpecificity(selector), order: order++ });
      }
    }
  });
  return rules;
}

function matchesSimpleSelector(node, selector) {
  if (!node || node.type !== 'tag') return false;
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

function matchesSelector(node, selector) {
  const parts = String(selector || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !matchesSimpleSelector(node, parts.at(-1))) return false;
  let cursor = node.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (cursor) {
      if (matchesSimpleSelector(cursor, parts[i])) {
        found = true;
        cursor = cursor.parent;
        break;
      }
      cursor = cursor.parent;
    }
    if (!found) return false;
  }
  return true;
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

  const matched = cssRules.filter((r) => matchesSelector(node, r.selector))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of matched) Object.assign(style, rule.declarations);
  Object.assign(style, parseStyleDeclarations(attrs.style));

  // Resolve common CSS-wide keywords used by exported SVGs.
  for (const key of INHERITED_STYLE_KEYS) {
    const value = String(style[key] ?? '').trim().toLowerCase();
    if (value === 'inherit' || value === 'unset') {
      style[key] = parentStyle?.[key] ?? DEFAULT_STYLE[key];
    }
  }
  return style;
}

function parseViewBox(rootAttrs) {
  const vb = String(rootAttrs.viewBox || rootAttrs.viewbox || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb;
  return null;
}

function parsePreserveAspectRatio(value) {
  const raw = String(value || '').trim();
  if (!raw) return { align: 'xMidYMid', mode: 'meet' };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts[0] === 'defer') parts.shift();
  const align = parts[0] || 'xMidYMid';
  const mode = parts[1] === 'slice' ? 'slice' : 'meet';
  return { align, mode };
}

function viewBoxMatrix(viewBox, viewportWidth, viewportHeight, preserveAspectRatio = 'xMidYMid meet', offsetX = 0, offsetY = 0) {
  if (!viewBox) return [1, 0, 0, 1, offsetX, offsetY];
  const [vx, vy, vw, vh] = viewBox;
  const sx = viewportWidth / vw;
  const sy = viewportHeight / vh;
  const { align, mode } = parsePreserveAspectRatio(preserveAspectRatio);

  if (String(align).toLowerCase() === 'none') {
    return [sx, 0, 0, sy, offsetX - vx * sx, offsetY - vy * sy];
  }

  const scale = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const usedW = vw * scale;
  const usedH = vh * scale;
  let dx = 0;
  let dy = 0;
  if (/xMid/i.test(align)) dx = (viewportWidth - usedW) / 2;
  else if (/xMax/i.test(align)) dx = viewportWidth - usedW;
  if (/YMid/i.test(align)) dy = (viewportHeight - usedH) / 2;
  else if (/YMax/i.test(align)) dy = viewportHeight - usedH;
  return [scale, 0, 0, scale, offsetX + dx - vx * scale, offsetY + dy - vy * scale];
}

function rootGeometry(rootAttrs) {
  const viewBox = parseViewBox(rootAttrs);
  let width = parseLength(rootAttrs.width, NaN);
  let height = parseLength(rootAttrs.height, NaN);
  if (!Number.isFinite(width) || width <= 0) width = viewBox?.[2] || 1080;
  if (!Number.isFinite(height) || height <= 0) height = viewBox?.[3] || 1080;
  width = clamp(Math.round(width), 1, 8192);
  height = clamp(Math.round(height), 1, 8192);
  const rootMatrix = viewBoxMatrix(viewBox, width, height, rootAttrs.preserveAspectRatio || rootAttrs.preserveaspectratio);
  return { width, height, rootMatrix };
}

function matrixToTransform(m) {
  return `matrix(${m.map((n) => Number.isFinite(n) ? n : 0).join(' ')})`;
}

function nestedViewportTransform(attrs, override = null) {
  const x = parseLength(attrs.x, 0);
  const y = parseLength(attrs.y, 0);
  const viewBox = parseViewBox(attrs);
  if (!viewBox) return (x || y) ? `translate(${x} ${y})` : '';
  let width = override?.width;
  let height = override?.height;
  if (!Number.isFinite(width) || width <= 0) width = parseLength(attrs.width, viewBox[2]);
  if (!Number.isFinite(height) || height <= 0) height = parseLength(attrs.height, viewBox[3]);
  if (!Number.isFinite(width) || width <= 0) width = viewBox[2];
  if (!Number.isFinite(height) || height <= 0) height = viewBox[3];
  const m = viewBoxMatrix(viewBox, width, height, attrs.preserveAspectRatio || attrs.preserveaspectratio, x, y);
  return matrixToTransform(m);
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

function triangleArea2(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

function simplifyPointChain(points, closed, reductionPercent) {
  const clean = [];
  for (const point of points) {
    if (!clean.length || Math.hypot(point[0] - clean.at(-1)[0], point[1] - clean.at(-1)[1]) > 1e-7) clean.push(point);
  }
  if (closed && clean.length > 1 && Math.hypot(clean[0][0] - clean.at(-1)[0], clean[0][1] - clean.at(-1)[1]) <= 1e-7) clean.pop();
  const minimum = closed ? 3 : 2;
  // Jangan sentuh primitive/silhouette sederhana. Pengurangan node ditujukan
  // terutama untuk contour auto-vector yang memiliki banyak anchor.
  if (clean.length < 8 || reductionPercent <= 0) return clean;

  const target = Math.max(minimum, Math.round(clean.length * (1 - reductionPercent / 100)));
  const work = clean.map((point, index) => ({ point, originalIndex: index }));

  while (work.length > target) {
    let removeAt = -1;
    let best = Infinity;
    const start = closed ? 0 : 1;
    const end = closed ? work.length : work.length - 1;
    for (let i = start; i < end; i++) {
      const prev = work[(i - 1 + work.length) % work.length].point;
      const cur = work[i].point;
      const next = work[(i + 1) % work.length].point;
      const v1 = [prev[0] - cur[0], prev[1] - cur[1]];
      const v2 = [next[0] - cur[0], next[1] - cur[1]];
      const l1 = Math.hypot(v1[0], v1[1]);
      const l2 = Math.hypot(v2[0], v2[1]);
      let angle = 180;
      if (l1 > 1e-9 && l2 > 1e-9) {
        const cosine = clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2), -1, 1);
        angle = Math.acos(cosine) * 180 / Math.PI;
      }
      // Anchor dengan sudut tajam dianggap structural corner dan tidak dibuang.
      if (angle < 135) continue;
      const area = triangleArea2(prev, cur, next);
      if (area < best) {
        best = area;
        removeAt = i;
      }
    }
    if (removeAt < 0) break;
    work.splice(removeAt, 1);
  }
  return work.map((item) => item.point);
}

function catmullRomPath(points, closed, precision) {
  if (!points.length) return '';
  const n = (v) => pathNumber(Number(v), precision);
  if (points.length === 1) return `M ${n(points[0][0])} ${n(points[0][1])}`;
  const out = [`M ${n(points[0][0])} ${n(points[0][1])}`];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const p0 = points[closed ? (i - 1 + points.length) % points.length : Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[closed ? (i + 2) % points.length : Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    out.push(`C ${n(c1[0])} ${n(c1[1])}, ${n(c2[0])} ${n(c2[1])}, ${n(p2[0])} ${n(p2[1])}`);
  }
  if (closed) out.push('Z');
  return out.join('');
}

function segmentListToPath(segments) {
  return segments.map((seg) => `${seg[0]}${seg.slice(1).join(' ')}`).join('');
}

function reducePathNodes(d, reductionPercent = 0, precision = 4) {
  const reduction = clamp(finiteNumber(reductionPercent, 0), 0, 80);
  if (reduction <= 0) return serializePathForAlight(d, precision);
  const p = svgpath(d).abs().unshort().unarc();
  const subpaths = [];
  let current = null;

  p.iterate((seg) => {
    const cmd = String(seg[0] || '').toUpperCase();
    if (cmd === 'M') {
      if (current?.points?.length) subpaths.push(current);
      current = {
        points: [[Number(seg[1]), Number(seg[2])]],
        closed: false,
        segments: [Array.from(seg)]
      };
      return undefined;
    }
    if (!current) return undefined;
    current.segments.push(Array.from(seg));
    if (cmd === 'L') current.points.push([Number(seg[1]), Number(seg[2])]);
    else if (cmd === 'C') current.points.push([Number(seg[5]), Number(seg[6])]);
    else if (cmd === 'Q') current.points.push([Number(seg[3]), Number(seg[4])]);
    else if (cmd === 'H') current.points.push([Number(seg[1]), current.points.at(-1)[1]]);
    else if (cmd === 'V') current.points.push([current.points.at(-1)[0], Number(seg[1])]);
    else if (cmd === 'Z') current.closed = true;
    return undefined;
  });
  if (current?.points?.length) subpaths.push(current);
  if (!subpaths.length) return serializePathForAlight(d, precision);

  return subpaths.map((subpath) => {
    const simplified = simplifyPointChain(subpath.points, subpath.closed, reduction);
    if (simplified.length >= subpath.points.length) {
      return serializePathForAlight(segmentListToPath(subpath.segments), precision);
    }
    return catmullRomPath(simplified, subpath.closed, precision);
  }).filter(Boolean).join('');
}

function blendArgb(a, b, t = 0.5) {
  const parse = (value) => {
    const h = String(value || '#ff000000').replace('#', '').padStart(8, 'f');
    return [0, 2, 4, 6].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  };
  const aa = parse(a), bb = parse(b);
  return `#${aa.map((v, i) => hexByte(v + (bb[i] - v) * t)).join('')}`;
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

function buildShapeXml(shape, id, label, duration, precision, indent = '      ') {
  const lines = [];
  lines.push(`${indent}<shape id="${id}" label="${xmlEscape(label)}" startTime="0" endTime="${duration}" fillType="color" mediaFillMode="fill">`);
  lines.push(`${indent}  <transform>`);
  lines.push(`${indent}    <location value="${fmt(shape.cx)},${fmt(shape.cy)},0.000000" />`);
  lines.push(`${indent}    <scale value="1.000000,1.000000" />`);
  lines.push(`${indent}  </transform>`);
  lines.push(`${indent}  <fillColor value="${shape.fillColor}" />`);
  lines.push(`${indent}  <path d="${xmlEscape(shape.localPath)}" />`);
  lines.push(`${indent}</shape>`);
  return lines.join('\n');
}

function colorLabel(color, index) {
  const raw = String(color || '#ff000000').replace('#', '').toUpperCase();
  const visible = raw.length === 8 && raw.startsWith('FF') ? `#${raw.slice(2)}` : `#${raw}`;
  return `Warna ${String(index + 1).padStart(3, '0')} • ${visible}`;
}

function buildColorGroupXml(group, index, width, height, duration, fps, precision) {
  const groupId = 210000001 + index;
  const shapeId = 220000001 + index;
  const label = colorLabel(group.color, index);
  const innerShape = buildShapeXml({
    cx: group.cx,
    cy: group.cy,
    localPath: group.localPath,
    fillColor: group.color
  }, shapeId, `${label} · Path`, duration, precision, '      ');

  return [
    `  <embedScene id="${groupId}" label="${xmlEscape(label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    '    </transform>',
    `    <fillColor value="${group.color}" />`,
    `    <scene title="${xmlEscape(label)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    innerShape,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}


function sourceLabel(shape, index) {
  const raw = String(shape.sourceLabel || '').trim();
  return (raw || `Vector ${String(index + 1).padStart(3, '0')}`).slice(0, 96);
}

function buildLosslessShapeXml(shape, index, duration, precision, width, height) {
  const id = 310000001 + index;
  const lines = [];
  const fillType = shape.gradient ? 'gradient' : (shape.fillColor ? 'color' : 'none');
  const fillColor = shape.gradient?.startColor || shape.fillColor || shape.strokeColor || '#00000000';
  lines.push(`      <shape id="${id}" label="${xmlEscape(sourceLabel(shape, index))}" startTime="0" endTime="${duration}" fillType="${fillType}" mediaFillMode="fill">`);
  lines.push('        <transform>');
  // Healthy AM XML keeps imported SVG vectors around the scene center and stores
  // path coordinates relative to that center. Follow that proven structure.
  lines.push(`          <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`);
  lines.push('        </transform>');
  lines.push(`        <fillColor value="${fillColor}" />`);
  if (shape.gradient) {
    const g = shape.gradient;
    lines.push(`        <gradient type="${g.type}" startColor="${g.startColor}" endColor="${g.endColor}" start="${fmt(g.start[0], precision)},${fmt(g.start[1], precision)}" end="${fmt(g.end[0], precision)},${fmt(g.end[1], precision)}" />`);
  }
  if (shape.strokeColor && shape.strokeWidth > 0) {
    const join = ['round', 'bevel', 'miter'].includes(shape.strokeJoin) ? shape.strokeJoin : 'miter';
    lines.push(`        <path-stroke direction="centered" join="${join}" end-size="1.500000">`);
    lines.push(`          <color value="${shape.strokeColor}" />`);
    lines.push(`          <size value="${fmt(shape.strokeWidth, precision)}" />`);
    lines.push('        </path-stroke>');
  }
  lines.push(`        <path d="${xmlEscape(shape.localPath)}" />`);
  lines.push('      </shape>');
  return lines.join('\n');
}

function buildLosslessLayerXml(shapes, width, height, duration, fps, precision) {
  const inner = shapes.map((shape, index) => buildLosslessShapeXml(
    shape, index, duration, precision, width, height
  )).join('\n');
  return [
    `  <embedScene id="300000001" label="SVG Lossless Layer" startTime="0" endTime="${duration}" fillType="intrinsic" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    '    </transform>',
    '    <fillColor value="#ff000000" />',
    `    <scene title="" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    inner,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}

const QUALITY_PRESETS = {
  // Existing profiles intentionally stay unchanged.
  accurate: { minAreaPercent: 0, maxShapes: 5000, precision: 5, nodeReduction: 35 },
  balanced: { minAreaPercent: 0.0002, maxShapes: 2500, precision: 4, nodeReduction: 50 },
  lightweight: { minAreaPercent: 0.001, maxShapes: 1000, precision: 3, nodeReduction: 65 },
  lossless: { minAreaPercent: 0, maxShapes: Infinity, precision: 8, nodeReduction: 0 }
};

function resolveQualityOptions(rawOptions = {}) {
  const requested = String(rawOptions.quality || 'accurate').toLowerCase();
  const quality = Object.hasOwn(QUALITY_PRESETS, requested) ? requested : 'accurate';
  const preset = QUALITY_PRESETS[quality];
  const duration = clamp(Math.round(finiteNumber(rawOptions.duration, 1000)), 100, 600000);
  const fps = clamp(Math.round(finiteNumber(rawOptions.fps, 30)), 1, 240);
  const title = sanitizeTitle(rawOptions.title || 'SVG to Alight Motion');

  if (quality === 'lossless') {
    return {
      quality,
      minAreaPercent: 0,
      maxShapes: Infinity,
      precision: 8,
      geometryPrecision: 12,
      nodeReduction: 0,
      groupByColor: false,
      removeStrokes: false,
      validateBounds: rawOptions.validateBounds !== false,
      duration,
      fps,
      title
    };
  }

  const pick = (key) => rawOptions[key] == null || rawOptions[key] === '' ? preset[key] : rawOptions[key];
  return {
    quality,
    minAreaPercent: clamp(finiteNumber(pick('minAreaPercent'), preset.minAreaPercent), 0, 5),
    maxShapes: clamp(Math.round(finiteNumber(pick('maxShapes'), preset.maxShapes)), 1, 5000),
    precision: clamp(Math.round(finiteNumber(pick('precision'), preset.precision)), 0, 6),
    geometryPrecision: clamp(Math.round(finiteNumber(pick('precision'), preset.precision)) + 2, 2, 8),
    nodeReduction: clamp(finiteNumber(pick('nodeReduction'), preset.nodeReduction), 0, 80),
    groupByColor: rawOptions.groupByColor !== false,
    removeStrokes: rawOptions.removeStrokes !== false,
    validateBounds: rawOptions.validateBounds === true,
    duration,
    fps,
    title
  };
}

export function convertSvgToAlightXml(svgInput, rawOptions = {}) {
  if (typeof svgInput !== 'string' || !svgInput.trim()) throw new Error('SVG kosong.');
  if (!/<svg\b/i.test(svgInput)) throw new Error('Input bukan dokumen SVG yang valid.');

  const options = resolveQualityOptions(rawOptions);

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
    gradientsFlattened: 0,
    strokes: 0,
    strokesRemoved: 0,
    strokeOnlyDropped: 0,
    nodesBefore: 0,
    nodesAfter: 0,
    colorGroups: 0,
    mergedShapes: 0,
    skippedUnsupported: 0,
    unresolvedUses: 0,
    gradientStopsReduced: 0,
    clipOrMaskWarnings: 0,
    evenOddNormalized: 0,
    bboxMismatches: 0,
    missingShapes: 0,
    nestedViewports: 0,
    descendantCssRules: cssRules.filter((r) => /\s/.test(r.selector)).length,
    quality: options.quality
  };
  const warnings = new Set();
  const sourceFeatures = {
    paths: $('path').length,
    gradients: $('linearGradient, radialGradient').length,
    uses: $('use').length,
    nestedSvg: $('svg').length > 1 ? $('svg').length - 1 : 0,
    clipPaths: $('clipPath').length,
    masks: $('mask').length,
    filters: $('filter').length,
    text: $('text').length,
    images: $('image').length
  };
  if (sourceFeatures.clipPaths || sourceFeatures.masks) warnings.add('SVG memakai clipPath/mask; bagian ini belum selalu dapat dipetakan 1:1 ke Alight Motion.');
  if (sourceFeatures.filters) warnings.add('SVG memakai filter; filter kompleks tidak selalu tersedia sebagai padanan XML Alight Motion.');
  if (sourceFeatures.text) warnings.add('SVG masih memiliki <text>; ubah text menjadi path untuk fidelity terbaik.');
  if (sourceFeatures.images) warnings.add('SVG memiliki <image>; elemen raster di dalam SVG tidak dikonversi menjadi vector layer.');
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
      const width = parseLength(attrs.width, NaN);
      const height = parseLength(attrs.height, NaN);
      walk(idNodes.get(id), {
        style, opacity: cumulativeOpacity, transforms: useTransforms,
        viewportOverride: { width, height }
      }, nextStack);
      return;
    }

    if (SKIP_TAGS.has(tag)) return;

    if (CONTAINER_TAGS.has(tag)) {
      let containerTransforms = transforms;
      if ((tag === 'svg' || tag === 'symbol') && node !== rootNode) {
        const viewportTransform = nestedViewportTransform(attrs, context.viewportOverride);
        if (viewportTransform) {
          containerTransforms = [...transforms, viewportTransform];
          stats.nestedViewports++;
        }
      }
      const childContext = { style, opacity: cumulativeOpacity, transforms: containerTransforms, viewportOverride: null };
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
      transformed = normalizePathForAlight(d, transforms, rootMatrix, options.geometryPrecision);
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
        stats.gradients++;
        if (gradient.reducedStops) {
          stats.gradientStopsReduced++;
          warnings.add(`Gradient #${gradId} memiliki lebih dari 2 stop. Skema XML Alight Motion referensi hanya membuktikan start/end color; stop tengah belum dapat dipetakan 1:1.`);
        }
        if (options.quality === 'lossless') {
          // Keep native AM gradient instead of flattening it.
          fillColor = gradient.startColor;
        } else {
          // Existing grouped modes keep their v1.4 behavior unchanged.
          fillColor = blendArgb(gradient.startColor, gradient.endColor, 0.5);
          stats.gradientsFlattened++;
          warnings.add('Gradient diratakan menjadi satu warna solid karena mode Color Groups mensyaratkan 1 group = 1 warna.');
        }
      } else {
        warnings.add(`Gradient #${gradId} tidak ditemukan; fill dilewati.`);
      }
    } else {
      fillColor = parseCssColor(fillValue, fillOpacity, currentColor);
    }

    const strokeColor = parseCssColor(strokeValue, strokeOpacity, currentColor);
    const rawStrokeWidth = Math.max(0, parseLength(style['stroke-width'], 1));
    const nonScalingStroke = String(style['vector-effect'] || '').toLowerCase() === 'non-scaling-stroke';
    const strokeWidth = strokeColor
      ? (nonScalingStroke ? rawStrokeWidth : transformedStrokeWidth(rawStrokeWidth, transforms, rootMatrix))
      : 0;
    if (strokeColor && strokeWidth > 0) {
      stats.strokes++;
      if (options.removeStrokes) stats.strokesRemoved++;
    }

    // Existing three modes intentionally stay stroke-free. Lossless keeps native
    // Alight Motion <path-stroke>, including stroke-only paths.
    if (!fillColor && !(options.quality === 'lossless' && strokeColor && strokeWidth > 0)) {
      if (strokeColor && strokeWidth > 0) stats.strokeOnlyDropped++;
      return;
    }

    if ((style['clip-path'] && style['clip-path'] !== 'none') || (style.mask && style.mask !== 'none')) {
      stats.clipOrMaskWarnings++;
      warnings.add('clip-path/mask terdeteksi. Tidak ada mapping clip/mask 1:1 yang terbukti pada XML referensi; base geometry dipertahankan dan fitur ini dilaporkan, bukan dihapus diam-diam.');
    }
    if (style.filter && style.filter !== 'none') {
      warnings.add('Filter SVG kompleks tidak punya padanan 1:1 yang terbukti di skema XML referensi; geometri/fill/stroke dasar tetap dipertahankan.');
    }

    let scenePath = transformed;
    const fillRule = String(style['fill-rule'] || 'nonzero').toLowerCase();
    if (options.quality === 'lossless' && fillRule === 'evenodd') {
      const normalizedRule = normalizeEvenOddToNonZero(scenePath);
      scenePath = normalizedRule.path;
      if (normalizedRule.changed) stats.evenOddNormalized++;
      warnings.add('fill-rule="evenodd" dinormalisasi menjadi alternating subpath winding karena XML AM referensi tidak menunjukkan atribut fill-rule eksplisit. Kurva Bézier tidak disampling/diubah.');
    } else if (fillRule === 'evenodd') {
      warnings.add('fill-rule="evenodd" dipertahankan sebagai path, tetapi hasil lubang/overlap perlu dicek di Alight Motion.');
    }

    const dashArray = String(style['stroke-dasharray'] || 'none').trim();
    const lineCap = String(style['stroke-linecap'] || 'butt').trim().toLowerCase();
    if (options.quality === 'lossless' && strokeColor && strokeWidth > 0) {
      if (dashArray && dashArray.toLowerCase() !== 'none') {
        warnings.add('stroke-dasharray terdeteksi. XML referensi membuktikan path-stroke color/size/join, tetapi belum membuktikan atribut dash; stroke dibuat solid dan warning dikembalikan.');
      }
      if (lineCap !== 'butt') {
        warnings.add(`stroke-linecap="${lineCap}" terdeteksi. XML referensi belum membuktikan mapping cap eksplisit; width/color/join tetap dipertahankan.`);
      }
    }

    const area = bw * bh;
    const effectiveArea = area;
    if (effectiveArea < minArea) {
      stats.removedTiny++;
      return;
    }

    const beforeNodes = pathNodeCount(scenePath);
    if (!beforeNodes) return;
    stats.nodesBefore += beforeNodes;

    const sourceName = attrs.id || attrs['data-name'] || attrs.class || `${tag} ${sourceOrder + 1}`;
    candidates.push({
      sourceOrder: sourceOrder++,
      sourceLabel: sourceName,
      area: effectiveArea,
      bounds: b,
      scenePath,
      fillColor,
      gradient: options.quality === 'lossless' ? gradient : null,
      fillRule,
      strokeColor: options.quality === 'lossless' ? strokeColor : null,
      strokeWidth: options.quality === 'lossless' ? strokeWidth : 0,
      strokeJoin: String(style['stroke-linejoin'] || 'miter').toLowerCase(),
      strokeLineCap: lineCap,
      strokeDashArray: dashArray
    });
  };

  const rootStyle = computedStyle(rootNode, DEFAULT_STYLE, cssRules);
  const rootOpacity = parseOpacity(rootStyle.opacity, 1);
  for (const child of rootNode.children || []) {
    walk(child, { style: rootStyle, opacity: rootOpacity, transforms: [], viewportOverride: null });
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
    warnings.add(`Jumlah shape melebihi batas mode ${options.quality} (${options.maxShapes}); detail terkecil dibuang lebih dulu.`);
  }
  if (options.quality === 'lossless') {
    const centerX = width / 2;
    const centerY = height / 2;
    const losslessShapes = [];
    const bboxDetails = [];

    // Never sort, merge or area-prune here. Source order is the z-order.
    for (const shape of kept) {
      let localPath;
      try {
        const translated = svgpath(shape.scenePath).translate(-centerX, -centerY).abs().toString();
        localPath = serializePathForAlight(translated, options.precision);
      } catch (error) {
        stats.skippedUnsupported++;
        warnings.add(`Shape "${shape.sourceLabel}" gagal diserialisasi ke path AM: ${error?.message || error}`);
        continue;
      }

      const afterNodes = pathNodeCount(localPath);
      stats.nodesAfter += afterNodes;
      const outputShape = { ...shape, cx: centerX, cy: centerY, localPath };
      losslessShapes.push(outputShape);

      if (options.validateBounds) {
        const localBounds = safeBounds(localPath);
        if (localBounds) {
          const outputBounds = [
            localBounds[0] + centerX, localBounds[1] + centerY,
            localBounds[2] + centerX, localBounds[3] + centerY
          ];
          const delta = Math.max(...outputBounds.map((v, i) => Math.abs(v - shape.bounds[i])));
          if (delta > 0.02) {
            stats.bboxMismatches++;
            if (bboxDetails.length < 25) bboxDetails.push({
              label: shape.sourceLabel,
              source: shape.bounds.map((v) => Number(v.toFixed(6))),
              output: outputBounds.map((v) => Number(v.toFixed(6))),
              maxDelta: Number(delta.toFixed(6))
            });
          }
        }
      }
    }

    stats.outputShapes = losslessShapes.length;
    stats.colorGroups = 0;
    stats.mergedShapes = 0;
    stats.missingShapes = Math.max(0, stats.drawableElements - stats.outputShapes);
    if (stats.missingShapes > 0) warnings.add(`${stats.missingShapes} drawable SVG tidak menjadi shape output; cek warnings/skippedUnsupported.`);
    if (stats.bboxMismatches > 0) warnings.add(`${stats.bboxMismatches} shape memiliki bbox output berbeda >0.02 px dari geometri SVG setelah transform.`);

    const layerXml = buildLosslessLayerXml(losslessShapes, width, height, options.duration, options.fps, options.precision);
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Lossless geometry mode. Native AM schema follows the supplied healthy XML reference. -->`,
      `<scene title="${xmlEscape(options.title)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${options.duration}" fps="${options.fps}" modifiedTime="${Date.now()}" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="freeze" retimeAdaptFPS="false">`,
      layerXml,
      `</scene>`
    ].join('\n');

    stats.outputBytes = Buffer.byteLength(scene, 'utf8');
    return {
      xml: scene,
      width,
      height,
      options: { ...options, maxShapes: 'unlimited' },
      stats,
      warnings: [...warnings],
      validation: {
        enabled: options.validateBounds,
        sourceDrawable: stats.drawableElements,
        emittedShapes: stats.outputShapes,
        missingShapes: stats.missingShapes,
        bboxMismatches: stats.bboxMismatches,
        details: bboxDetails
      },
      profile: {
        version: '1.5.0',
        quality: 'lossless',
        groupedByColor: false,
        preservesSourceOrder: true,
        strokesRemoved: false,
        nativeStroke: true,
        nodeReduction: 0,
        precision: 8,
        maxShapes: 'unlimited'
      },
      sourceFeatures
    };
  }

  // Gabungkan seluruh shape yang memiliki warna ARGB identik. Hasil akhirnya:
  // satu warna = satu embedScene = satu vector path gabungan.
  const colorMap = new Map();
  for (const shape of kept) {
    const key = String(shape.fillColor || '#ff000000').toLowerCase();
    if (!colorMap.has(key)) colorMap.set(key, { color: key, shapes: [], orders: [] });
    const group = colorMap.get(key);
    group.shapes.push(shape);
    group.orders.push(shape.sourceOrder);
  }

  const groups = [];
  for (const group of colorMap.values()) {
    const allBounds = group.shapes.map((shape) => shape.bounds).filter(Boolean);
    if (!allBounds.length) continue;
    const x1 = Math.min(...allBounds.map((b) => b[0]));
    const y1 = Math.min(...allBounds.map((b) => b[1]));
    const x2 = Math.max(...allBounds.map((b) => b[2]));
    const y2 = Math.max(...allBounds.map((b) => b[3]));
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const mergedScenePath = group.shapes.map((shape) => shape.scenePath).join('');
    const translated = svgpath(mergedScenePath).translate(-cx, -cy).abs().round(options.precision).toString();
    let localPath;
    try {
      localPath = reducePathNodes(translated, options.nodeReduction, options.precision);
    } catch {
      localPath = serializePathForAlight(translated, options.precision);
      warnings.add(`Node reduction gagal pada group ${group.color}; path asli dipertahankan.`);
    }
    const afterNodes = pathNodeCount(localPath);
    stats.nodesAfter += afterNodes;
    groups.push({
      color: group.color,
      cx, cy, localPath,
      sourceCount: group.shapes.length,
      zScore: group.orders.reduce((a, b) => a + b, 0) / Math.max(1, group.orders.length)
    });
  }
  groups.sort((a, b) => a.zScore - b.zScore);
  stats.colorGroups = groups.length;
  stats.outputShapes = groups.length;
  stats.mergedShapes = Math.max(0, kept.length - groups.length);
  if (stats.nodesBefore > 0 && stats.nodesAfter > stats.nodesBefore) {
    warnings.add('Node reduction menghasilkan node lebih banyak pada sebagian path; gunakan persentase lebih rendah jika bentuk terlihat terlalu halus.');
  }

  const shapeXml = groups.map((group, i) => buildColorGroupXml(
    group, i, width, height, options.duration, options.fps, options.precision
  )).join('\n');
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
    warnings: [...warnings],
    profile: {
      version: '1.5.0',
      quality: options.quality,
      groupedByColor: true,
      oneShapePerColor: true,
      strokesRemoved: true,
      nodeReduction: options.nodeReduction
    },
    sourceFeatures
  };
}

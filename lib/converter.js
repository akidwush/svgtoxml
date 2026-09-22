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
  const match = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)$/i);
  if (!match) return fallback;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return fallback;
  const unit = match[2].toLowerCase();
  // CSS absolute lengths use 96 px/in. Unitless SVG lengths are user units.
  const absoluteScale = {
    '': 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4,
    q: 96 / 101.6, pt: 96 / 72, pc: 16
  }[unit];
  return Number.isFinite(absoluteScale) ? n * absoluteScale : fallback;
}

function parseViewportLength(value, fallback = 0, percentBasis = NaN) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  if (text.endsWith('%')) {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) && Number.isFinite(percentBasis) ? (n / 100) * percentBasis : fallback;
  }
  return parseLength(text, fallback);
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
  const important = new Set();
  if (!text) return out;
  for (const part of String(text).split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const rawValue = part.slice(idx + 1).trim();
    const isImportant = /\s*!important\s*$/i.test(rawValue);
    const value = rawValue.replace(/\s*!important\s*$/i, '');
    if (key) {
      out[key] = value;
      if (isImportant) important.add(key);
    }
  }
  Object.defineProperty(out, '__important', { value: important, enumerable: false });
  return out;
}

function selectorSpecificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
  const stripped = selector
    .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, ' ');
  const tags = (stripped.match(/(?:^|[\s>+~])([a-z][\w-]*|\*)/gi) || [])
    .filter((token) => !token.trim().endsWith('*')).length;
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
        if (!selector) continue;
        let nodes = null;
        try {
          // Cheerio/css-select gives us the real static CSS selector subset used
          // by browsers: child/sibling combinators, attributes and structural
          // pseudo-classes. Invalid/dynamic selectors safely fall back below.
          nodes = new Set($(selector).toArray());
        } catch {}
        rules.push({
          selector, declarations, nodes,
          specificity: selectorSpecificity(selector), order: order++
        });
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
  // CSS custom properties inherit even though ordinary opacity/clip properties do not.
  for (const [key, value] of Object.entries(parentStyle || {})) {
    if (key.startsWith('--')) style[key] = value;
  }

  const presentationKeys = [
    ...INHERITED_STYLE_KEYS, 'display', 'opacity', 'clip-path', 'clip-rule', 'mask',
    'vector-effect', 'paint-order', 'filter', 'mix-blend-mode', 'isolation', 'overflow',
    'marker-start', 'marker-mid', 'marker-end',
    'stop-color', 'stop-opacity'
  ];
  for (const key of presentationKeys) {
    if (attrs[key] != null) style[key] = attrs[key];
  }

  const matched = cssRules.filter((r) => r.nodes ? r.nodes.has(node) : matchesSelector(node, r.selector))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of matched) {
    for (const [key, value] of Object.entries(rule.declarations)) {
      if (!rule.declarations.__important?.has(key)) style[key] = value;
    }
  }
  const inline = parseStyleDeclarations(attrs.style);
  for (const [key, value] of Object.entries(inline)) {
    if (!inline.__important?.has(key)) style[key] = value;
  }
  // !important declarations form a separate cascade origin. Inline important
  // remains strongest; stylesheet important rules still respect specificity.
  for (const rule of matched) {
    for (const key of rule.declarations.__important || []) style[key] = rule.declarations[key];
  }
  for (const key of inline.__important || []) style[key] = inline[key];

  const resolveVars = (input, stack = new Set()) => String(input ?? '').replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
    (_match, name, fallback = '') => {
      if (stack.has(name)) return fallback.trim();
      const next = style[name];
      if (next == null) return fallback.trim();
      const nextStack = new Set(stack); nextStack.add(name);
      return resolveVars(next, nextStack);
    }
  );
  for (const key of Object.keys(style)) style[key] = resolveVars(style[key]);

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
  // A standalone SVG width/height of 100% has no external CSS viewport here;
  // the viewBox is the only deterministic intrinsic size.
  let width = parseViewportLength(rootAttrs.width, NaN, NaN);
  let height = parseViewportLength(rootAttrs.height, NaN, NaN);
  if (!Number.isFinite(width) || width <= 0) width = viewBox?.[2] || 1080;
  if (!Number.isFinite(height) || height <= 0) height = viewBox?.[3] || 1080;
  width = clamp(Math.round(width), 1, 8192);
  height = clamp(Math.round(height), 1, 8192);
  const rootMatrix = viewBoxMatrix(viewBox, width, height, rootAttrs.preserveAspectRatio || rootAttrs.preserveaspectratio);
  const userViewport = viewBox
    ? { width: viewBox[2], height: viewBox[3] }
    : { width, height };
  return { width, height, rootMatrix, userViewport };
}

function matrixToTransform(m) {
  return `matrix(${m.map((n) => Number.isFinite(n) ? n : 0).join(' ')})`;
}

function nestedViewportTransform(attrs, override = null, parentViewport = null) {
  const x = parseViewportLength(attrs.x, 0, parentViewport?.width);
  const y = parseViewportLength(attrs.y, 0, parentViewport?.height);
  const viewBox = parseViewBox(attrs);
  if (!viewBox) return (x || y) ? `translate(${x} ${y})` : '';
  let width = override?.width;
  let height = override?.height;
  if (!Number.isFinite(width) || width <= 0) width = parseViewportLength(attrs.width, viewBox[2], parentViewport?.width);
  if (!Number.isFinite(height) || height <= 0) height = parseViewportLength(attrs.height, viewBox[3], parentViewport?.height);
  if (!Number.isFinite(width) || width <= 0) width = viewBox[2];
  if (!Number.isFinite(height) || height <= 0) height = viewBox[3];
  const m = viewBoxMatrix(viewBox, width, height, attrs.preserveAspectRatio || attrs.preserveaspectratio, x, y);
  return matrixToTransform(m);
}

function roundedRectPath(attrs, viewport = null) {
  const x = parseViewportLength(attrs.x, 0, viewport?.width);
  const y = parseViewportLength(attrs.y, 0, viewport?.height);
  const w = Math.max(0, parseViewportLength(attrs.width, 0, viewport?.width));
  const h = Math.max(0, parseViewportLength(attrs.height, 0, viewport?.height));
  if (w <= 0 || h <= 0) return null;
  let rx = Math.max(0, parseViewportLength(attrs.rx, 0, viewport?.width));
  let ry = Math.max(0, parseViewportLength(attrs.ry, rx, viewport?.height));
  if (attrs.rx == null && attrs.ry != null) rx = ry;
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (rx <= 0 && ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
  if (rx <= 0) rx = ry; if (ry <= 0) ry = rx;
  return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
}

function drawableToPath(tag, attrs, viewport = null) {
  const diagonal = viewport
    ? Math.hypot(viewport.width, viewport.height) / Math.SQRT2
    : NaN;
  switch (tag) {
    case 'path': return attrs.d?.trim() || null;
    case 'rect': return roundedRectPath(attrs, viewport);
    case 'circle': {
      const cx = parseViewportLength(attrs.cx, 0, viewport?.width);
      const cy = parseViewportLength(attrs.cy, 0, viewport?.height);
      const r = Math.max(0, parseViewportLength(attrs.r, 0, diagonal));
      if (!r) return null;
      return `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`;
    }
    case 'ellipse': {
      const cx = parseViewportLength(attrs.cx, 0, viewport?.width);
      const cy = parseViewportLength(attrs.cy, 0, viewport?.height);
      const rx = Math.max(0, parseViewportLength(attrs.rx, 0, viewport?.width));
      const ry = Math.max(0, parseViewportLength(attrs.ry, 0, viewport?.height));
      if (!rx || !ry) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line': {
      const x1 = parseViewportLength(attrs.x1, 0, viewport?.width);
      const y1 = parseViewportLength(attrs.y1, 0, viewport?.height);
      const x2 = parseViewportLength(attrs.x2, 0, viewport?.width);
      const y2 = parseViewportLength(attrs.y2, 0, viewport?.height);
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

function boundsOverlap(a, b, padding = 0) {
  if (!a || !b) return false;
  return !(
    a[2] + padding < b[0] ||
    b[2] + padding < a[0] ||
    a[3] + padding < b[1] ||
    b[3] + padding < a[1]
  );
}

function unionBounds(boundsList) {
  const list = boundsList.filter(Boolean);
  if (!list.length) return null;
  return [
    Math.min(...list.map((b) => b[0])),
    Math.min(...list.map((b) => b[1])),
    Math.max(...list.map((b) => b[2])),
    Math.max(...list.map((b) => b[3]))
  ];
}

function splitPathSubpaths(d) {
  const p = svgpath(d).abs().unshort().unarc();
  const subpaths = [];
  let current = [];
  p.iterate((seg) => {
    const cmd = String(seg[0] || '').toUpperCase();
    if (cmd === 'M' && current.length) {
      subpaths.push(segmentListToPath(current));
      current = [];
    }
    current.push(Array.from(seg));
    return undefined;
  });
  if (current.length) subpaths.push(segmentListToPath(current));
  return subpaths.filter(Boolean);
}

const PATCH_THIN_ASPECT_RATIO = 6;

function isProtectedThinDetail(width, height, protectLongDimension) {
  const longDimension = Math.max(width, height);
  const shortDimension = Math.min(width, height);
  if (!(longDimension >= protectLongDimension)) return false;
  if (shortDimension <= 1e-9) return true;
  return longDimension / shortDimension >= PATCH_THIN_ASPECT_RATIO;
}

function pruneMicroSubpaths(d, minArea = 0, protectLongDimension = Infinity, precision = 4) {
  if (!(minArea > 0)) {
    return { path: serializePathForAlight(d, precision), removed: 0, removedNodes: 0 };
  }
  let parts;
  try {
    parts = splitPathSubpaths(d);
  } catch {
    return { path: serializePathForAlight(d, precision), removed: 0, removedNodes: 0 };
  }
  if (parts.length <= 1) {
    const b = safeBounds(d);
    if (!b) return { path: serializePathForAlight(d, precision), removed: 0, removedNodes: 0 };
    const w = Math.max(0, b[2] - b[0]);
    const h = Math.max(0, b[3] - b[1]);
    const protectedThin = isProtectedThinDetail(w, h, protectLongDimension);
    if (w * h < minArea && !protectedThin) {
      return { path: '', removed: 1, removedNodes: pathNodeCount(d) };
    }
    return { path: serializePathForAlight(d, precision), removed: 0, removedNodes: 0 };
  }

  const kept = [];
  let removed = 0;
  let removedNodes = 0;
  for (const part of parts) {
    const b = safeBounds(part);
    if (!b) {
      kept.push(part);
      continue;
    }
    const w = Math.max(0, b[2] - b[0]);
    const h = Math.max(0, b[3] - b[1]);
    const area = w * h;
    const protectedThin = isProtectedThinDetail(w, h, protectLongDimension);
    const isMicro = area < minArea && !protectedThin;
    if (isMicro) {
      removed++;
      removedNodes += pathNodeCount(part);
    } else {
      kept.push(part);
    }
  }
  return {
    path: kept.map((part) => serializePathForAlight(part, precision)).join(''),
    removed,
    removedNodes
  };
}

function isOpaqueArgb(color) {
  if (!color) return true;
  const h = String(color).replace('#', '').toLowerCase();
  return h.length !== 8 || h.startsWith('ff');
}

function optimizedStyleKey(shape) {
  // Separate translucent shapes: merging them would collapse alpha stacking in
  // overlap regions even when the visible color/style is otherwise identical.
  if (shape.gradient || !isOpaqueArgb(shape.fillColor) || !isOpaqueArgb(shape.strokeColor)) {
    return `isolated:${shape.sourceOrder}`;
  }
  return [
    String(shape.fillColor || 'none').toLowerCase(),
    String(shape.strokeColor || 'none').toLowerCase(),
    Number(shape.strokeWidth || 0).toFixed(4),
    String(shape.strokeJoin || 'miter').toLowerCase(),
    String(shape.fillRule || 'nonzero').toLowerCase()
  ].join('|');
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

function localIriRef(value) {
  const m = String(value || '').match(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/i);
  return m ? m[1] : null;
}

function transformIsUniformOrthogonal(transformChain, rootMatrix, tolerance = 1e-6) {
  const p0 = pointViaTransforms(0, 0, transformChain, rootMatrix);
  const px = pointViaTransforms(1, 0, transformChain, rootMatrix);
  const py = pointViaTransforms(0, 1, transformChain, rootMatrix);
  const ux = [px[0] - p0[0], px[1] - p0[1]];
  const uy = [py[0] - p0[0], py[1] - p0[1]];
  const sx = Math.hypot(...ux), sy = Math.hypot(...uy);
  if (!(sx > 0 && sy > 0)) return false;
  const scaleDelta = Math.abs(sx - sy) / Math.max(sx, sy);
  const cosine = Math.abs((ux[0] * uy[0] + ux[1] * uy[1]) / (sx * sy));
  return scaleDelta <= tolerance && cosine <= tolerance;
}

const gradientRef = localIriRef;

function paintFallback(value) {
  const raw = String(value || '').trim();
  const withoutUrl = raw.replace(/url\(\s*['"]?#[^)'"\s]+['"]?\s*\)/i, '').trim();
  return withoutUrl || null;
}

function collectClipPathNodes($) {
  const nodes = new Map();
  $('clipPath').each((_, node) => {
    const id = node.attribs?.id;
    if (id) nodes.set(id, node);
  });
  return nodes;
}

function clipPathForShape({
  clipNode, idNodes, localBounds, targetTransforms, rootMatrix,
  viewport, precision, cssRules
}) {
  if (!clipNode || !localBounds) return null;
  const attrs = clipNode.attribs || {};
  const units = String(attrs.clipPathUnits || attrs.clippathunits || 'userSpaceOnUse').toLowerCase();
  let baseTransforms = [...targetTransforms];
  if (units === 'objectboundingbox') {
    const [x1, y1, x2, y2] = localBounds;
    const bw = x2 - x1, bh = y2 - y1;
    if (!(bw > 0 && bh > 0)) return null;
    baseTransforms.push(`matrix(${bw} 0 0 ${bh} ${x1} ${y1})`);
  } else if (units !== 'userspaceonuse') {
    return null;
  }
  if (attrs.transform) baseTransforms.push(attrs.transform);

  const parts = [];
  const visit = (node, transforms, useStack = new Set()) => {
    if (!node || node.type !== 'tag') return;
    const tag = String(node.name || '').toLowerCase();
    const nodeAttrs = node.attribs || {};
    const nextTransforms = nodeAttrs.transform ? [...transforms, nodeAttrs.transform] : transforms;
    if (tag === 'use') {
      const ref = localIriRef(nodeAttrs.href || nodeAttrs['xlink:href']) ||
        String(nodeAttrs.href || nodeAttrs['xlink:href'] || '').replace(/^#/, '');
      if (!ref || useStack.has(ref) || !idNodes.has(ref)) return;
      const useTransforms = [...nextTransforms];
      const x = parseViewportLength(nodeAttrs.x, 0, viewport?.width);
      const y = parseViewportLength(nodeAttrs.y, 0, viewport?.height);
      if (x || y) useTransforms.push(`translate(${x} ${y})`);
      const stack = new Set(useStack); stack.add(ref);
      visit(idNodes.get(ref), useTransforms, stack);
      return;
    }
    if (DRAWABLE_TAGS.has(tag)) {
      const style = computedStyle(node, DEFAULT_STYLE, cssRules);
      if (String(style.display || '').toLowerCase() === 'none' ||
          ['hidden', 'collapse'].includes(String(style.visibility || '').toLowerCase())) return;
      const d = drawableToPath(tag, nodeAttrs, units === 'objectboundingbox' ? { width: 1, height: 1 } : viewport);
      if (!d) return;
      let path = normalizePathForAlight(d, nextTransforms, rootMatrix, precision);
      const rule = String(style['clip-rule'] || style['fill-rule'] || 'nonzero').toLowerCase();
      if (rule === 'evenodd') path = normalizeEvenOddToNonZero(path).path;
      parts.push(path);
      return;
    }
    for (const child of node.children || []) visit(child, nextTransforms, useStack);
  };
  for (const child of clipNode.children || []) visit(child, baseTransforms);
  if (!parts.length) return null;
  return serializePathForAlight(parts.join(''), precision);
}

function stopInfo($, stopNode, cssRules) {
  const attrs = stopNode.attribs || {};
  const ancestors = [];
  let cursor = stopNode.parent;
  while (cursor?.type === 'tag') {
    ancestors.push(cursor);
    cursor = cursor.parent;
  }
  let inherited = DEFAULT_STYLE;
  for (const ancestor of ancestors.reverse()) inherited = computedStyle(ancestor, inherited, cssRules);
  const style = computedStyle(stopNode, inherited, cssRules);
  return {
    offset: clamp(parseUnitValue(attrs.offset ?? style.offset, 0), 0, 1),
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

function resolveGradient($, gradientNodes, id, cssRules, stack = new Set()) {
  if (!id || stack.has(id)) return null;
  const node = gradientNodes.get(id);
  if (!node) return null;
  stack.add(id);
  const attrs = { ...(node.attribs || {}) };
  const href = attrs.href || attrs['xlink:href'];
  let base = null;
  if (href?.startsWith('#')) base = resolveGradient($, gradientNodes, href.slice(1), cssRules, stack);

  const ownStops = $(node).children('stop').toArray().map((s) => stopInfo($, s, cssRules));
  const stops = (ownStops.length ? ownStops : base?.stops || []).sort((a, b) => a.offset - b.offset);
  return {
    type: String(node.name).toLowerCase() === 'radialgradient' ? 'radial' : 'linear',
    attrs: { ...(base?.attrs || {}), ...attrs },
    stops
  };
}

function gradientForShape({ $, gradientNodes, id, cssRules, localBounds, finalBounds, transformChain, rootMatrix, fillOpacity, currentColor }) {
  const gradient = resolveGradient($, gradientNodes, id, cssRules);
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


function buildOptimizedGroupXml(group, index, width, height, duration, fps, precision) {
  const groupId = 410000001 + index;
  const shapeId = 420000001 + index;
  const label = group.gradient
    ? `Optimized ${String(index + 1).padStart(3, '0')} · Gradient`
    : colorLabel(group.fillColor || group.strokeColor || '#ff000000', index);
  const fillType = group.gradient ? 'gradient' : (group.fillColor ? 'color' : 'none');
  const baseColor = group.gradient?.startColor || group.fillColor || group.strokeColor || '#00000000';
  const lines = [
    `  <embedScene id="${groupId}" label="${xmlEscape(label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    '    </transform>',
    `    <fillColor value="${baseColor}" />`,
    `    <scene title="${xmlEscape(label)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    `      <shape id="${shapeId}" label="${xmlEscape(label)} · Path" startTime="0" endTime="${duration}" fillType="${fillType}" mediaFillMode="fill">`,
    '        <transform>',
    `          <location value="${fmt(group.cx)},${fmt(group.cy)},0.000000" />`,
    '          <scale value="1.000000,1.000000" />',
    '        </transform>',
    `        <fillColor value="${baseColor}" />`
  ];
  if (group.gradient) {
    const g = group.gradient;
    lines.push(`        <gradient type="${g.type}" startColor="${g.startColor}" endColor="${g.endColor}" start="${fmt(g.start[0], precision)},${fmt(g.start[1], precision)}" end="${fmt(g.end[0], precision)},${fmt(g.end[1], precision)}" />`);
  }
  if (group.strokeColor && group.strokeWidth > 0) {
    const join = ['round', 'bevel', 'miter'].includes(group.strokeJoin) ? group.strokeJoin : 'miter';
    lines.push('        <path-stroke direction="centered" join="' + join + '" end-size="1.500000">');
    lines.push(`          <color value="${group.strokeColor}" />`);
    lines.push(`          <size value="${fmt(group.strokeWidth, precision)}" />`);
    lines.push('        </path-stroke>');
  }
  lines.push(`        <path d="${xmlEscape(group.localPath)}" />`);
  lines.push('      </shape>');
  lines.push('    </scene>');
  lines.push('  </embedScene>');
  return lines.join('\n');
}

function sourceLabel(shape, index) {
  const raw = String(shape.sourceLabel || '').trim();
  return (raw || `Vector ${String(index + 1).padStart(3, '0')}`).slice(0, 96);
}

function buildPrimitiveShapeXml(shape, index, duration, precision, config = {}) {
  const id = config.id ?? (370000001 + index);
  const indent = config.indent || '      ';
  const child = `${indent}  `;
  const bounds = Array.isArray(shape.bounds) ? shape.bounds : null;
  if (!bounds || bounds.length !== 4) return '';
  const width = Math.max(0, bounds[2] - bounds[0]);
  const height = Math.max(0, bounds[3] - bounds[1]);
  if (!(width > 0 && height > 0)) return '';
  const cx = (bounds[0] + bounds[2]) / 2;
  const cy = (bounds[1] + bounds[3]) / 2;
  const primitive = shape.primitiveKind === 'rect' ? '.rect' : '.circle';
  const fillColor = shape.fillColor || '#00000000';
  const lines = [];
  lines.push(`${indent}<shape id="${id}" label="${xmlEscape(config.label || sourceLabel(shape, index))}" startTime="0" endTime="${duration}" fillType="color" s="${primitive}" mediaFillMode="fill">`);
  lines.push(`${child}<transform>`);
  lines.push(`${child}  <location value="${fmt(cx)},${fmt(cy)},0.000000" />`);
  if (primitive === '.circle') {
    lines.push(`${child}  <scale value="${fmt(width / 100, precision)},${fmt(height / 100, precision)}" />`);
  }
  if (shape.layerOpacity != null && shape.layerOpacity < 1) {
    lines.push(`${child}  <opacity value="${fmt(shape.layerOpacity, precision)}" />`);
  }
  lines.push(`${child}</transform>`);
  lines.push(`${child}<fillColor value="${fillColor}" />`);
  if (primitive === '.rect') {
    lines.push(`${child}<property name="size" type="vec2" value="${fmt(width, precision)},${fmt(height, precision)}" />`);
  }
  lines.push(`${indent}</shape>`);
  return lines.join('\n');
}

function buildLosslessShapeXml(shape, index, duration, precision, width, height, config = {}) {
  const id = config.id ?? (310000001 + index);
  const indent = config.indent || '      ';
  const child = `${indent}  `;
  const lines = [];
  const fillType = shape.gradient ? 'gradient' : (shape.fillColor ? 'color' : 'none');
  const fillColor = shape.gradient?.startColor || shape.fillColor || shape.strokeColor || '#00000000';
  const blending = config.blending ? ` blending="${xmlEscape(config.blending)}"` : '';
  lines.push(`${indent}<shape id="${id}" label="${xmlEscape(config.label || sourceLabel(shape, index))}" startTime="0" endTime="${duration}" fillType="${fillType}"${blending} mediaFillMode="fill">`);
  lines.push(`${child}<transform>`);
  // Healthy AM XML keeps imported SVG vectors around the scene center and stores
  // path coordinates relative to that center. Follow that proven structure.
  lines.push(`${child}  <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`);
  if (shape.layerOpacity != null && shape.layerOpacity < 1) {
    lines.push(`${child}  <opacity value="${fmt(shape.layerOpacity, precision)}" />`);
  }
  lines.push(`${child}</transform>`);
  lines.push(`${child}<fillColor value="${fillColor}" />`);
  if (shape.gradient) {
    const g = shape.gradient;
    lines.push(`${child}<gradient type="${g.type}" startColor="${g.startColor}" endColor="${g.endColor}" start="${fmt(g.start[0], precision)},${fmt(g.start[1], precision)}" end="${fmt(g.end[0], precision)},${fmt(g.end[1], precision)}" />`);
  }
  if (shape.strokeColor && shape.strokeWidth > 0) {
    const join = ['round', 'bevel', 'miter'].includes(shape.strokeJoin) ? shape.strokeJoin : 'miter';
    lines.push(`${child}<path-stroke direction="centered" join="${join}" end-size="1.500000">`);
    lines.push(`${child}  <color value="${shape.strokeColor}" />`);
    lines.push(`${child}  <size value="${fmt(shape.strokeWidth, precision)}" />`);
    lines.push(`${child}</path-stroke>`);
  }
  lines.push(`${child}<path d="${xmlEscape(shape.localPath)}" />`);
  lines.push(`${indent}</shape>`);
  return lines.join('\n');
}

function buildClippedLosslessShapeXml(shape, index, duration, precision, width, height, fps) {
  const groupId = 320000001 + index;
  const content = buildLosslessShapeXml(shape, index, duration, precision, width, height, {
    id: 330000001 + index,
    indent: '          '
  });
  const masks = shape.localClipPaths.map((path, maskIndex) => buildLosslessShapeXml({
    sourceLabel: `${sourceLabel(shape, index)} · Clip ${maskIndex + 1}`,
    localPath: path,
    fillColor: '#ffffffff',
    gradient: null,
    strokeColor: null,
    strokeWidth: 0
  }, index, duration, precision, width, height, {
    id: 350000001 + index * 100 + maskIndex,
    indent: '          ',
    blending: 'mask'
  })).join('\n');
  const label = `${sourceLabel(shape, index)} · SVG clipPath`;
  return [
    `      <embedScene id="${groupId}" label="${xmlEscape(label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '        <transform>',
    `          <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    '        </transform>',
    '        <fillColor value="#ff000000" />',
    `        <scene title="" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    content,
    masks,
    '        </scene>',
    '      </embedScene>'
  ].join('\n');
}

function shiftLosslessXml(xml, depth) {
  const prefix = '    '.repeat(Math.max(0, depth));
  return prefix ? String(xml).split('\n').map((line) => `${prefix}${line}`).join('\n') : xml;
}

function buildLosslessTree(shapes) {
  const root = { children: [] };
  const groups = new Map();
  shapes.forEach((shape, index) => {
    let parent = root;
    for (const descriptor of shape.groupPath || []) {
      let group = groups.get(descriptor.token);
      if (!group) {
        group = { type: 'group', descriptor, children: [] };
        groups.set(descriptor.token, group);
        parent.children.push(group);
      }
      parent = group;
    }
    parent.children.push({ type: 'shape', shape, index });
  });
  return root;
}

function buildLosslessTreeXml(entries, depth, width, height, duration, fps, precision) {
  return entries.map((entry) => {
    if (entry.type === 'shape') {
      const xml = entry.shape.localClipPaths?.length
        ? buildClippedLosslessShapeXml(entry.shape, entry.index, duration, precision, width, height, fps)
        : (entry.shape.primitiveKind
          ? buildPrimitiveShapeXml(entry.shape, entry.index, duration, precision)
          : buildLosslessShapeXml(entry.shape, entry.index, duration, precision, width, height));
      return shiftLosslessXml(xml, depth);
    }
    const descriptor = entry.descriptor;
    const inner = buildLosslessTreeXml(entry.children, depth + 1, width, height, duration, fps, precision);
    const base = [
      `      <embedScene id="${360000001 + descriptor.token}" label="${xmlEscape(descriptor.label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
      '        <transform>',
      `          <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
      `          <opacity value="${fmt(descriptor.opacity, precision)}" />`,
      '        </transform>',
      '        <fillColor value="#ff000000" />',
      `        <scene title="" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
      inner,
      '        </scene>',
      '      </embedScene>'
    ].join('\n');
    return shiftLosslessXml(base, depth);
  }).join('\n');
}

function buildLosslessLayerXml(shapes, width, height, duration, fps, precision, rootOpacity = 1) {
  const tree = buildLosslessTree(shapes);
  const inner = buildLosslessTreeXml(tree.children, 0, width, height, duration, fps, precision);
  return [
    `  <embedScene id="300000001" label="SVG Lossless Layer" startTime="0" endTime="${duration}" fillType="intrinsic" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    ...(rootOpacity < 1 ? [`      <opacity value="${fmt(rootOpacity, precision)}" />`] : []),
    '    </transform>',
    '    <fillColor value="#ff000000" />',
    `    <scene title="" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    inner,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}

function boundsOverlapPositive(a, b, epsilon = 1e-9) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  const overlapWidth = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const overlapHeight = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return overlapWidth > epsilon && overlapHeight > epsilon;
}

function orderColorUnits(units, sourceRecords) {
  const edges = new Map(units.map((unit) => [unit.key, new Set()]));
  let overlapConstraints = 0;

  for (let i = 0; i < sourceRecords.length; i++) {
    const a = sourceRecords[i];
    if (!edges.has(a.unitKey)) continue;
    for (let j = i + 1; j < sourceRecords.length; j++) {
      const b = sourceRecords[j];
      if (a.unitKey === b.unitKey || !edges.has(b.unitKey)) continue;
      if (!boundsOverlapPositive(a.bounds, b.bounds)) continue;
      const targets = edges.get(a.unitKey);
      if (!targets.has(b.unitKey)) {
        targets.add(b.unitKey);
        overlapConstraints++;
      }
    }
  }

  let zOrderConflicts = 0;
  for (const [from, targets] of edges) {
    for (const to of targets) {
      if (String(from) < String(to) && edges.get(to)?.has(from)) zOrderConflicts++;
    }
  }

  if (zOrderConflicts > 0) {
    return {
      ordered: [...units].sort((a, b) =>
        (a.lastOrder ?? a.firstOrder ?? 0) - (b.lastOrder ?? b.firstOrder ?? 0) ||
        (a.firstOrder ?? 0) - (b.firstOrder ?? 0)
      ),
      overlapConstraints,
      zOrderConflicts,
      topological: false
    };
  }

  const indegree = new Map(units.map((unit) => [unit.key, 0]));
  for (const targets of edges.values()) {
    for (const to of targets) indegree.set(to, (indegree.get(to) || 0) + 1);
  }

  const unitByKey = new Map(units.map((unit) => [unit.key, unit]));
  const queue = units
    .filter((unit) => (indegree.get(unit.key) || 0) === 0)
    .sort((a, b) => (a.firstOrder ?? 0) - (b.firstOrder ?? 0));
  const ordered = [];

  while (queue.length) {
    const unit = queue.shift();
    ordered.push(unit);
    for (const to of edges.get(unit.key) || []) {
      const next = (indegree.get(to) || 0) - 1;
      indegree.set(to, next);
      if (next === 0) {
        queue.push(unitByKey.get(to));
        queue.sort((a, b) => (a.firstOrder ?? 0) - (b.firstOrder ?? 0));
      }
    }
  }

  if (ordered.length !== units.length) {
    return {
      ordered: [...units].sort((a, b) =>
        (a.lastOrder ?? a.firstOrder ?? 0) - (b.lastOrder ?? b.firstOrder ?? 0)
      ),
      overlapConstraints,
      zOrderConflicts: Math.max(1, zOrderConflicts),
      topological: false
    };
  }

  return { ordered, overlapConstraints, zOrderConflicts: 0, topological: true };
}

function buildColorLayerXml(group, index, width, height, duration, fps, precision) {
  const label = colorLabel(group.fillColor, index);
  const inner = group.shapes.map((shape) => buildLosslessShapeXml(
    shape,
    shape.sourceOrder,
    duration,
    precision,
    width,
    height,
    {
      id: 500000001 + shape.sourceOrder,
      indent: '          ',
      label: sourceLabel(shape, shape.sourceOrder)
    }
  )).join('\n');

  return [
    `      <embedScene id="${440000001 + index}" label="${xmlEscape(label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '        <transform>',
    `          <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    '        </transform>',
    `        <fillColor value="${group.fillColor}" />`,
    `        <scene title="${xmlEscape(label)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    inner,
    '        </scene>',
    '      </embedScene>'
  ].join('\n');
}

function buildColorGroupsLayerXml(units, width, height, duration, fps, precision, rootOpacity = 1) {
  let colorIndex = 0;
  let fallbackIndex = 0;
  const inner = units.map((unit) => {
    if (unit.kind === 'color') {
      return buildColorLayerXml(unit.group, colorIndex++, width, height, duration, fps, precision);
    }
    const shape = unit.shape;
    const index = fallbackIndex++;
    return shape.localClipPaths?.length
      ? buildClippedLosslessShapeXml(shape, index, duration, precision, width, height, fps)
      : buildLosslessShapeXml(shape, index, duration, precision, width, height, {
        id: 610000001 + index,
        indent: '      '
      });
  }).join('\n');

  return [
    `  <embedScene id="300000001" label="SVG Color Groups" startTime="0" endTime="${duration}" fillType="intrinsic" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    ...(rootOpacity < 1 ? [`      <opacity value="${fmt(rootOpacity, precision)}" />`] : []),
    '    </transform>',
    '    <fillColor value="#ff000000" />',
    `    <scene title="" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" precompose="dynamicResolution" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="0" amver="1028425" ffver="106" am="com.alightcreative.motion/5.0.273.1028425" amplatform="android" retime="off" retimeAdaptFPS="false">`,
    inner,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}

const QUALITY_PRESETS = {
  lossless: { minAreaPercent: 0, maxShapes: Infinity, precision: 8, nodeReduction: 0 },
  'color-group': { minAreaPercent: 0, maxShapes: Infinity, precision: 8, nodeReduction: 0 },
  'patch-clean': { minAreaPercent: 0, maxShapes: Infinity, precision: 8, nodeReduction: 0, patchAreaPercent: 0.01, protectThinPercent: 2.0 }
};

function resolveQualityOptions(rawOptions = {}) {
  const requested = String(rawOptions.quality || rawOptions.engine || 'lossless').toLowerCase();
  const aliases = {
    lossless: 'lossless',
    'maximum-fidelity': 'lossless',
    maximum: 'lossless',
    'color-group': 'color-group',
    'color-groups': 'color-group',
    'group-by-color': 'color-group',
    'color-fidelity': 'color-group',
    'patch-clean': 'patch-clean',
    'small-patch': 'patch-clean',
    'small-patch-cleanup': 'patch-clean'
  };
  const quality = aliases[requested] || 'lossless';
  const duration = clamp(Math.round(finiteNumber(rawOptions.duration, 1000)), 100, 600000);
  const fps = clamp(Math.round(finiteNumber(rawOptions.fps, 30)), 1, 240);
  const title = sanitizeTitle(rawOptions.title || 'SVG to Alight Motion');
  const groupingMode = String(rawOptions.groupingMode || rawOptions.grouping || 'nested').toLowerCase() === 'flat' ? 'flat' : 'nested';
  const detectPrimitives = rawOptions.detectPrimitives === true;

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
      requireExact: rawOptions.requireExact === true,
      groupingMode,
      detectPrimitives,
      duration,
      fps,
      title
    };
  }

  if (quality === 'color-group') {
    return {
      quality,
      minAreaPercent: 0,
      maxShapes: Infinity,
      precision: 8,
      geometryPrecision: 12,
      nodeReduction: 0,
      groupByColor: true,
      removeStrokes: false,
      validateBounds: false,
      requireExact: false,
      groupingMode: 'flat',
      detectPrimitives: false,
      duration,
      fps,
      title
    };
  }

  const preset = QUALITY_PRESETS['patch-clean'];
  return {
    quality: 'patch-clean',
    minAreaPercent: 0,
    maxShapes: Infinity,
    precision: 8,
    geometryPrecision: 12,
    nodeReduction: 0,
    groupByColor: false,
    removeStrokes: false,
    validateBounds: false,
    requireExact: false,
    patchAreaPercent: clamp(
      finiteNumber(rawOptions.patchAreaPercent ?? rawOptions.microDetailPercent, preset.patchAreaPercent),
      0,
      0.25
    ),
    protectThinPercent: clamp(
      finiteNumber(rawOptions.protectThinPercent, preset.protectThinPercent),
      0,
      100
    ),
    groupingMode,
    detectPrimitives,
    duration,
    fps,
    title
  };
}

function buildFidelityReport(stats, sourceFeatures, quality) {
  const losses = [];
  const add = (code, count, message) => {
    if (count > 0) losses.push({ code, count, message });
  };
  add('skipped-elements', stats.skippedUnsupported, 'Elemen/path tidak didukung atau gagal diproses.');
  add('unresolved-use', stats.unresolvedUses, 'Referensi <use> tidak dapat di-resolve.');
  add('missing-shapes', stats.missingShapes, 'Drawable sumber tidak menjadi layer output.');
  add('bbox-mismatch', stats.bboxMismatches, 'Bounding box output menyimpang dari geometri sumber.');
  add('gradient-flattened', stats.gradientsFlattened, 'Gradient diratakan menjadi warna solid.');
  add('gradient-stops', stats.gradientStopsReduced, 'Gradient multi-stop dipangkas menjadi dua warna.');
  add('clip-path', stats.clipPathsUnsupported, 'clipPath tidak diterapkan.');
  add('svg-mask', stats.masksUnsupported, 'Mask luminance/alpha SVG tidak diterapkan.');
  add('filter', Math.max(stats.filtersUnsupported, sourceFeatures.filters), 'Filter SVG tidak diterapkan.');
  add('pattern', Math.max(stats.patternsUnsupported, sourceFeatures.patterns), 'Pattern fill tidak diterapkan.');
  add('marker', Math.max(stats.markersUnsupported, sourceFeatures.markers), 'Marker/arrowhead tidak diterapkan.');
  add('stroke-dash', stats.strokeDashesUnsupported, 'Stroke dash menjadi solid.');
  add('stroke-cap', stats.strokeCapsUnsupported, 'Stroke line-cap tidak dapat dijamin sama.');
  add('group-opacity', stats.groupOpacityFlattened, 'Opacity group diratakan ke masing-masing child.');
  add('blend-mode', stats.blendModesUnsupported, 'CSS mix-blend-mode tidak diterapkan.');
  add('gradient-stroke', stats.gradientStrokesUnsupported, 'Gradient pada stroke tidak diterapkan.');
  add('nonuniform-stroke', stats.nonUniformStrokeTransforms, 'Stroke di bawah skew/non-uniform transform tidak dapat dipertahankan eksak.');
  add('miter-limit', stats.strokeMiterLimitsUnsupported, 'Stroke miter-limit non-default tidak diterapkan.');
  add('paint-order', stats.paintOrderUnsupported, 'Urutan paint fill/stroke non-default tidak diterapkan.');
  add('gradient-spread', stats.gradientSpreadUnsupported, 'Gradient repeat/reflect tidak diterapkan.');
  add('radial-focus', stats.radialGradientFocusUnsupported, 'Focal point radial gradient tidak diterapkan.');
  add('svg-animation', sourceFeatures.animations, 'Animasi SMIL SVG tidak dikonversi.');
  add('text', sourceFeatures.text, 'Text SVG tidak dikonversi menjadi outline vector.');
  add('image', sourceFeatures.images, 'Bitmap <image> tidak disematkan ke project XML.');
  if (quality === 'color-group') {
    add(
      'color-group-zorder',
      stats.zOrderBarriers,
      'Ada konflik overlap lintas warna yang tidak dapat mempertahankan seluruh z-order sumber sambil tetap memakai satu layer per warna.'
    );
  }
  if (quality === 'patch-clean') {
    add(
      'small-patch-cleanup',
      stats.microSubpathsRemoved + stats.removedMicroShapes,
      'Small Patch Cleanup sengaja membuang island/subpath yang berada di bawah ambang patch kecil.'
    );
  }
  return {
    exact: losses.length === 0,
    status: losses.length === 0 ? 'exact' : 'degraded',
    appliedClipPaths: stats.clipPathsApplied,
    losses
  };
}

export function convertSvgToAlightXml(svgInput, rawOptions = {}) {
  if (typeof svgInput !== 'string' || !svgInput.trim()) throw new Error('SVG kosong.');
  if (!/<svg\b/i.test(svgInput)) throw new Error('Input bukan dokumen SVG yang valid.');

  const options = resolveQualityOptions(rawOptions);
  const preserveFidelity = ['lossless', 'color-group', 'patch-clean'].includes(options.quality);
  const preserveHierarchy = (options.quality === 'lossless' || options.quality === 'patch-clean') &&
    options.groupingMode === 'nested';

  const $ = load(svgInput, { xml: { xmlMode: true, decodeEntities: false } });
  const root = $('svg').first();
  if (!root.length) throw new Error('Elemen <svg> tidak ditemukan.');
  const rootNode = root.get(0);
  const rootAttrs = rootNode.attribs || {};
  const { width, height, rootMatrix, userViewport } = rootGeometry(rootAttrs);
  const sceneArea = width * height;
  const minArea = sceneArea * (options.minAreaPercent / 100);
  const cssRules = parseCssRules($);
  const gradientNodes = collectGradientNodes($);
  const clipPathNodes = collectClipPathNodes($);
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
    nodeReductionReducedShapes: 0,
    nodeReductionUnchangedShapes: 0,
    nodeReductionFallbackShapes: 0,
    microSubpathsRemoved: 0,
    microNodesRemoved: 0,
    removedMicroShapes: 0,
    safeColorMerges: 0,
    zOrderBarriers: 0,
    optimizedGroupsDropped: 0,
    optimizedGroupsBeforeCap: 0,
    skippedUnsupported: 0,
    unresolvedUses: 0,
    gradientStopsReduced: 0,
    clipOrMaskWarnings: 0,
    clipPathsApplied: 0,
    clipPathsUnsupported: 0,
    masksUnsupported: 0,
    filtersUnsupported: 0,
    patternsUnsupported: 0,
    markersUnsupported: 0,
    strokeDashesUnsupported: 0,
    strokeCapsUnsupported: 0,
    groupOpacityFlattened: 0,
    groupOpacityPreserved: 0,
    blendModesUnsupported: 0,
    gradientStrokesUnsupported: 0,
    nonUniformStrokeTransforms: 0,
    strokeMiterLimitsUnsupported: 0,
    paintOrderUnsupported: 0,
    gradientSpreadUnsupported: 0,
    radialGradientFocusUnsupported: 0,
    evenOddNormalized: 0,
    bboxMismatches: 0,
    missingShapes: 0,
    nestedViewports: 0,
    primitiveCandidates: 0,
    primitiveOutput: 0,
    primitiveFallback: 0,
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
    patterns: $('pattern').length,
    markers: $('marker').length,
    animations: $('animate, animateTransform, animateMotion, set').length,
    text: $('text').length,
    images: $('image').length
  };
  if (sourceFeatures.filters) warnings.add('SVG memakai filter; filter kompleks tidak selalu tersedia sebagai padanan XML Alight Motion.');
  if (sourceFeatures.patterns) warnings.add('SVG memakai pattern fill; pattern vector belum memiliki mapping native yang tervalidasi.');
  if (sourceFeatures.markers) warnings.add('SVG memakai marker; arrowhead/marker belum dikonversi menjadi path terpisah.');
  if (sourceFeatures.animations) warnings.add('SVG memakai animasi SMIL; timeline animasi SVG belum dikonversi ke keyframe Alight Motion.');
  if (sourceFeatures.text) warnings.add('SVG masih memiliki <text>; ubah text menjadi path untuk fidelity terbaik.');
  if (sourceFeatures.images) warnings.add('SVG memiliki <image>; elemen raster di dalam SVG tidak dikonversi menjadi vector layer.');
  const candidates = [];
  let sourceOrder = 0;
  let opacityGroupToken = 0;

  const walk = (node, context, useStack = new Set()) => {
    if (!node || node.type !== 'tag') return;
    const tag = String(node.name || '').toLowerCase();
    const attrs = node.attribs || {};
    const style = computedStyle(node, context.style, cssRules);
    if (String(style.display || '').toLowerCase() === 'none' || ['hidden', 'collapse'].includes(String(style.visibility || '').toLowerCase())) return;

    const ownOpacity = parseOpacity(style.opacity, 1);
    const cumulativeOpacity = preserveHierarchy
      ? context.opacity
      : context.opacity * ownOpacity;
    if (cumulativeOpacity <= 0 || ownOpacity <= 0) return;
    const groupDescriptor = (label, opacity = ownOpacity, suffix = '') => ({
      token: opacityGroupToken++,
      label: `${String(label || 'SVG Group').slice(0, 72)}${suffix}`,
      opacity
    });
    const transforms = attrs.transform ? [...context.transforms, attrs.transform] : context.transforms;
    const ownClipId = localIriRef(style['clip-path']);
    const activeClipIds = ownClipId
      ? [...(context.clipIds || []), ownClipId]
      : (context.clipIds || []);
    const ownMaskId = localIriRef(style.mask);
    const activeMaskIds = ownMaskId
      ? [...(context.maskIds || []), ownMaskId]
      : (context.maskIds || []);

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
      const x = parseViewportLength(attrs.x, 0, context.viewport?.width);
      const y = parseViewportLength(attrs.y, 0, context.viewport?.height);
      if (x || y) useTransforms.push(`translate(${x} ${y})`);
      const nextStack = new Set(useStack); nextStack.add(id);
      const useWidth = parseViewportLength(attrs.width, NaN, context.viewport?.width);
      const useHeight = parseViewportLength(attrs.height, NaN, context.viewport?.height);
      const useGroupPath = preserveHierarchy && ownOpacity < 1
        ? [...(context.groupPath || []), groupDescriptor(attrs.id || id || 'SVG Use', ownOpacity, ' · Opacity')]
        : (context.groupPath || []);
      if (preserveHierarchy && ownOpacity < 1) stats.groupOpacityPreserved++;
      walk(idNodes.get(id), {
        style, opacity: cumulativeOpacity, transforms: useTransforms,
        viewportOverride: { width: useWidth, height: useHeight },
        viewport: context.viewport,
        clipIds: activeClipIds,
        maskIds: activeMaskIds,
        groupPath: useGroupPath
      }, nextStack);
      return;
    }

    if (SKIP_TAGS.has(tag)) return;

    if (CONTAINER_TAGS.has(tag)) {
      let containerTransforms = transforms;
      let childViewport = context.viewport;
      if (node !== rootNode && ownOpacity < 1) {
        if (preserveHierarchy) stats.groupOpacityPreserved++;
        else {
          stats.groupOpacityFlattened++;
          warnings.add('Opacity pada group SVG diratakan ke child layer karena mode Flat; area overlap dapat sedikit berbeda dari compositing group SVG.');
        }
      }
      if ((tag === 'svg' || tag === 'symbol') && node !== rootNode) {
        const viewportTransform = nestedViewportTransform(attrs, context.viewportOverride, context.viewport);
        if (viewportTransform) {
          containerTransforms = [...transforms, viewportTransform];
          stats.nestedViewports++;
        }
        const nestedViewBox = parseViewBox(attrs);
        if (nestedViewBox) childViewport = { width: nestedViewBox[2], height: nestedViewBox[3] };
        else {
          const nestedWidth = context.viewportOverride?.width || parseViewportLength(attrs.width, context.viewport?.width, context.viewport?.width);
          const nestedHeight = context.viewportOverride?.height || parseViewportLength(attrs.height, context.viewport?.height, context.viewport?.height);
          if (nestedWidth > 0 && nestedHeight > 0) childViewport = { width: nestedWidth, height: nestedHeight };
        }
      }
      const shouldNestGroup = preserveHierarchy && node !== rootNode && (tag === 'g' || ownOpacity < 1);
      const groupLabel = attrs.id || attrs['data-name'] || attrs['inkscape:label'] || tag;
      const childGroupPath = shouldNestGroup
        ? [...(context.groupPath || []), groupDescriptor(groupLabel, ownOpacity, ownOpacity < 1 ? ' · Opacity' : '')]
        : (context.groupPath || []);
      const childContext = {
        style, opacity: cumulativeOpacity, transforms: containerTransforms,
        viewportOverride: null, viewport: childViewport,
        clipIds: activeClipIds, maskIds: activeMaskIds,
        groupPath: childGroupPath
      };
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
    const d = drawableToPath(tag, attrs, context.viewport);
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
        $, gradientNodes, id: gradId, cssRules, localBounds, finalBounds: b,
        transformChain: transforms, rootMatrix, fillOpacity, currentColor
      });
      if (gradient) {
        stats.gradients++;
        const resolvedGradient = resolveGradient($, gradientNodes, gradId, cssRules);
        const spread = String(resolvedGradient?.attrs?.spreadMethod || 'pad').toLowerCase();
        if (!['pad', ''].includes(spread)) {
          stats.gradientSpreadUnsupported++;
          warnings.add(`Gradient #${gradId} memakai spreadMethod="${spread}" yang belum dapat dipetakan.`);
        }
        if (resolvedGradient?.type === 'radial' && ['fx', 'fy', 'fr'].some((key) => resolvedGradient.attrs?.[key] != null)) {
          stats.radialGradientFocusUnsupported++;
          warnings.add(`Radial gradient #${gradId} memakai focal point yang belum dapat dipetakan.`);
        }
        if (gradient.reducedStops) {
          stats.gradientStopsReduced++;
          warnings.add(`Gradient #${gradId} memiliki lebih dari 2 stop. Skema XML Alight Motion referensi hanya membuktikan start/end color; stop tengah belum dapat dipetakan 1:1.`);
        }
        if (preserveFidelity) {
          // Fidelity-oriented modes keep native AM gradient instead of flattening it.
          fillColor = gradient.startColor;
        } else {
          // Existing grouped modes keep their v1.4 behavior unchanged.
          fillColor = blendArgb(gradient.startColor, gradient.endColor, 0.5);
          stats.gradientsFlattened++;
          warnings.add('Gradient diratakan menjadi satu warna solid karena mode Color Groups mensyaratkan 1 group = 1 warna.');
        }
      } else {
        const paintNodeTag = String(idNodes.get(gradId)?.name || '').toLowerCase();
        const fallbackPaint = paintFallback(fillValue);
        fillColor = fallbackPaint ? parseCssColor(fallbackPaint, fillOpacity, currentColor) : null;
        if (paintNodeTag === 'pattern') {
          stats.patternsUnsupported++;
          warnings.add(`Pattern #${gradId} belum memiliki mapping fill native; ${fallbackPaint ? 'fallback paint dipakai.' : 'fill pattern dilewati.'}`);
        } else {
          warnings.add(`Paint server #${gradId} tidak ditemukan; ${fallbackPaint ? 'fallback paint dipakai.' : 'fill dilewati.'}`);
        }
      }
    } else {
      fillColor = parseCssColor(fillValue, fillOpacity, currentColor);
    }

    const strokePaintId = localIriRef(strokeValue);
    const strokeColor = strokePaintId ? null : parseCssColor(strokeValue, strokeOpacity, currentColor);
    if (strokePaintId) {
      stats.gradientStrokesUnsupported++;
      warnings.add(`Paint server pada stroke (#${strokePaintId}) belum dapat dipetakan ke path-stroke Alight Motion.`);
    }
    const viewportDiagonal = context.viewport
      ? Math.hypot(context.viewport.width, context.viewport.height) / Math.SQRT2
      : NaN;
    const rawStrokeWidth = Math.max(0, parseViewportLength(style['stroke-width'], 1, viewportDiagonal));
    const nonScalingStroke = String(style['vector-effect'] || '').toLowerCase() === 'non-scaling-stroke';
    const strokeWidth = strokeColor
      ? (nonScalingStroke ? rawStrokeWidth : transformedStrokeWidth(rawStrokeWidth, transforms, rootMatrix))
      : 0;
    if (strokeColor && strokeWidth > 0) {
      stats.strokes++;
      if (options.removeStrokes) stats.strokesRemoved++;
      if (!nonScalingStroke && !transformIsUniformOrthogonal(transforms, rootMatrix)) {
        stats.nonUniformStrokeTransforms++;
        warnings.add('Stroke berada di bawah transform non-uniform/skew; width rata-rata tidak identik dengan outline SVG asli.');
      }
      const miterLimit = finiteNumber(style['stroke-miterlimit'], 4);
      if (String(style['stroke-linejoin'] || 'miter').toLowerCase() === 'miter' && Math.abs(miterLimit - 4) > 1e-9) {
        stats.strokeMiterLimitsUnsupported++;
        warnings.add(`stroke-miterlimit="${style['stroke-miterlimit']}" belum dipetakan ke path-stroke Alight Motion.`);
      }
    }
    const paintOrder = String(style['paint-order'] || 'normal').trim().toLowerCase();
    if (!['', 'normal', 'fill stroke markers'].includes(paintOrder)) {
      stats.paintOrderUnsupported++;
      warnings.add(`paint-order="${paintOrder}" belum dipetakan; urutan default Alight Motion dipakai.`);
    }
    if (style['mix-blend-mode'] && !['normal', 'unset', 'initial'].includes(String(style['mix-blend-mode']).toLowerCase())) {
      stats.blendModesUnsupported++;
      warnings.add(`mix-blend-mode="${style['mix-blend-mode']}" belum dipetakan ke atribut blending Alight Motion.`);
    }

    // Existing three modes intentionally stay stroke-free. Lossless keeps native
    // Alight Motion <path-stroke>, including stroke-only paths.
    if (!fillColor && !(preserveFidelity && strokeColor && strokeWidth > 0)) {
      if (strokeColor && strokeWidth > 0) stats.strokeOnlyDropped++;
      return;
    }

    const sceneClipPaths = [];
    if (activeClipIds.length) {
      if (preserveFidelity) {
        for (const clipId of activeClipIds) {
          let clipPath = null;
          try {
            clipPath = clipPathForShape({
              clipNode: clipPathNodes.get(clipId), idNodes, localBounds,
              targetTransforms: transforms, rootMatrix, viewport: context.viewport,
              precision: options.geometryPrecision, cssRules
            });
          } catch {}
          if (clipPath) sceneClipPaths.push(clipPath);
          else {
            stats.clipPathsUnsupported++;
            stats.clipOrMaskWarnings++;
            warnings.add(`clipPath #${clipId} tidak dapat di-resolve menjadi mask vector Alight Motion.`);
          }
        }
        if (sceneClipPaths.length) stats.clipPathsApplied += sceneClipPaths.length;
      } else {
        stats.clipPathsUnsupported += activeClipIds.length;
        stats.clipOrMaskWarnings += activeClipIds.length;
        warnings.add('clipPath hanya dipertahankan sebagai native mask pada mode Maximum Fidelity. Mode ini memakai geometri dasar.');
      }
    }
    if (activeMaskIds.length) {
      stats.masksUnsupported += activeMaskIds.length;
      stats.clipOrMaskWarnings += activeMaskIds.length;
      warnings.add('SVG mask terdeteksi. Mask luminance/alpha belum dapat dipetakan 1:1; geometri dasar tetap dipertahankan.');
    }
    if (style.filter && style.filter !== 'none') {
      stats.filtersUnsupported++;
      warnings.add('Filter SVG kompleks tidak punya padanan 1:1 yang terbukti di skema XML referensi; geometri/fill/stroke dasar tetap dipertahankan.');
    }
    if (['marker-start', 'marker-mid', 'marker-end'].some((key) => style[key] && style[key] !== 'none')) {
      stats.markersUnsupported++;
      warnings.add('SVG marker/arrowhead terdeteksi pada path. Marker belum dikonversi menjadi shape vector terpisah.');
    }

    let scenePath = transformed;
    const fillRule = String(style['fill-rule'] || 'nonzero').toLowerCase();
    if (preserveFidelity && fillRule === 'evenodd') {
      const normalizedRule = normalizeEvenOddToNonZero(scenePath);
      scenePath = normalizedRule.path;
      if (normalizedRule.changed) stats.evenOddNormalized++;
      warnings.add('fill-rule="evenodd" dinormalisasi menjadi alternating subpath winding karena XML AM referensi tidak menunjukkan atribut fill-rule eksplisit. Kurva Bézier tidak disampling/diubah.');
    } else if (fillRule === 'evenodd') {
      warnings.add('fill-rule="evenodd" dipertahankan sebagai path, tetapi hasil lubang/overlap perlu dicek di Alight Motion.');
    }

    const dashArray = String(style['stroke-dasharray'] || 'none').trim();
    const lineCap = String(style['stroke-linecap'] || 'butt').trim().toLowerCase();
    if (preserveFidelity && strokeColor && strokeWidth > 0) {
      if (dashArray && dashArray.toLowerCase() !== 'none') {
        stats.strokeDashesUnsupported++;
        warnings.add('stroke-dasharray terdeteksi. XML referensi membuktikan path-stroke color/size/join, tetapi belum membuktikan atribut dash; stroke dibuat solid dan warning dikembalikan.');
      }
      if (lineCap !== 'butt') {
        stats.strokeCapsUnsupported++;
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
    const primitiveSource = ['rect', 'circle', 'ellipse'].includes(tag);
    const noComplexPrimitiveTransform = !transforms.some((value) => /(?:rotate|skew|matrix)\s*\(/i.test(String(value || '')));
    const roundedRect = tag === 'rect' && (
      (attrs.rx != null && !/^\s*(?:0|0\.0+)(?:px|%)?\s*$/i.test(String(attrs.rx))) ||
      (attrs.ry != null && !/^\s*(?:0|0\.0+)(?:px|%)?\s*$/i.test(String(attrs.ry)))
    );
    const primitiveKind = options.detectPrimitives && primitiveSource && noComplexPrimitiveTransform &&
      !roundedRect && fillColor && !gradient && !strokeColor && !(sceneClipPaths || []).length && !(activeMaskIds || []).length
      ? (tag === 'rect' ? 'rect' : 'circle')
      : null;
    if (options.detectPrimitives && primitiveSource) {
      if (primitiveKind) stats.primitiveCandidates++;
      else stats.primitiveFallback++;
    }
    candidates.push({
      sourceOrder: sourceOrder++,
      sourceLabel: sourceName,
      sourceTag: tag,
      primitiveKind,
      area: effectiveArea,
      bounds: b,
      scenePath,
      fillColor,
      gradient: preserveFidelity ? gradient : null,
      fillRule,
      strokeColor: preserveFidelity ? strokeColor : null,
      strokeWidth: preserveFidelity ? strokeWidth : 0,
      strokeJoin: String(style['stroke-linejoin'] || 'miter').toLowerCase(),
      strokeLineCap: lineCap,
      strokeDashArray: dashArray,
      sceneClipPaths,
      layerOpacity: preserveHierarchy ? ownOpacity : 1,
      groupPath: preserveHierarchy ? (context.groupPath || []) : []
    });
  };

  const rootStyle = computedStyle(rootNode, DEFAULT_STYLE, cssRules);
  const rootOpacity = parseOpacity(rootStyle.opacity, 1);
  for (const child of rootNode.children || []) {
    walk(child, {
      style: rootStyle, opacity: preserveFidelity ? 1 : rootOpacity,
      transforms: [], viewportOverride: null,
      viewport: userViewport, clipIds: [], maskIds: [], groupPath: []
    });
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
      const localClipPaths = [];
      for (const clipPath of shape.sceneClipPaths || []) {
        try {
          const translatedClip = svgpath(clipPath).translate(-centerX, -centerY).abs().toString();
          localClipPaths.push(serializePathForAlight(translatedClip, options.precision));
        } catch {
          stats.clipPathsUnsupported++;
          warnings.add(`clipPath pada shape "${shape.sourceLabel}" gagal diserialisasi; shape dasar tetap dipertahankan.`);
        }
      }
      const outputShape = { ...shape, cx: centerX, cy: centerY, localPath, localClipPaths };
      losslessShapes.push(outputShape);
      if (outputShape.primitiveKind) stats.primitiveOutput++;

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

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality);
    if (options.requireExact && !fidelity.exact) {
      const codes = fidelity.losses.map((loss) => loss.code).join(', ');
      const error = new Error(`Maximum Fidelity menolak output yang tidak identik. Fitur bermasalah: ${codes}.`);
      error.code = 'FIDELITY_REQUIREMENT_FAILED';
      error.fidelity = fidelity;
      error.warnings = [...warnings];
      throw error;
    }

    const layerXml = buildLosslessLayerXml(
      losslessShapes, width, height, options.duration, options.fps, options.precision, rootOpacity
    );
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
        version: '2.2.0',
        quality: 'lossless',
        groupedByColor: false,
        preservesSourceOrder: true,
        strokesRemoved: false,
        nativeStroke: true,
        nodeReduction: 0,
        precision: 8,
        maxShapes: 'unlimited',
        groupingMode: options.groupingMode,
        detectPrimitives: options.detectPrimitives,
        primitiveOutput: stats.primitiveOutput
      },
      sourceFeatures,
      fidelity
    };
  }


  if (options.quality === 'color-group') {
    const centerX = width / 2;
    const centerY = height / 2;
    const groups = new Map();
    const fallback = [];
    const sourceRecords = [];
    let serializedSources = 0;

    const eligibleColorKey = (shape) => {
      if (!shape.fillColor || shape.gradient) return null;
      if (!isOpaqueArgb(shape.fillColor)) return null;
      if (shape.strokeColor && shape.strokeWidth > 0) return null;
      if ((shape.sceneClipPaths || []).length) return null;
      return String(shape.fillColor).toLowerCase();
    };

    for (const shape of kept) {
      let localPath;
      try {
        const translated = svgpath(shape.scenePath).translate(-centerX, -centerY).abs().toString();
        localPath = serializePathForAlight(translated, options.precision);
      } catch (error) {
        stats.skippedUnsupported++;
        warnings.add(`Shape "${shape.sourceLabel}" gagal diserialisasi untuk Color Groups: ${error?.message || error}`);
        continue;
      }

      serializedSources++;
      stats.nodesAfter += pathNodeCount(localPath);
      const localClipPaths = [];
      for (const clipPath of shape.sceneClipPaths || []) {
        try {
          const translatedClip = svgpath(clipPath).translate(-centerX, -centerY).abs().toString();
          localClipPaths.push(serializePathForAlight(translatedClip, options.precision));
        } catch {
          stats.clipPathsUnsupported++;
          warnings.add(`clipPath pada shape "${shape.sourceLabel}" gagal diserialisasi di Color Groups; shape dasar tetap dipertahankan.`);
        }
      }

      const outputShape = {
        ...shape,
        primitiveKind: null,
        cx: centerX,
        cy: centerY,
        localPath,
        localClipPaths,
        groupPath: []
      };

      const colorKey = eligibleColorKey(shape);
      if (!colorKey) {
        const unitKey = `fallback:${shape.sourceOrder}`;
        const fallbackUnit = {
          kind: 'fallback',
          key: unitKey,
          shape: outputShape,
          firstOrder: shape.sourceOrder,
          lastOrder: shape.sourceOrder
        };
        fallback.push(fallbackUnit);
        sourceRecords.push({
          unitKey,
          sourceOrder: shape.sourceOrder,
          bounds: shape.bounds
        });
        continue;
      }

      const unitKey = `color:${colorKey}`;
      let group = groups.get(colorKey);
      if (!group) {
        group = {
          key: colorKey,
          unitKey,
          fillColor: shape.fillColor,
          shapes: [],
          sourceOrders: [],
          bounds: [],
          firstOrder: shape.sourceOrder,
          lastOrder: shape.sourceOrder
        };
        groups.set(colorKey, group);
      }
      group.shapes.push(outputShape);
      group.sourceOrders.push(shape.sourceOrder);
      if (shape.bounds) group.bounds.push(shape.bounds);
      group.firstOrder = Math.min(group.firstOrder, shape.sourceOrder);
      group.lastOrder = Math.max(group.lastOrder, shape.sourceOrder);
      sourceRecords.push({
        unitKey,
        sourceOrder: shape.sourceOrder,
        bounds: shape.bounds
      });
    }

    const colorUnits = [];
    for (const group of groups.values()) {
      stats.mergedShapes += Math.max(0, group.shapes.length - 1);
      stats.safeColorMerges += Math.max(0, group.shapes.length - 1);
      colorUnits.push({
        kind: 'color',
        key: group.unitKey,
        group,
        firstOrder: group.firstOrder,
        lastOrder: group.lastOrder
      });
    }

    const allUnits = [...colorUnits, ...fallback];
    const ordering = orderColorUnits(allUnits, sourceRecords);
    const outputUnits = ordering.ordered;
    stats.zOrderBarriers = ordering.zOrderConflicts;
    stats.colorGroups = colorUnits.length;
    stats.outputShapes = outputUnits.length;
    stats.missingShapes = Math.max(0, kept.length - serializedSources);

    if (fallback.length) {
      warnings.add(
        `Color Groups mempertahankan ${fallback.length} layer kompleks secara terpisah karena gradient/stroke/transparency/clip tidak aman dipaketkan berdasarkan warna.`
      );
    }
    if (ordering.zOrderConflicts > 0) {
      warnings.add(
        `${ordering.zOrderConflicts} konflik overlap z-order terdeteksi. Satu warna tetap menjadi satu layer, tetapi beberapa overlap lintas warna tidak mungkin mempertahankan semua urutan sumber sekaligus.`
      );
    }
    if (stats.mergedShapes > 0) {
      warnings.add(
        `Color Groups memaketkan ${serializedSources - fallback.length} shape solid ke ${colorUnits.length} layer warna tanpa menggabungkan geometri path internal.`
      );
    }

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality);
    const layerXml = buildColorGroupsLayerXml(
      outputUnits, width, height, options.duration, options.fps, options.precision, rootOpacity
    );
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Color Groups v2.2: Maximum Fidelity geometry parser + one top-level layer per solid color, preserving source shapes inside each color layer. -->`,
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
      grouping: {
        engine: 'color-groups',
        inputShapes: kept.length,
        groupedColors: colorUnits.length,
        groupedLayers: colorUnits.length,
        fallbackLayers: fallback.length,
        outputLayers: outputUnits.length,
        mergedShapes: stats.mergedShapes,
        packedShapes: stats.mergedShapes,
        safeColorMerges: stats.safeColorMerges,
        geometryMerged: false,
        preservesInternalShapes: true,
        overlapConstraints: ordering.overlapConstraints,
        zOrderBarriers: ordering.zOrderConflicts,
        zOrderConflicts: ordering.zOrderConflicts,
        topologicalOrder: ordering.topological
      },
      profile: {
        version: '2.2.0',
        quality: 'color-group',
        engine: 'color-groups',
        groupedByColor: true,
        colorGroups: colorUnits.length,
        preservesSourceOrder: ordering.zOrderConflicts === 0,
        preservesInternalShapes: true,
        geometryMerged: false,
        strokesRemoved: false,
        nativeStroke: true,
        nodeReduction: 0,
        precision: 8,
        maxShapes: 'unlimited',
        groupingMode: 'color',
        detectPrimitives: false,
        primitiveOutput: 0
      },
      sourceFeatures,
      fidelity
    };
  }

  if (options.quality === 'patch-clean') {
    const centerX = width / 2;
    const centerY = height / 2;
    const patchArea = sceneArea * (options.patchAreaPercent / 100);
    const protectLongDimension = Math.max(width, height) * (options.protectThinPercent / 100);
    const cleanedShapes = [];

    for (const shape of kept) {
      let cleaned;
      try {
        cleaned = pruneMicroSubpaths(
          shape.scenePath,
          patchArea,
          protectLongDimension,
          options.precision
        );
      } catch {
        cleaned = { path: shape.scenePath, removed: 0, removedNodes: 0 };
      }

      stats.microSubpathsRemoved += cleaned.removed || 0;
      stats.microNodesRemoved += cleaned.removedNodes || 0;
      if (!cleaned.path) {
        stats.removedMicroShapes++;
        continue;
      }

      let localPath;
      try {
        const translated = svgpath(cleaned.path).translate(-centerX, -centerY).abs().toString();
        localPath = serializePathForAlight(translated, options.precision);
      } catch (error) {
        stats.skippedUnsupported++;
        warnings.add(`Shape "${shape.sourceLabel}" gagal diserialisasi setelah cleanup: ${error?.message || error}`);
        continue;
      }

      stats.nodesAfter += pathNodeCount(localPath);

      const localClipPaths = [];
      for (const clipPath of shape.sceneClipPaths || []) {
        try {
          const translatedClip = svgpath(clipPath).translate(-centerX, -centerY).abs().toString();
          localClipPaths.push(serializePathForAlight(translatedClip, options.precision));
        } catch {
          stats.clipPathsUnsupported++;
          warnings.add(`clipPath pada shape "${shape.sourceLabel}" gagal diserialisasi; shape dasar tetap dipertahankan.`);
        }
      }

      const cleanedOutput = {
        ...shape,
        scenePath: cleaned.path,
        bounds: safeBounds(cleaned.path) || shape.bounds,
        cx: centerX,
        cy: centerY,
        localPath,
        localClipPaths
      };
      cleanedShapes.push(cleanedOutput);
      if (cleanedOutput.primitiveKind) stats.primitiveOutput++;
    }

    stats.outputShapes = cleanedShapes.length;
    stats.colorGroups = 0;
    stats.mergedShapes = 0;
    stats.missingShapes = Math.max(0, stats.drawableElements - stats.outputShapes);

    if (stats.microSubpathsRemoved > 0 || stats.removedMicroShapes > 0) {
      warnings.add(
        `Small Patch Cleanup membuang ${stats.microSubpathsRemoved} subpath kecil dan ${stats.removedMicroShapes} shape mikro (${stats.microNodesRemoved} node).`
      );
    }

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality);
    const layerXml = buildLosslessLayerXml(
      cleanedShapes,
      width,
      height,
      options.duration,
      options.fps,
      options.precision,
      rootOpacity
    );
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Small Patch Cleanup: Maximum Fidelity pipeline with micro-island removal only. -->`,
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
      cleanup: {
        engine: 'small-patch-cleanup',
        patchAreaPercent: options.patchAreaPercent,
        protectThinPercent: options.protectThinPercent,
        thinAspectRatio: PATCH_THIN_ASPECT_RATIO,
        removedSubpaths: stats.microSubpathsRemoved,
        removedShapes: stats.removedMicroShapes,
        removedNodes: stats.microNodesRemoved
      },
      profile: {
        version: '2.2.0',
        quality: 'patch-clean',
        engine: 'small-patch-cleanup',
        groupedByColor: false,
        preservesSourceOrder: true,
        strokesRemoved: false,
        nativeStroke: true,
        nodeReduction: 0,
        precision: 8,
        maxShapes: 'unlimited',
        patchAreaPercent: options.patchAreaPercent,
        protectThinPercent: options.protectThinPercent,
        thinAspectRatio: PATCH_THIN_ASPECT_RATIO,
        groupingMode: options.groupingMode,
        detectPrimitives: options.detectPrimitives,
        primitiveOutput: stats.primitiveOutput
      },
      sourceFeatures,
      fidelity
    };
  }

  throw new Error(`Engine tidak didukung: ${options.quality}`);
}

import { load } from 'cheerio';
import { bridgeFilledSubpaths } from './contour-bridge.js';
import { planCompoundMasks } from './compound-masks.js';
import svgpath from 'svgpath';
import pathBounds from 'svg-path-bounds';
import { DEFAULT_STYLE, parseCssColor, inspectCssColor, parseCssRules, computedStyle } from './svg-paint.js';
import {
  normalizePathForAlight,
  serializePathForAlight,
  pathNodeCount,
  normalizeEvenOddToNonZero,
  classifyFilledPathRelationship
} from './path-geometry.js';
import {
  ALIGHT_SCHEMA_PROFILE,
  PROVIDER_VERSION,
  alightSchemaAttributes,
  validateAlightImportXml
} from './alight-compatibility.js';

const DRAWABLE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'symbol', 'switch']);
const SKIP_TAGS = new Set([
  'defs', 'lineargradient', 'radialgradient', 'style', 'metadata', 'title', 'desc',
  'clippath', 'mask', 'pattern', 'marker', 'filter', 'foreignobject', 'script'
]);

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

function safeBounds(d) {
  try {
    const b = pathBounds(d);
    if (Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) return b;
  } catch {}
  return null;
}

function segmentListToPath(segments) {
  return segments.map((seg) => `${seg[0]}${seg.slice(1).join(' ')}`).join('');
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
    currentColor: style.color || '#000000',
    colorInterpolation: style['color-interpolation'] || 'sRGB',
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

  let fs = pointViaTransforms(pStart[0], pStart[1], transformChain, rootMatrix);
  let fe = pointViaTransforms(pEnd[0], pEnd[1], transformChain, rootMatrix);
  if (gradient.type === 'linear' && gradient.stops.length === 2 && last.offset > first.offset) {
    const dx = fe[0] - fs[0], dy = fe[1] - fs[1], origin = fs;
    fs = [origin[0] + dx * first.offset, origin[1] + dy * first.offset];
    fe = [origin[0] + dx * last.offset, origin[1] + dy * last.offset];
  }
  const start = [(fs[0] - fx1) / fw, (fs[1] - fy1) / fh];
  const end = [(fe[0] - fx1) / fw, (fe[1] - fy1) / fh];
  const startColor = parseCssColor(first.color, first.opacity * fillOpacity, first.currentColor || currentColor) || '#ff000000';
  const endColor = parseCssColor(last.color, last.opacity * fillOpacity, last.currentColor || currentColor) || startColor;

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

function buildSceneOpenTag({ title, width, height, duration, fps, modifiedTime, nested = false }) {
  return `<scene title="${xmlEscape(title)}" width="${width}" height="${height}" exportWidth="${width}" exportHeight="${height}" bgcolor="#00000000" totalTime="${duration}" fps="${fps}" modifiedTime="${modifiedTime}" ${alightSchemaAttributes({ nested })}>`;
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
  // Vector Magic can close earlier SVG contours implicitly with the next M.
  // Bridge filled subpaths into one walk to retain nonzero-winding holes in AM.
  // Never bridge strokes: the connectors would otherwise become visible.
  const contourPath = fillType !== 'none' && !(shape.strokeColor && shape.strokeWidth > 0)
    ? bridgeFilledSubpaths(shape.localPath).path
    : shape.localPath;
  lines.push(`${child}<path d="${xmlEscape(contourPath)}" />`);
  lines.push(`${indent}</shape>`);
  return lines.join('\n');
}


/**
 * Experimental alternative to bridge-stitching. Hole boundaries are
 * independently editable; exclude masks stay isolated from sibling layers.
 * Do not make this the default before actual AM device verification.
 */
function hasCompoundPath(shape) {
  const parsed = svgpath(shape.localPath);
  return !parsed.err && parsed.segments.filter(seg => String(seg[0]).toUpperCase() === 'M').length > 1;
}

function maskPlanFor(shape) {
  if (!shape.fillColor || shape.gradient || (shape.strokeColor && shape.strokeWidth > 0) ||
      shape.hasClip || shape.hasMask || shape.hasFilter || shape.hasBlendMode ||
      shape.localClipPaths?.length) return null;
  return planCompoundMasks(shape.localPath, { fillRule: shape.fillRule || 'nonzero' });
}

function buildMaskedCompoundShapeXml(shape, index, duration, precision, width, height, fps) {
  const plan = maskPlanFor(shape);
  if (!plan) return null;
  const name = sourceLabel(shape, index);
  const outerXml = buildLosslessShapeXml({
    ...shape, localPath: plan.outer, layerOpacity: 1
  }, index, duration, precision, width, height, {
    id: 1, indent: '          ', label: name + ' · Outer'
  });
  const holesXml = plan.holes.map((hole, i) => buildLosslessShapeXml({
    ...shape, localPath: hole, fillColor: '#ffffffff', gradient: null,
    strokeColor: null, strokeWidth: 0, layerOpacity: 1
  }, index, duration, precision, width, height, {
    id: i + 2, indent: '          ', blending: 'exclude',
    label: name + ' · Hole ' + (i + 1)
  })).join('\n');
  return [
    '      <embedScene id="' + (380000001 + index) + '" label="' + xmlEscape(name) + ' · Isolated Contours" startTime="0" endTime="' + duration + '" fillType="intrinsic" outTime="' + duration + '" mediaFillMode="fill">',
    '        <transform>',
    '          <location value="' + fmt(width / 2) + ',' + fmt(height / 2) + ',0.000000" />',
    ...(shape.layerOpacity != null && shape.layerOpacity < 1
      ? ['          <opacity value="' + fmt(shape.layerOpacity, precision) + '" />'] : []),
    '        </transform>',
    '        <fillColor value="#ff000000" />',
    buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
    outerXml,
    holesXml,
    '        </scene>',
    '      </embedScene>'
  ].join('\n');
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
    buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
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

function buildLosslessTreeXml(entries, depth, width, height, duration, fps, precision, compoundPathMode) {
  return entries.map((entry) => {
    if (entry.type === 'shape') {
      const masked = compoundPathMode === 'masks'
        ? buildMaskedCompoundShapeXml(entry.shape, entry.index, duration, precision, width, height, fps)
        : null;
      const xml = masked || (entry.shape.localClipPaths?.length
        ? buildClippedLosslessShapeXml(entry.shape, entry.index, duration, precision, width, height, fps)
        : (entry.shape.primitiveKind
          ? buildPrimitiveShapeXml(entry.shape, entry.index, duration, precision)
          : buildLosslessShapeXml(entry.shape, entry.index, duration, precision, width, height)));
      return shiftLosslessXml(xml, depth);
    }
    const descriptor = entry.descriptor;
    const inner = buildLosslessTreeXml(entry.children, depth + 1, width, height, duration, fps, precision, compoundPathMode);
    const base = [
      `      <embedScene id="${360000001 + descriptor.token}" label="${xmlEscape(descriptor.label)}" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
      '        <transform>',
      `          <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
      `          <opacity value="${fmt(descriptor.opacity, precision)}" />`,
      '        </transform>',
      '        <fillColor value="#ff000000" />',
      buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
      inner,
      '        </scene>',
      '      </embedScene>'
    ].join('\n');
    return shiftLosslessXml(base, depth);
  }).join('\n');
}

function buildLosslessLayerXml(shapes, width, height, duration, fps, precision, rootOpacity = 1, compoundPathMode = 'bridges') {
  const tree = buildLosslessTree(shapes);
  const inner = buildLosslessTreeXml(tree.children, 0, width, height, duration, fps, precision, compoundPathMode);
  return [
    `  <embedScene id="300000001" label="SVG Lossless Layer" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    ...(rootOpacity < 1 ? [`      <opacity value="${fmt(rootOpacity, precision)}" />`] : []),
    '    </transform>',
    '    <fillColor value="#ff000000" />',
    buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
    inner,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}

function boundsMayIntersect(a, b, epsilon = 1e-9) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  const overlapWidth = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const overlapHeight = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return overlapWidth >= -epsilon && overlapHeight >= -epsilon;
}

function analyzeGroupingEligibility(shape) {
  const reasons = [];
  if (!shape.fillColor && !shape.gradient) reasons.push('NO_VISIBLE_FILL');
  if (shape.gradient) reasons.push('HAS_GRADIENT');
  if (shape.fillColor && !isOpaqueArgb(shape.fillColor)) reasons.push('PARTIAL_ALPHA');
  if (shape.strokeColor && shape.strokeWidth > 0) reasons.push('HAS_STROKE');
  if ((shape.sceneClipPaths || []).length || shape.hasClip) reasons.push('HAS_CLIP');
  if (shape.hasMask) reasons.push('HAS_MASK');
  if (shape.hasFilter) reasons.push('HAS_FILTER');
  if (shape.hasMarker) reasons.push('HAS_MARKER');
  if (shape.hasBlendMode) reasons.push('HAS_BLEND_MODE');
  if (shape.unresolvedPaint) reasons.push('UNRESOLVED_PAINT');
  if (!shape.scenePath || !shape.bounds) reasons.push('UNSUPPORTED_GEOMETRY');
  if (shape.colorGroupingUnsafe && !reasons.length) reasons.push('UNSUPPORTED_COMPOSITING');
  if (!reasons.length) reasons.push('SOLID_OPAQUE_SAFE');
  return {
    eligible: reasons.length === 1 && reasons[0] === 'SOLID_OPAQUE_SAFE',
    colorKey: reasons.length === 1 && reasons[0] === 'SOLID_OPAQUE_SAFE'
      ? String(shape.fillColor).toLowerCase()
      : null,
    reasonCodes: reasons
  };
}

function geometryRelationship(a, b) {
  if (!a.geometryTrusted || !b.geometryTrusted) return 'UNKNOWN';
  return classifyFilledPathRelationship(a.scenePath, b.scenePath, {
    fillRuleA: a.fillRule,
    fillRuleB: b.fillRule
  });
}

function orderColorUnits(units, sourceRecords) {
  const edges = new Map(units.map((unit) => [unit.key, new Set()]));
  const audit = {
    overlapCandidates: 0,
    geometryChecks: 0,
    actualOverlaps: 0,
    touchingPairs: 0,
    unknownPairs: 0,
    zOrderConstraints: 0
  };

  const spatialRecords = sourceRecords
    .filter((record) => Array.isArray(record.bounds) && record.bounds.length === 4 && edges.has(record.unitKey))
    .sort((a, b) => a.bounds[0] - b.bounds[0] || a.sourceOrder - b.sourceOrder);
  for (let i = 0; i < spatialRecords.length; i++) {
    const left = spatialRecords[i];
    for (let j = i + 1; j < spatialRecords.length; j++) {
      const right = spatialRecords[j];
      if (right.bounds[0] > left.bounds[2] + 1e-9) break;
      if (left.unitKey === right.unitKey) continue;
      if (!boundsMayIntersect(left.bounds, right.bounds)) continue;
      const [a, b] = left.sourceOrder <= right.sourceOrder ? [left, right] : [right, left];
      audit.overlapCandidates++;
      audit.geometryChecks++;
      const relationship = geometryRelationship(a, b);
      if (relationship === 'DISJOINT') continue;
      if (relationship === 'TOUCHING') {
        audit.touchingPairs++;
        continue;
      }
      if (relationship === 'UNKNOWN') audit.unknownPairs++;
      else audit.actualOverlaps++;
      const targets = edges.get(a.unitKey);
      if (!targets.has(b.unitKey)) {
        targets.add(b.unitKey);
        audit.zOrderConstraints++;
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
      ...audit,
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
      ...audit,
      zOrderConflicts: Math.max(1, zOrderConflicts),
      topological: false
    };
  }

  return { ordered, ...audit, zOrderConflicts: 0, topological: true };
}

function buildColorLayerXml(group, index, width, height, duration, fps, precision) {
  const raw = String(group.fillColor || '#ff000000').replace('#', '').toUpperCase();
  const visible = raw.length === 8 && raw.startsWith('FF') ? `#${raw.slice(2)}` : `#${raw}`;
  // Follow the structure emitted by real Alight Motion group scenes:
  // neutral embedScene fill, empty nested scene title, ASCII-safe label.
  const label = `Color ${String(index + 1).padStart(2, '0')} - ${visible}`;
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
    '        <fillColor value="#FF000000" />',
    buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
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
    `  <embedScene id="300000001" label="SVG Color Groups" startTime="0" endTime="${duration}" fillType="intrinsic" outTime="${duration}" mediaFillMode="fill">`,
    '    <transform>',
    `      <location value="${fmt(width / 2)},${fmt(height / 2)},0.000000" />`,
    ...(rootOpacity < 1 ? [`      <opacity value="${fmt(rootOpacity, precision)}" />`] : []),
    '    </transform>',
    '    <fillColor value="#ff000000" />',
    buildSceneOpenTag({ title: '', width, height, duration, fps, modifiedTime: 0, nested: true }),
    inner,
    '    </scene>',
    '  </embedScene>'
  ].join('\n');
}

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
  const quality = aliases[requested];
  if (!quality) {
    const error = new Error(`Engine tidak didukung: ${requested}`);
    error.code = 'ENGINE_NOT_SUPPORTED';
    error.engine = requested;
    throw error;
  }
  const duration = clamp(Math.round(finiteNumber(rawOptions.duration, 1000)), 100, 600000);
  const fps = clamp(Math.round(finiteNumber(rawOptions.fps, 30)), 1, 240);
  const title = sanitizeTitle(rawOptions.title || 'SVG to Alight Motion');
  const groupingMode = String(rawOptions.groupingMode || rawOptions.grouping || 'nested').toLowerCase() === 'flat' ? 'flat' : 'nested';
  const detectPrimitives = rawOptions.detectPrimitives === true;
  const compoundPathMode = String(rawOptions.compoundPathMode || 'bridges').toLowerCase();
  if (!['bridges','masks'].includes(compoundPathMode)) {
    const error = new Error('compoundPathMode harus bridges atau masks.');
    error.code = 'COMPOUND_PATH_MODE_NOT_SUPPORTED';
    throw error;
  }
  if (quality === 'color-group' && compoundPathMode === 'masks') {
    const error = new Error('Contour masks saat ini hanya tersedia untuk maximum-fidelity dan patch-clean.');
    error.code = 'COMPOUND_PATH_MODE_UNAVAILABLE';
    throw error;
  }

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
      compoundPathMode,
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
      includeTimings: rawOptions.includeTimings === true,
      duration,
      fps,
      title
    };
  }

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
      finiteNumber(rawOptions.patchAreaPercent ?? rawOptions.microDetailPercent, 0.01),
      0,
      0.25
    ),
    protectThinPercent: clamp(
      finiteNumber(rawOptions.protectThinPercent, 2.0),
      0,
      100
    ),
    groupingMode,
    detectPrimitives,
    compoundPathMode,
    duration,
    fps,
    title
  };
}

function buildFidelityReport(stats, sourceFeatures, quality, cssIssues) {
  stats.cssRulesUnsupported = cssIssues?.size || 0;
  const losses = [];
  const add = (code, count, message) => {
    if (count > 0) losses.push({ code, count, message });
  };
  add('contour-mask-unverified', stats.contourMaskGroups || 0,
    'Compositing native exclude masks belum diverifikasi pada perangkat Alight Motion.');
  add('unsupported-paint', stats.unsupportedPaints, 'Sintaks warna tidak didukung; warna tidak diganti diam-diam.');
  add('color-gamut', stats.outOfGamutPaints, 'Warna melampaui gamut sRGB 8-bit XML Alight Motion.');
  add('css-unsupported', stats.cssRulesUnsupported, 'Aturan CSS kondisional/dinamis atau cascade belum dapat dipastikan identik.');
  add('skipped-elements', stats.skippedUnsupported, 'Elemen/path tidak didukung atau gagal diproses.');
  add('unresolved-use', stats.unresolvedUses, 'Referensi <use> tidak dapat di-resolve.');
  add('missing-shapes', stats.missingShapes, 'Drawable sumber tidak menjadi layer output.');
  add('bbox-mismatch', stats.bboxMismatches, 'Bounding box output menyimpang dari geometri sumber.');
  add('gradient-flattened', stats.gradientsFlattened, 'Gradient diratakan menjadi warna solid.');
  add('gradient-stops', stats.gradientStopsReduced, 'Gradient multi-stop dipangkas menjadi dua warna.');
  add('gradient-color-space', stats.gradientColorSpacesUnsupported, 'Interpolasi color-space gradient belum dapat dipertahankan oleh dua endpoint ARGB native.');
  add('gradient-stop-offset', stats.gradientStopOffsetsUnsupported, 'Offset/hard-stop gradient belum dapat dipetakan identik ke endpoint native.');
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
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const conversionStartedAt = now();
  if (typeof svgInput !== 'string' || !svgInput.trim()) throw new Error('SVG kosong.');
  if (!/<svg\b/i.test(svgInput)) throw new Error('Input bukan dokumen SVG yang valid.');

  const options = resolveQualityOptions(rawOptions);
  const preserveFidelity = ['lossless', 'color-group', 'patch-clean'].includes(options.quality);
  const preserveHierarchy = ['lossless', 'patch-clean'].includes(options.quality) && options.groupingMode === 'nested';

  const $ = load(svgInput, { xml: { xmlMode: true, decodeEntities: false } });
  const domParsedAt = now();
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
    unsupportedPaints: 0,
    outOfGamutPaints: 0,
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
    overlapCandidates: 0,
    geometryChecks: 0,
    actualOverlaps: 0,
    touchingPairs: 0,
    unknownOverlapPairs: 0,
    zOrderConstraints: 0,
    optimizedGroupsDropped: 0,
    optimizedGroupsBeforeCap: 0,
    skippedUnsupported: 0,
    unresolvedUses: 0,
    gradientStopsReduced: 0,
    gradientColorSpacesUnsupported: 0,
    gradientStopOffsetsUnsupported: 0,
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
    if (String(style.display || '').toLowerCase() === 'none') return;
    // Visibility inherits, but unlike display:none it can be overridden by a
    // descendant. Walking a hidden container must not discard visible children.
    if (!CONTAINER_TAGS.has(tag) && tag !== 'use' && ['hidden', 'collapse'].includes(String(style.visibility || '').toLowerCase())) return;

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
    const auditPaint = (value, paintColor = currentColor) => {
      const paint = inspectCssColor(value, 1, paintColor);
      if (paint.unsupported) { stats.unsupportedPaints++; warnings.add('Sintaks warna SVG belum didukung; periksa fidelity loss sebelum memakai hasil.'); }
      if (paint.outOfGamut) { stats.outOfGamutPaints++; warnings.add('Warna SVG di luar gamut sRGB XML; exact conversion tidak dapat dijamin.'); }
    };
    const gradId = gradientRef(fillValue);
    if (!gradId) auditPaint(fillValue);
    if (!localIriRef(strokeValue)) auditPaint(strokeValue);
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
        for (const stop of resolvedGradient?.stops || []) auditPaint(stop.color, stop.currentColor);
        if (resolvedGradient?.stops.length === 2) {
          const [firstStop, lastStop] = resolvedGradient.stops;
          if (lastStop.offset <= firstStop.offset || (resolvedGradient.type !== 'linear' && (firstStop.offset !== 0 || lastStop.offset !== 1))) {
            stats.gradientStopOffsetsUnsupported++;
            warnings.add('Offset/hard-stop gradient tidak dapat dipertahankan melalui mapping native yang tersedia.');
          }
        }
        if (resolvedGradient?.stops.some(stop => {
          const paint = String(stop.color).toLowerCase() === 'currentcolor' ? stop.currentColor : stop.color;
          return /\b(?:color|lab|lch|oklab|oklch)\s*\(/i.test(paint) || String(stop.colorInterpolation).toLowerCase() !== 'srgb';
        })) {
          stats.gradientColorSpacesUnsupported++;
          warnings.add('Gradient dengan interpolasi color-space modern/linearRGB belum dapat dijamin identik melalui dua endpoint ARGB Alight Motion.');
        }
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
        // All active engines preserve native gradient paint. Smart Color
        // Groups keeps it as an isolated fallback layer, never as a color key.
        fillColor = gradient.startColor;
      } else {
        const paintNodeTag = String(idNodes.get(gradId)?.name || '').toLowerCase();
        const fallbackPaint = paintFallback(fillValue);
        if (fallbackPaint) auditPaint(fallbackPaint);
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
      rawFillDeclaration: String(fillValue || '').trim().toLowerCase(),
      hasClip: activeClipIds.length > 0,
      hasMask: activeMaskIds.length > 0,
      hasFilter: Boolean(style.filter && style.filter !== 'none'),
      hasMarker: ['marker-start', 'marker-mid', 'marker-end'].some((key) => style[key] && style[key] !== 'none'),
      hasBlendMode: Boolean(
        style['mix-blend-mode'] &&
        !['normal', 'unset', 'initial'].includes(String(style['mix-blend-mode']).toLowerCase())
      ),
      unresolvedPaint: Boolean(gradId && !gradient),
      colorGroupingUnsafe: Boolean(
        activeMaskIds.length ||
        (style.filter && style.filter !== 'none') ||
        (gradId && !gradient) ||
        ['marker-start', 'marker-mid', 'marker-end'].some((key) => style[key] && style[key] !== 'none') ||
        (style['mix-blend-mode'] && !['normal', 'unset', 'initial'].includes(String(style['mix-blend-mode']).toLowerCase()))
      ),
      paintSignature: {
        type: gradient ? 'gradient' : (fillColor ? 'solid' : 'none'),
        effectiveColor: gradient ? null : fillColor,
        alpha: fillColor && String(fillColor).length === 9
          ? Number.parseInt(String(fillColor).slice(1, 3), 16) / 255
          : 0,
        fillRule,
        gradient: gradient ? { type: gradient.type, startColor: gradient.startColor, endColor: gradient.endColor } : null,
        stroke: strokeColor && strokeWidth > 0 ? { color: strokeColor, width: strokeWidth } : null,
        clipCount: activeClipIds.length,
        hasMask: activeMaskIds.length > 0,
        hasFilter: Boolean(style.filter && style.filter !== 'none'),
        blendMode: String(style['mix-blend-mode'] || 'normal').toLowerCase()
      },
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
  const candidatesBuiltAt = now();

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

    if (options.compoundPathMode === 'masks') {
      const maskedShapes = losslessShapes.filter(shape => maskPlanFor(shape));
      stats.contourMaskGroups = maskedShapes.length;
      stats.contourMaskHoles = maskedShapes.reduce(
        (sum, shape) => sum + maskPlanFor(shape).holes.length, 0
      );
      const unsupported = losslessShapes.filter(shape =>
        shape.fillColor && !(shape.strokeColor && shape.strokeWidth > 0) &&
        hasCompoundPath(shape) && !maskPlanFor(shape)
      );
      if (unsupported.length) {
        const error = new Error('Mode contour masks menolak compound path yang topologinya tidak aman: ' +
          unsupported.slice(0, 8).map(shape => shape.sourceLabel).join(', '));
        error.code = 'COMPOUND_MASK_TOPOLOGY_UNSUPPORTED';
        error.shapes = unsupported.map(shape => shape.sourceLabel);
        throw error;
      }
    }
    stats.outputShapes = losslessShapes.length;
    stats.colorGroups = 0;
    stats.mergedShapes = 0;
    stats.missingShapes = Math.max(0, stats.drawableElements - stats.outputShapes);
    if (stats.missingShapes > 0) warnings.add(`${stats.missingShapes} drawable SVG tidak menjadi shape output; cek warnings/skippedUnsupported.`);
    if (stats.bboxMismatches > 0) warnings.add(`${stats.bboxMismatches} shape memiliki bbox output berbeda >0.02 px dari geometri SVG setelah transform.`);

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality, cssRules.issues);
    if (options.requireExact && !fidelity.exact) {
      const codes = fidelity.losses.map((loss) => loss.code).join(', ');
      const error = new Error(`Maximum Fidelity menolak output yang tidak identik. Fitur bermasalah: ${codes}.`);
      error.code = 'FIDELITY_REQUIREMENT_FAILED';
      error.fidelity = fidelity;
      error.warnings = [...warnings];
      throw error;
    }

    const layerXml = buildLosslessLayerXml(
      losslessShapes, width, height, options.duration, options.fps, options.precision, rootOpacity, options.compoundPathMode
    );
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Lossless geometry mode. Native AM schema follows the supplied healthy XML reference. -->`,
      buildSceneOpenTag({ title: options.title, width, height, duration: options.duration, fps: options.fps, modifiedTime: Date.now() }),
      layerXml,
      `</scene>`
    ].join('\n');

    const compatibility = validateAlightImportXml(scene);
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
        details: bboxDetails,
        compatibility
      },
      profile: {
        version: PROVIDER_VERSION,
        quality: 'lossless',
        engine: 'maximum-fidelity',
        alightImportSafe: true,
        compatibilityProfile: ALIGHT_SCHEMA_PROFILE.id,
        groupedByColor: false,
        preservesSourceOrder: true,
        strokesRemoved: false,
        nativeStroke: true,
        nodeReduction: 0,
        precision: 8,
        maxShapes: 'unlimited',
        groupingMode: options.groupingMode,
        detectPrimitives: options.detectPrimitives,
        compoundPathMode: options.compoundPathMode,
        contourMaskGroups: stats.contourMaskGroups || 0,
        contourMaskHoles: stats.contourMaskHoles || 0,
        primitiveOutput: stats.primitiveOutput
      },
      sourceFeatures,
      fidelity
    };
  }


  if (options.quality === 'color-group') {
    const planningStartedAt = now();
    const centerX = width / 2;
    const centerY = height / 2;
    const groups = new Map();
    const fallback = [];
    const sourceRecords = [];
    const fallbackReasons = {};
    const rawDeclarationsByColor = new Map();
    let serializedSources = 0;

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

      const eligibility = analyzeGroupingEligibility(shape);
      outputShape.groupingEligibility = eligibility;
      if (!eligibility.eligible) {
        for (const reason of eligibility.reasonCodes) {
          fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
        }
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
          bounds: shape.bounds,
          scenePath: shape.scenePath,
          fillRule: shape.fillRule,
          geometryTrusted: Boolean(shape.fillColor && !shape.strokeColor && !shape.hasClip && !shape.hasMask)
        });
        continue;
      }

      const colorKey = eligibility.colorKey;
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
      const rawDeclarations = rawDeclarationsByColor.get(colorKey) || new Set();
      rawDeclarations.add(shape.rawFillDeclaration || colorKey);
      rawDeclarationsByColor.set(colorKey, rawDeclarations);
      sourceRecords.push({
        unitKey,
        sourceOrder: shape.sourceOrder,
        bounds: shape.bounds,
        scenePath: shape.scenePath,
        fillRule: shape.fillRule,
        geometryTrusted: true
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
    const planningCompletedAt = now();
    const outputUnits = ordering.ordered;
    stats.zOrderBarriers = ordering.zOrderConflicts;
    stats.overlapCandidates = ordering.overlapCandidates;
    stats.geometryChecks = ordering.geometryChecks;
    stats.actualOverlaps = ordering.actualOverlaps;
    stats.touchingPairs = ordering.touchingPairs;
    stats.unknownOverlapPairs = ordering.unknownPairs;
    stats.zOrderConstraints = ordering.zOrderConstraints;
    stats.colorGroups = colorUnits.length;
    stats.outputShapes = outputUnits.length;
    stats.missingShapes = Math.max(0, stats.drawableElements - serializedSources);

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

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality, cssRules.issues);
    const serializationStartedAt = now();
    const layerXml = buildColorGroupsLayerXml(
      outputUnits, width, height, options.duration, options.fps, options.precision, rootOpacity
    );
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Smart Color Groups v3.0.1: effective paint + topology-aware z-order + fail-closed Alight validation. -->`,
      buildSceneOpenTag({ title: options.title, width, height, duration: options.duration, fps: options.fps, modifiedTime: Date.now() }),
      layerXml,
      `</scene>`
    ].join('\n');

    const compatibility = validateAlightImportXml(scene);
    const conversionCompletedAt = now();
    stats.outputBytes = Buffer.byteLength(scene, 'utf8');

    return {
      xml: scene,
      width,
      height,
      options: { ...options, maxShapes: 'unlimited' },
      stats,
      warnings: [...warnings],
      validation: { compatibility },
      grouping: {
        engine: 'smart-color-groups',
        strategy: 'strict-one-color',
        inputShapes: stats.drawableElements,
        candidateShapes: kept.length,
        serializedSourceShapes: serializedSources,
        missingShapes: stats.missingShapes,
        effectivePaintsResolved: kept.filter((shape) => shape.paintSignature?.type !== 'none').length,
        uniqueRawPaintDeclarations: new Set(kept.map((shape) => shape.rawFillDeclaration).filter(Boolean)).size,
        uniqueEffectiveSolidColors: new Set(
          kept.filter((shape) => shape.paintSignature?.type === 'solid')
            .map((shape) => shape.paintSignature.effectiveColor)
            .filter(Boolean)
        ).size,
        canonicalColorAliases: [...rawDeclarationsByColor.values()]
          .reduce((count, declarations) => count + Math.max(0, declarations.size - 1), 0),
        solidCandidates: [...groups.values()].reduce((count, group) => count + group.shapes.length, 0),
        groupableColors: colorUnits.length,
        complexFallbackPaints: fallback.length,
        groupedColors: colorUnits.length,
        groupedLayers: colorUnits.length,
        fallbackLayers: fallback.length,
        outputLayers: outputUnits.length,
        mergedShapes: stats.mergedShapes,
        packedShapes: stats.mergedShapes,
        safeColorMerges: stats.safeColorMerges,
        geometryMerged: false,
        preservesInternalShapes: true,
        overlapCandidates: ordering.overlapCandidates,
        geometryChecks: ordering.geometryChecks,
        actualOverlaps: ordering.actualOverlaps,
        touchingPairs: ordering.touchingPairs,
        unknownPairs: ordering.unknownPairs,
        zOrderConstraints: ordering.zOrderConstraints,
        overlapConstraints: ordering.zOrderConstraints,
        zOrderBarriers: ordering.zOrderConflicts,
        zOrderConflicts: ordering.zOrderConflicts,
        topologicalOrder: ordering.topological,
        groupingExact: ordering.zOrderConflicts === 0 && stats.missingShapes === 0,
        fallbackReasons,
        ...(options.includeTimings ? {
          timingsMs: {
            parse: Number((domParsedAt - conversionStartedAt).toFixed(3)),
            analysis: Number((candidatesBuiltAt - domParsedAt).toFixed(3)),
            planning: Number((planningCompletedAt - planningStartedAt).toFixed(3)),
            serializationAndValidation: Number((conversionCompletedAt - serializationStartedAt).toFixed(3)),
            total: Number((conversionCompletedAt - conversionStartedAt).toFixed(3))
          }
        } : {})
      },
      profile: {
        version: PROVIDER_VERSION,
        quality: 'color-group',
        alightImportSafe: true,
        compatibilityProfile: ALIGHT_SCHEMA_PROFILE.id,
        engine: 'smart-color-groups',
        strategy: 'strict-one-color',
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

    if (options.compoundPathMode === 'masks') {
      const maskedShapes = cleanedShapes.filter(shape => maskPlanFor(shape));
      stats.contourMaskGroups = maskedShapes.length;
      stats.contourMaskHoles = maskedShapes.reduce(
        (sum, shape) => sum + maskPlanFor(shape).holes.length, 0
      );
      const unsupported = cleanedShapes.filter(shape =>
        shape.fillColor && !(shape.strokeColor && shape.strokeWidth > 0) &&
        hasCompoundPath(shape) && !maskPlanFor(shape)
      );
      if (unsupported.length) {
        const error = new Error('Mode contour masks menolak compound path yang topologinya tidak aman: ' +
          unsupported.slice(0, 8).map(shape => shape.sourceLabel).join(', '));
        error.code = 'COMPOUND_MASK_TOPOLOGY_UNSUPPORTED';
        error.shapes = unsupported.map(shape => shape.sourceLabel);
        throw error;
      }
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

    const fidelity = buildFidelityReport(stats, sourceFeatures, options.quality, cssRules.issues);
    const layerXml = buildLosslessLayerXml(
      cleanedShapes,
      width,
      height,
      options.duration,
      options.fps,
      options.precision,
      rootOpacity,
      options.compoundPathMode
    );
    const scene = [
      `<?xml version='1.0' encoding='UTF-8' ?>`,
      `<!-- Small Patch Cleanup: Maximum Fidelity pipeline with micro-island removal only. -->`,
      buildSceneOpenTag({ title: options.title, width, height, duration: options.duration, fps: options.fps, modifiedTime: Date.now() }),
      layerXml,
      `</scene>`
    ].join('\n');

    const compatibility = validateAlightImportXml(scene);
    stats.outputBytes = Buffer.byteLength(scene, 'utf8');

    return {
      xml: scene,
      width,
      height,
      options: { ...options, maxShapes: 'unlimited' },
      stats,
      warnings: [...warnings],
      validation: { compatibility },
      cleanup: {
        engine: 'small-patch-cleanup',
        compoundPathMode: options.compoundPathMode,
        contourMaskGroups: stats.contourMaskGroups || 0,
        contourMaskHoles: stats.contourMaskHoles || 0,
        patchAreaPercent: options.patchAreaPercent,
        protectThinPercent: options.protectThinPercent,
        thinAspectRatio: PATCH_THIN_ASPECT_RATIO,
        removedSubpaths: stats.microSubpathsRemoved,
        removedShapes: stats.removedMicroShapes,
        removedNodes: stats.microNodesRemoved
      },
      profile: {
        version: PROVIDER_VERSION,
        quality: 'patch-clean',
        engine: 'small-patch-cleanup',
        alightImportSafe: true,
        compatibilityProfile: ALIGHT_SCHEMA_PROFILE.id,
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

import { parse as parseColor, converter, getMode } from 'culori';
import * as css from 'css-tree';

export const INHERITED_STYLE_KEYS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linejoin', 'stroke-linecap', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'color', 'visibility', 'color-interpolation'
];
export const DEFAULT_STYLE = {
  fill: '#000000', 'fill-opacity': '1', 'fill-rule': 'nonzero', stroke: 'none',
  'stroke-opacity': '1', 'stroke-width': '1', 'stroke-linejoin': 'miter',
  'stroke-linecap': 'butt', 'stroke-dasharray': 'none', 'stroke-dashoffset': '0',
  'stroke-miterlimit': '4', color: '#000000', visibility: 'visible',
  'stop-color': '#000000', 'stop-opacity': '1', 'color-interpolation': 'sRGB'
};
const rgb = converter('rgb');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const byte = v => clamp(Math.round(v * 255), 0, 255).toString(16).padStart(2, '0');

export function inspectCssColor(input, opacity = 1, currentColor = '#000000') {
  let raw = String(input ?? '').trim();
  if (!raw || raw.toLowerCase() === 'none') return { color: null, unsupported: false, outOfGamut: false };
  if (raw.toLowerCase() === 'currentcolor') raw = currentColor;
  let parsed;
  try { parsed = raw.length <= 16384 ? parseColor(raw.toLowerCase()) : null; } catch {}
  const prepared = parsed && { ...parsed };
  // Missing CSS Color 4 components are zero outside interpolation. A missing
  // alpha is handled separately, since an omitted alpha defaults to one.
  if (prepared) for (const channel of getMode(prepared.mode).channels) {
    if (channel !== 'alpha' && prepared[channel] === undefined) prepared[channel] = 0;
  }
  const converted = prepared && rgb(prepared);
  if (!converted || ![converted.r, converted.g, converted.b].every(Number.isFinite)) {
    return { color: null, unsupported: true, outOfGamut: false };
  }
  // SVG/XML output has 8-bit sRGB channels. Extended-gamut colors must not be
  // advertised as exact after clipping to that output space.
  const outOfGamut = parsed.mode !== 'rgb' && [converted.r, converted.g, converted.b]
    .some(v => v < -1e-6 || v > 1 + 1e-6);
  const alpha = /\/\s*none\s*\)$/i.test(raw) ? 0 : (converted.alpha ?? 1);
  return {
    color: `#${byte(clamp(alpha * opacity, 0, 1))}${byte(converted.r)}${byte(converted.g)}${byte(converted.b)}`,
    unsupported: false, outOfGamut
  };
}
export const parseCssColor = (input, opacity = 1, currentColor = '#000000') => inspectCssColor(input, opacity, currentColor).color;

function declarations(list, issues) {
  const out = {}, important = new Set();
  for (const node of list) {
    if (node.type !== 'Declaration') { issues?.add('css-declaration'); continue; }
    const key = node.property.startsWith('--') ? css.ident.decode(node.property) : node.property.toLowerCase();
    if (['fill', 'stroke', 'color', 'stop-color'].includes(key) &&
        !/\bvar\s*\(/i.test(css.generate(node.value)) && !css.lexer.matchProperty(key, node.value).matched) {
      // Invalid bare names are ignored by the CSS cascade. Do not mistake a
      // complex legacy/future color function for an ignorable name and silently
      // expose the default black fill instead.
      if (node.value.type === 'Value' && node.value.children.size === 1 && node.value.children.first?.type === 'Identifier') continue;
      issues?.add('css-paint-syntax');
    }
    if (important.has(key) && !node.important) continue;
    out[key] = css.generate(node.value);
    if (node.important) important.add(key); else important.delete(key);
  }
  Object.defineProperty(out, '__important', { value: important });
  return out;
}
function inlineDeclarations(value, issues) {
  if (!value) return declarations([], issues);
  try { return declarations(css.parse(String(value || ''), { context: 'declarationList', parseCustomProperty: true }).children, issues); }
  catch { issues?.add('css-declaration'); return declarations([], issues); }
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function specificity(selector) {
  const total = [0, 0, 0];
  css.walk(selector, {
    enter(node) {
      if (node.type === 'IdSelector') total[0]++;
      else if (node.type === 'ClassSelector' || node.type === 'AttributeSelector') total[1]++;
      else if (node.type === 'TypeSelector' && node.name !== '*') total[2]++;
      else if (node.type === 'PseudoElementSelector') total[2]++;
      else if (node.type === 'PseudoClassSelector') {
        if (node.name === 'where') return this.skip;
        if (['is', 'not', 'has'].includes(node.name)) {
          let maximum = [0, 0, 0];
          node.children?.forEach(child => {
            if (child.type === 'SelectorList') child.children.forEach(s => { const value = specificity(s); if (compare(value, maximum) > 0) maximum = value; });
          });
          for (let i = 0; i < 3; i++) total[i] += maximum[i];
          return this.skip;
        }
        total[1]++;
      }
    }
  });
  return total;
}
const STATIC_PSEUDOS = new Set(['is', 'where', 'not', 'has', 'root', 'empty', 'scope',
  'first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child',
  'first-of-type', 'last-of-type', 'only-of-type', 'nth-of-type', 'nth-last-of-type']);

export function parseCssRules($) {
  const rules = [], issues = new Set();
  rules.issues = issues;
  $('style').each((_, element) => {
    let sheet;
    try { sheet = css.parse($(element).text(), { parseCustomProperty: true }); }
    catch { issues.add('css-stylesheet'); return; }
    for (const rule of sheet.children) {
      if (rule.type === 'Atrule') { issues.add('css-at-rule'); continue; }
      if (rule.type !== 'Rule' || rule.prelude?.type !== 'SelectorList') { issues.add('css-rule'); continue; }
      const values = declarations(rule.block.children, issues);
      for (const selectorNode of rule.prelude.children) {
        let dynamic = false;
        css.walk(selectorNode, node => { if (node.type === 'PseudoClassSelector' && !STATIC_PSEUDOS.has(node.name)) dynamic = true; });
        if (dynamic) { issues.add('css-dynamic-selector'); continue; }
        const selector = css.generate(selectorNode);
        try {
          rules.push({ nodes: new Set($(selector).toArray()), declarations: values,
            specificity: specificity(selectorNode), order: rules.length });
        } catch { issues.add('css-selector'); }
      }
    }
  });
  return rules;
}

function resolveVariables(style, issues) {
  if (!Object.values(style).some(value => /\bvar\s*\(/i.test(String(value)))) return { ...style };
  const asts = new Map(), graph = new Map(), cyclic = new Set(), done = new Set(), path = [];
  const valueAst = text => css.parse(text, { context: 'value', parseCustomProperty: true });
  for (const [key, text] of Object.entries(style)) if (key.startsWith('--')) {
    try {
      const ast = valueAst(text), refs = new Set(); asts.set(key, ast);
      css.walk(ast, node => { if (node.type === 'Function' && node.name.toLowerCase() === 'var') refs.add(css.ident.decode(node.children.first?.name || '')); });
      graph.set(key, refs);
    } catch { asts.set(key, null); }
  }
  function cycles(key) {
    const at = path.indexOf(key);
    if (at >= 0) { for (const name of path.slice(at)) cyclic.add(name); return; }
    if (done.has(key) || !graph.has(key)) return;
    if (path.length >= 32) { cyclic.add(key); issues?.add('css-variable-limit'); return; }
    path.push(key); for (const ref of graph.get(key)) cycles(ref); path.pop(); done.add(key);
  }
  for (const key of graph.keys()) cycles(key);
  const memo = new Map();
  function custom(name, depth) {
    if (memo.has(name)) return memo.get(name);
    if (cyclic.has(name) || !asts.get(name)) return null;
    const value = resolve(style[name], depth + 1); memo.set(name, value); return value;
  }
  function resolve(text, depth = 0) {
    if (depth > 32 || String(text).length > 16384) { issues?.add('css-variable-limit'); return null; }
    if (!/\bvar\s*\(/i.test(String(text))) return text;
    let ast, invalid = false, expandedSize = String(text).length;
    try { ast = valueAst(text); } catch { return null; }
    css.walk(ast, {
      visit: 'Function',
      enter(node, item, list) {
        if (node.name.toLowerCase() !== 'var') return;
        const args = node.children.toArray(), comma = args.findIndex(n => n.type === 'Operator' && n.value === ',');
        const name = args[0]?.type === 'Identifier' ? css.ident.decode(args[0].name) : '';
        let value = name.startsWith('--') ? custom(name, depth) : null;
        if (value == null && comma >= 0) value = resolve(args.slice(comma + 1).map(n => css.generate(n)).join(''), depth + 1);
        if (value == null) { invalid = true; return this.skip; }
        expandedSize += value.length - css.generate(node).length;
        if (expandedSize > 16384) { issues?.add('css-variable-limit'); invalid = true; return this.break; }
        try { list.replace(item, valueAst(value).children); } catch { invalid = true; }
        return this.skip;
      }
    });
    if (invalid) return null;
    const generated = css.generate(ast);
    if (generated.length > 16384) { issues?.add('css-variable-limit'); return null; }
    return generated;
  }
  const out = {};
  for (const [key, value] of Object.entries(style)) out[key] = key.startsWith('--') ? custom(key, 0) : resolve(value);
  return out;
}

export function computedStyle(node, parentStyle = DEFAULT_STYLE, rules = []) {
  const attrs = node.attribs || {}, style = {};
  for (const key of INHERITED_STYLE_KEYS) style[key] = parentStyle?.[key] ?? DEFAULT_STYLE[key];
  for (const [key, value] of Object.entries(parentStyle || {})) if (key.startsWith('--') && value != null) style[key] = value;
  for (const key of [...INHERITED_STYLE_KEYS, 'display', 'opacity', 'clip-path', 'clip-rule', 'mask',
    'vector-effect', 'paint-order', 'filter', 'mix-blend-mode', 'isolation', 'overflow',
    'marker-start', 'marker-mid', 'marker-end', 'stop-color', 'stop-opacity']) if (attrs[key] != null) style[key] = attrs[key];
  const matched = rules.filter(r => r.nodes.has(node)).sort((a, b) => compare(a.specificity, b.specificity) || a.order - b.order);
  const inline = inlineDeclarations(attrs.style, rules.issues);
  for (const declarations of [...matched.map(r => r.declarations), inline]) {
    for (const [key, value] of Object.entries(declarations)) if (!declarations.__important.has(key)) style[key] = value;
  }
  for (const declarations of [...matched.map(r => r.declarations), inline]) {
    for (const key of declarations.__important) style[key] = declarations[key];
  }
  const resolved = resolveVariables(style, rules.issues);
  if (resolved.all != null) rules.issues?.add('css-all');
  if (['transform', 'transform-origin', 'd', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height']
      .some(key => resolved[key] != null)) rules.issues?.add('css-geometry');
  if (['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'stroke-width', 'stroke-dashoffset', 'stroke-miterlimit']
      .some(key => /\b(?:calc|min|max|clamp)\s*\(/i.test(String(resolved[key] || '')))) rules.issues?.add('css-numeric-expression');
  for (const [key, value] of Object.entries(resolved)) {
    if (key.startsWith('--')) continue;
    const keyword = String(value ?? 'unset').trim().toLowerCase();
    if (keyword === 'inherit' || (keyword === 'unset' && INHERITED_STYLE_KEYS.includes(key))) resolved[key] = parentStyle?.[key] ?? DEFAULT_STYLE[key];
    else if (['initial', 'unset'].includes(keyword)) resolved[key] = DEFAULT_STYLE[key];
    else if (['revert', 'revert-layer'].includes(keyword)) { rules.issues?.add('css-cascade-layer'); resolved[key] = DEFAULT_STYLE[key]; }
  }
  if (String(resolved.color).toLowerCase() === 'currentcolor') resolved.color = parentStyle?.color ?? DEFAULT_STYLE.color;
  return resolved;
}

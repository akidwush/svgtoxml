import { DOMParser } from '@xmldom/xmldom';
import svgpath from 'svgpath';

export const PROVIDER_VERSION = '2.3.0';

// This is the single metadata tuple used by the existing generator. Git history
// says it came from a supplied Alight Motion 5.0.273 export, but that original
// full fixture was not committed. Keep the tuple coherent instead of mixing it
// with the independently verified 6.2.53/iOS fixture.
export const ALIGHT_SCHEMA_PROFILE = Object.freeze({
  id: 'alight-5.0.273-android-ff106',
  amver: '1028425',
  ffver: '106',
  am: 'com.alightcreative.motion/5.0.273.1028425',
  amplatform: 'android',
  precompose: 'dynamicResolution',
  rootRetime: 'freeze',
  nestedRetime: 'off',
  retimeAdaptFPS: 'false'
});

const ILLEGAL_XML_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const INVALID_ARTIFACTS = /(?:^|[=\s,"'])(?:NaN|Infinity|undefined|null)(?=$|[\s,"'])/i;
const NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const COLOR_VALUE = /^#[0-9a-f]{8}$/i;
const MAX_LAYER_ID = 2147483647;
const CHECKS = Object.freeze([
  'xml-declaration',
  'xml-utf8',
  'xml-well-formed',
  'single-root-scene',
  'schema-profile',
  'numeric-ranges',
  'timeline-coherence',
  'scoped-layer-ids',
  'embed-scene-structure',
  'shape-property-structure',
  'path-grammar'
]);

function compatibilityError(message, detail = null) {
  const error = new Error(message);
  error.code = 'ALIGHT_XML_COMPATIBILITY_FAILED';
  error.validation = {
    ok: false,
    profile: ALIGHT_SCHEMA_PROFILE.id,
    checks: [...CHECKS],
    detail
  };
  return error;
}

function fail(message, detail) {
  throw compatibilityError(message, detail);
}

function elementChildren(node, tagName = null) {
  const output = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    if (!tagName || child.tagName === tagName) output.push(child);
  }
  return output;
}

function allElements(node, tagName) {
  return Array.from(node.getElementsByTagName(tagName));
}

function requiredAttribute(node, name) {
  if (!node.hasAttribute(name)) fail(`<${node.tagName}> tidak memiliki atribut ${name}.`, { tag: node.tagName, attribute: name });
  return node.getAttribute(name);
}

function finiteAttribute(node, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = requiredAttribute(node, name);
  if (!NUMERIC_VALUE.test(raw)) fail(`Atribut ${name} pada <${node.tagName}> bukan angka valid.`, { tag: node.tagName, attribute: name, value: raw });
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`Atribut ${name} pada <${node.tagName}> berada di luar rentang aman.`, { tag: node.tagName, attribute: name, value: raw });
  }
  return value;
}

function optionalFiniteAttribute(node, name, range) {
  return node.hasAttribute(name) ? finiteAttribute(node, name, range) : null;
}

function hasUnpairedSurrogate(source) {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = source.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function parseXml(source) {
  const errors = [];
  let document;
  try {
    document = new DOMParser({
      onError(level, message) {
        errors.push({ level, message: String(message) });
      }
    }).parseFromString(source, 'application/xml');
  } catch (error) {
    fail('XML tidak well-formed.', { parser: error?.message || String(error) });
  }
  if (errors.length) fail('XML tidak well-formed.', { parser: errors.slice(0, 5) });
  return document;
}

function validateSchema(scene, nested) {
  const expected = ALIGHT_SCHEMA_PROFILE;
  for (const key of ['amver', 'ffver', 'am', 'amplatform', 'precompose']) {
    if (scene.getAttribute(key) !== expected[key]) {
      fail(`Metadata scene ${key} tidak cocok dengan compatibility profile.`, {
        attribute: key,
        expected: expected[key],
        actual: scene.getAttribute(key)
      });
    }
  }
  const expectedRetime = nested ? expected.nestedRetime : expected.rootRetime;
  if (scene.getAttribute('retime') !== expectedRetime) {
    fail('Metadata retime scene tidak konsisten.', { expected: expectedRetime, actual: scene.getAttribute('retime') });
  }
  if (scene.getAttribute('retimeAdaptFPS') !== expected.retimeAdaptFPS) {
    fail('Metadata retimeAdaptFPS scene tidak konsisten.', {
      expected: expected.retimeAdaptFPS,
      actual: scene.getAttribute('retimeAdaptFPS')
    });
  }
}

function validateNumericValue(raw, detail) {
  const values = String(raw || '').split(',').map((value) => value.trim());
  if (!values.length || values.some((value) => !NUMERIC_VALUE.test(value) || !Number.isFinite(Number(value)))) {
    fail('Property numerik Alight Motion malformed.', { ...detail, value: raw });
  }
}

function validateProperties(scene) {
  for (const node of allElements(scene, '*')) {
    if (node.hasAttribute('value')) {
      const tag = String(node.tagName || '');
      const type = String(node.getAttribute('type') || '').toLowerCase();
      const numericTag = ['location', 'scale', 'pivot', 'opacity', 'size'].includes(tag);
      const numericType = ['float', 'int', 'vec2', 'vec3', 'vec4'].includes(type);
      const colorType = tag === 'fillColor' || tag === 'color' || type === 'color';
      if (numericTag || numericType) validateNumericValue(node.getAttribute('value'), { tag, type });
      if (colorType && !COLOR_VALUE.test(node.getAttribute('value'))) {
        fail('Nilai warna Alight Motion malformed.', { tag, value: node.getAttribute('value') });
      }
    }
  }
}

function validatePath(pathNode) {
  const value = requiredAttribute(pathNode, 'd').trim();
  if (!value) fail('Path Alight Motion kosong.');
  if (/[^MmLlHhVvCcSsQqTtAaZzEe0-9+\-.,\s]/.test(value)) {
    fail('Path Alight Motion mengandung token yang tidak diizinkan.', { value: value.slice(0, 160) });
  }
  try {
    const parsed = svgpath(value);
    if (parsed.err) fail('Path Alight Motion malformed.', { parser: parsed.err, value: value.slice(0, 160) });
    parsed.abs().toString();
  } catch (error) {
    if (error?.code === 'ALIGHT_XML_COMPATIBILITY_FAILED') throw error;
    fail('Path Alight Motion malformed.', { parser: error?.message || String(error), value: value.slice(0, 160) });
  }
}

function validateShape(shape, sceneDuration) {
  finiteAttribute(shape, 'id', { min: 1, max: MAX_LAYER_ID, integer: true });
  const start = finiteAttribute(shape, 'startTime', { min: 0, max: sceneDuration, integer: true });
  const end = finiteAttribute(shape, 'endTime', { min: 0, max: sceneDuration, integer: true });
  if (start > end) fail('Timeline shape terbalik.', { id: shape.getAttribute('id'), start, end });
  if (elementChildren(shape, 'transform').length !== 1) {
    fail('Shape harus memiliki tepat satu transform.', { id: shape.getAttribute('id') });
  }
  const paths = elementChildren(shape, 'path');
  const primitive = String(shape.getAttribute('s') || '');
  if (!paths.length && !['.rect', '.circle'].includes(primitive)) {
    fail('Shape tidak memiliki path atau primitive yang dikenal.', { id: shape.getAttribute('id'), primitive });
  }
  paths.forEach(validatePath);
}

function validateScene(scene, { nested = false } = {}) {
  validateSchema(scene, nested);
  const width = finiteAttribute(scene, 'width', { min: 1, max: 32768, integer: true });
  const height = finiteAttribute(scene, 'height', { min: 1, max: 32768, integer: true });
  finiteAttribute(scene, 'exportWidth', { min: 1, max: 32768, integer: true });
  finiteAttribute(scene, 'exportHeight', { min: 1, max: 32768, integer: true });
  const duration = finiteAttribute(scene, 'totalTime', { min: 1, max: 86400000, integer: true });
  finiteAttribute(scene, 'fps', { min: 1, max: 240, integer: true });
  finiteAttribute(scene, 'modifiedTime', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });
  if (!(width > 0 && height > 0)) fail('Dimensi scene tidak valid.');

  const ids = new Set();
  const layers = elementChildren(scene).filter((node) => node.tagName === 'shape' || node.tagName === 'embedScene');
  for (const layer of layers) {
    const id = finiteAttribute(layer, 'id', { min: 1, max: MAX_LAYER_ID, integer: true });
    if (ids.has(id)) fail('ID layer duplikat dalam scene scope yang sama.', { id });
    ids.add(id);
    if (layer.tagName === 'shape') {
      validateShape(layer, duration);
      continue;
    }

    const start = finiteAttribute(layer, 'startTime', { min: 0, max: duration, integer: true });
    const end = finiteAttribute(layer, 'endTime', { min: 0, max: duration, integer: true });
    const outTime = finiteAttribute(layer, 'outTime', { min: 0, max: duration, integer: true });
    if (start > end) fail('Timeline embedScene terbalik.', { id, start, end });
    if (outTime !== end - start) fail('outTime embedScene tidak konsisten dengan timeline.', { id, start, end, outTime });
    const nestedScenes = elementChildren(layer, 'scene');
    if (nestedScenes.length !== 1) fail('embedScene harus memiliki tepat satu nested scene.', { id, nestedScenes: nestedScenes.length });
    const nestedDuration = finiteAttribute(nestedScenes[0], 'totalTime', { min: 1, max: 86400000, integer: true });
    if (nestedDuration !== outTime) fail('Durasi nested scene tidak konsisten dengan outTime wrapper.', { id, nestedDuration, outTime });
    validateScene(nestedScenes[0], { nested: true });
  }

  return { duration, layers: layers.length };
}

export function alightSchemaAttributes({ nested = false } = {}) {
  const profile = ALIGHT_SCHEMA_PROFILE;
  const retime = nested ? profile.nestedRetime : profile.rootRetime;
  return `precompose="${profile.precompose}" amver="${profile.amver}" ffver="${profile.ffver}" am="${profile.am}" amplatform="${profile.amplatform}" retime="${retime}" retimeAdaptFPS="${profile.retimeAdaptFPS}"`;
}

export function validateAlightImportXml(xml) {
  const source = String(xml || '');
  if (!source.startsWith("<?xml version='1.0' encoding='UTF-8' ?>")) {
    fail('XML declaration Alight Motion tidak valid.');
  }
  if (ILLEGAL_XML_CONTROLS.test(source)) fail('XML mengandung control character ilegal.');
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(source)) fail('DOCTYPE atau ENTITY tidak diizinkan pada XML output.');
  if (hasUnpairedSurrogate(source) || Buffer.from(source, 'utf8').toString('utf8') !== source) {
    fail('XML bukan string UTF-8 yang aman.');
  }
  if (INVALID_ARTIFACTS.test(source)) fail('XML mengandung token hasil serialisasi yang invalid.');

  const document = parseXml(source);
  const root = document.documentElement;
  if (!root || root.tagName !== 'scene') fail('Root XML harus tepat satu <scene>.');
  const documentRoots = elementChildren(document);
  if (documentRoots.length !== 1 || documentRoots[0] !== root) fail('XML harus memiliki tepat satu root element.');

  const summary = validateScene(root, { nested: false });
  validateProperties(root);
  const sceneCount = 1 + allElements(root, 'scene').length;
  const pathCount = allElements(root, 'path').length;
  const layerCount = allElements(root, 'shape').length + allElements(root, 'embedScene').length;
  return {
    ok: true,
    profile: ALIGHT_SCHEMA_PROFILE.id,
    providerVersion: PROVIDER_VERSION,
    checks: [...CHECKS],
    rootDuration: summary.duration,
    sceneCount,
    layerCount,
    pathCount
  };
}

export function inspectAlightXmlStructure(xml) {
  const source = String(xml || '');
  if (ILLEGAL_XML_CONTROLS.test(source) || hasUnpairedSurrogate(source)) {
    fail('XML reference mengandung karakter yang tidak valid.');
  }
  const document = parseXml(source);
  const root = document.documentElement;
  if (!root || root.tagName !== 'scene') fail('XML reference tidak memiliki root scene.');

  const scenes = [root, ...allElements(root, 'scene')];
  const embeds = allElements(root, 'embedScene');
  const shapes = allElements(root, 'shape');
  const paths = allElements(root, 'path');
  const scopedDuplicateIds = [];
  const globalIds = [];

  scenes.forEach((scene, sceneIndex) => {
    const ids = new Set();
    const directLayers = elementChildren(scene).filter((node) => node.tagName === 'shape' || node.tagName === 'embedScene');
    directLayers.forEach((layer) => {
      const id = String(layer.getAttribute('id') || '');
      if (id && ids.has(id)) scopedDuplicateIds.push({ sceneIndex, id });
      if (id) {
        ids.add(id);
        globalIds.push(id);
      }
    });
  });

  const profileTuples = [...new Set(scenes.map((scene) => [
    scene.getAttribute('amver'),
    scene.getAttribute('ffver'),
    scene.getAttribute('am'),
    scene.getAttribute('amplatform')
  ].join('|')))];

  return {
    root: root.tagName,
    declaration: source.startsWith("<?xml version='1.0' encoding='UTF-8' ?>"),
    profileTuples,
    sceneCount: scenes.length,
    embedSceneCount: embeds.length,
    embedSceneMissingOutTime: embeds.filter((node) => !node.hasAttribute('outTime')).length,
    shapeCount: shapes.length,
    nativePrimitiveCount: shapes.filter((node) => ['.rect', '.circle'].includes(node.getAttribute('s'))).length,
    pathCount: paths.length,
    pathStrokeCount: allElements(root, 'path-stroke').length,
    scopedDuplicateIds,
    globalDuplicateIds: globalIds.length - new Set(globalIds).size,
    nestedMetadataConsistent: profileTuples.length === 1
  };
}

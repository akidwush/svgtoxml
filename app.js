const $ = (id) => document.getElementById(id);

const fileInput = $('svgFile');
const fileName = $('fileName');
const fileMeta = $('fileMeta');
const fileCard = $('fileCard');
const svgPreview = $('svgPreview');
const svgPreviewFallback = $('svgPreviewFallback');
const removeFileBtn = $('removeFile');
const sourceState = $('sourceState');

const convertBtn = $('convertBtn');
const convertLabel = $('convertLabel');
const status = $('status');
const resultCard = $('resultCard');
const xmlOutput = $('xmlOutput');
const statsEl = $('stats');
const warningsEl = $('warnings');
const downloadBtn = $('downloadBtn');

const quality = $('quality');
const modeGrid = $('modeGrid');
const modeBadge = $('modeBadge');
const advancedSummary = $('advancedSummary');

let lastXml = '';
let lastBaseName = 'alight-motion';
let selectedSvgText = '';
let selectedFileSignature = '';
let fileReadPromise = null;
let previewUrl = '';

const PRESETS = {
  lossless: {
    label: 'LOSSLESS',
    maxShapes: 5000,
    minAreaPercent: 0,
    precision: 8,
    nodeReduction: 0
  },
  accurate: {
    label: 'ACCURATE · -35%',
    maxShapes: 5000,
    minAreaPercent: 0,
    precision: 5,
    nodeReduction: 35
  },
  balanced: {
    label: 'BALANCED · -50%',
    maxShapes: 2500,
    minAreaPercent: 0.0002,
    precision: 4,
    nodeReduction: 50
  },
  lightweight: {
    label: 'LIGHT · -65%',
    maxShapes: 1000,
    minAreaPercent: 0.001,
    precision: 3,
    nodeReduction: 65
  }
};

function applyPreset(name) {
  const preset = PRESETS[name] || PRESETS.lossless;
  const isLossless = name === 'lossless';

  quality.value = name;

  $('maxShapes').value = preset.maxShapes;
  $('minArea').value = preset.minAreaPercent;
  $('precision').value = preset.precision;
  $('nodeReduction').value = preset.nodeReduction;

  for (const id of ['maxShapes', 'minArea', 'precision', 'nodeReduction']) {
    $(id).disabled = isLossless;
  }

  const note = $('losslessNote');
  if (note) note.classList.toggle('hidden', !isLossless);

  modeBadge.textContent = preset.label;
  advancedSummary.textContent = isLossless
    ? 'Dikunci oleh profil Lossless'
    : `Node -${preset.nodeReduction}% · bisa dituning manual`;

  modeGrid.querySelectorAll('[data-quality]').forEach((button) => {
    const active = button.dataset.quality === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

modeGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-quality]');
  if (!button || convertBtn.disabled && !selectedSvgText) return;
  applyPreset(button.dataset.quality);
});

quality.addEventListener('change', () => applyPreset(quality.value));
applyPreset(quality.value);

function fileSignature(file) {
  if (!file) return '';
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function readFileAsText(file) {
  if (!file) return Promise.reject(new Error('File SVG tidak tersedia.'));

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('File SVG tidak dapat dibaca.'));
    reader.onabort = () => reject(new Error('Pembacaan file SVG dibatalkan.'));
    reader.readAsText(file);
  });
}

function analyzeSvgText(text) {
  const paths = (text.match(/<path\b/gi) || []).length;
  const shapes = (text.match(/<(?:path|rect|circle|ellipse|line|polygon|polyline)\b/gi) || []).length;
  const gradients = (text.match(/<(?:linearGradient|radialGradient)\b/gi) || []).length;
  const clips = (text.match(/<(?:clipPath|mask)\b/gi) || []).length;
  return `${shapes} shape · ${paths} path · ${gradients} gradient · ${clips} clip/mask`;
}

function revokePreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
}

function renderSvgPreview(text) {
  revokePreview();

  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  previewUrl = URL.createObjectURL(blob);

  svgPreviewFallback.hidden = true;
  svgPreview.hidden = false;
  svgPreview.src = previewUrl;

  svgPreview.onerror = () => {
    svgPreview.hidden = true;
    svgPreviewFallback.hidden = false;
  };
}

function setSourceState(kind, text) {
  sourceState.textContent = text;
  sourceState.className = `state-pill ${kind}`;
}

function clearFile() {
  revokePreview();
  selectedSvgText = '';
  selectedFileSignature = '';
  fileReadPromise = null;
  lastXml = '';
  fileInput.value = '';
  fileName.textContent = 'Belum ada file';
  fileMeta.textContent = '';
  fileCard.classList.add('hidden');
  resultCard.classList.add('hidden');
  convertBtn.disabled = true;
  convertLabel.textContent = 'Konversi ke Alight XML';
  status.textContent = 'Pilih file SVG untuk memulai.';
  setSourceState('state-idle', 'MENUNGGU');
}

removeFileBtn.addEventListener('click', clearFile);

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];

  selectedSvgText = '';
  selectedFileSignature = '';
  fileReadPromise = null;
  lastXml = '';
  resultCard.classList.add('hidden');
  revokePreview();

  if (!file) {
    clearFile();
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    fileInput.value = '';
    status.textContent = 'File terlalu besar. Maksimal 2 MB.';
    setSourceState('state-error', 'TERLALU BESAR');
    return;
  }

  lastBaseName = file.name.replace(/\.svg$/i, '') || 'alight-motion';
  const signature = fileSignature(file);

  fileName.textContent = file.name;
  fileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB · membaca SVG…`;
  fileCard.classList.remove('hidden');
  convertBtn.disabled = true;
  convertLabel.textContent = 'Menyiapkan SVG…';
  status.textContent = 'Membaca file SVG dan membuat thumbnail…';
  setSourceState('state-idle', 'MEMBACA');

  fileReadPromise = readFileAsText(file)
    .then((text) => {
      if (!text.trim().startsWith('<') || !/<svg\b/i.test(text)) {
        throw new Error('Isi file tidak terlihat seperti SVG yang valid.');
      }

      selectedSvgText = text;
      selectedFileSignature = signature;
      fileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB · ${analyzeSvgText(text)}`;

      renderSvgPreview(text);

      status.textContent = 'SVG siap. Pilih mode lalu konversi.';
      setSourceState('state-ready', 'SIAP');
      convertLabel.textContent = 'Konversi ke Alight XML';
      convertBtn.disabled = false;
      return text;
    })
    .catch((error) => {
      selectedSvgText = '';
      selectedFileSignature = '';
      fileMeta.textContent = 'File gagal dibaca';
      status.textContent = `Gagal membaca SVG: ${error.message}. Pilih ulang file SVG.`;
      setSourceState('state-error', 'ERROR');
      convertLabel.textContent = 'Konversi ke Alight XML';
      convertBtn.disabled = true;
      throw error;
    });
});

function stat(label, value) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}

convertBtn.addEventListener('click', async () => {
  if (!selectedSvgText) return;

  convertBtn.disabled = true;
  convertLabel.textContent = 'Mengonversi…';
  status.textContent = `Mengonversi dengan ${PRESETS[quality.value]?.label || quality.value}…`;
  resultCard.classList.add('hidden');

  try {
    const file = fileInput.files?.[0];
    const signature = fileSignature(file);

    if (fileReadPromise && !selectedSvgText) {
      try { await fileReadPromise; } catch {}
    }

    if (!selectedSvgText || (signature && selectedFileSignature && signature !== selectedFileSignature)) {
      if (!file) throw new Error('Pilih SVG terlebih dahulu.');

      const text = await readFileAsText(file);
      selectedSvgText = text;
      selectedFileSignature = signature;
    }

    const svg = selectedSvgText;
    if (!svg) {
      throw new Error('SVG belum tersimpan di memori. Pilih ulang file SVG lalu coba lagi.');
    }

    const response = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        svg,
        options: {
          title: lastBaseName,
          quality: quality.value,
          maxShapes: Number($('maxShapes').value),
          minAreaPercent: Number($('minArea').value),
          precision: Number($('precision').value),
          nodeReduction: Number($('nodeReduction').value),
          groupByColor: quality.value !== 'lossless',
          removeStrokes: quality.value !== 'lossless',
          validateBounds: quality.value === 'lossless'
        }
      })
    });

    const rawResponse = await response.text();
    let data = {};
    try {
      data = rawResponse ? JSON.parse(rawResponse) : {};
    } catch {}

    if (!response.ok || !data.ok) {
      const serverMessage = data.error || rawResponse.trim();
      const code = data.code ? ` [${data.code}]` : '';
      const detail = data.detail ? ` — ${data.detail}` : '';
      throw new Error(`${serverMessage || `HTTP ${response.status}`}${code}${detail}`);
    }

    lastXml = data.xml;
    xmlOutput.value = data.xml;

    const isLossless = data.profile?.quality === 'lossless';

    statsEl.innerHTML = isLossless
      ? [
          stat('Shape output', data.stats.outputShapes ?? 0),
          stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
          stat('Stroke native', data.stats.strokes ?? 0),
          stat('BBox mismatch', data.stats.bboxMismatches ?? 0),
          stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
        ].join('')
      : [
          stat('Group warna', data.stats.colorGroups ?? data.stats.outputShapes),
          stat('Shape digabung', data.stats.mergedShapes ?? 0),
          stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
          stat('Stroke dihapus', data.stats.strokesRemoved ?? 0),
          stat('Fallback reducer', data.stats.nodeReductionFallbackShapes ?? 0),
          stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
        ].join('');

    warningsEl.innerHTML = (data.warnings || []).map((warning) => `⚠ ${warning}`).join('<br>');

    $('resultTitle').textContent = isLossless
      ? `${data.width}×${data.height} · ${data.stats.outputShapes} shape · Lossless`
      : `${data.width}×${data.height} · ${data.stats.colorGroups ?? data.stats.outputShapes} group warna · ${data.profile?.quality || quality.value}`;

    resultCard.classList.remove('hidden');

    if (isLossless) {
      status.textContent = `Selesai · ${data.stats.outputShapes} shape · node 0% · stroke dipertahankan · z-order asli.`;
    } else {
      const reduced = Math.max(0, (data.stats.nodesBefore || 0) - (data.stats.nodesAfter || 0));
      status.textContent = `Selesai · ${data.stats.colorGroups ?? data.stats.outputShapes} group warna · ${reduced} node dikurangi.`;
    }

    requestAnimationFrame(() => {
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (error) {
    status.textContent = `Gagal: ${error.message}`;
  } finally {
    convertBtn.disabled = !selectedSvgText;
    convertLabel.textContent = 'Konversi ke Alight XML';
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastXml) return;

  const blob = new Blob([lastXml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = `${lastBaseName}-alight.xml`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

window.addEventListener('beforeunload', revokePreview);

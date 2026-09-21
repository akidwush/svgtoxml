const $ = (id) => document.getElementById(id);
const fileInput = $('svgFile');
const fileName = $('fileName');
const fileMeta = $('fileMeta');
const convertBtn = $('convertBtn');
const status = $('status');
const resultCard = $('resultCard');
const xmlOutput = $('xmlOutput');
const statsEl = $('stats');
const warningsEl = $('warnings');
const downloadBtn = $('downloadBtn');
const quality = $('quality');

let lastXml = '';
let lastBaseName = 'alight-motion';
let selectedSvgText = '';
let selectedFileSignature = '';
let fileReadPromise = null;

const PRESETS = {
  lossless: { patchAreaPercent: 0.01, protectThinPercent: 2.0 },
  'color-group': { patchAreaPercent: 0.01, protectThinPercent: 2.0 },
  'patch-clean': { patchAreaPercent: 0.01, protectThinPercent: 2.0 }
};

function applyPreset(name) {
  const preset = PRESETS[name] || PRESETS.lossless;
  const patchMode = name === 'patch-clean';
  const colorMode = name === 'color-group';
  $('patchAreaPercent').value = preset.patchAreaPercent;
  $('protectThinPercent').value = preset.protectThinPercent;
  $('patchAreaPercent').disabled = !patchMode;
  $('protectThinPercent').disabled = !patchMode;
  $('losslessNote').classList.toggle('hidden', patchMode || colorMode);
  $('colorGroupNote').classList.toggle('hidden', !colorMode);
  $('patchNote').classList.toggle('hidden', !patchMode);
}

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
  const vectors = (text.match(/<(?:path|rect|circle|ellipse|line|polyline|polygon)\b/gi) || []).length;
  const gradients = (text.match(/<(?:linearGradient|radialGradient)\b/gi) || []).length;
  const clips = (text.match(/<(?:clipPath|mask)\b/gi) || []).length;
  return `${vectors} vector · ${gradients} gradient · ${clips} clip/mask`;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileName.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : 'Belum ada file';
  fileMeta.textContent = '';
  selectedSvgText = '';
  selectedFileSignature = '';
  fileReadPromise = null;
  lastXml = '';
  resultCard.classList.add('hidden');

  if (!file) {
    status.textContent = '';
    return;
  }

  lastBaseName = file.name.replace(/\.svg$/i, '') || 'alight-motion';
  const signature = fileSignature(file);
  convertBtn.disabled = true;
  fileMeta.textContent = 'Membaca SVG…';
  status.textContent = 'Menyiapkan file SVG…';

  fileReadPromise = readFileAsText(file)
    .then((text) => {
      if (!text.trim().startsWith('<') || !/<svg\b/i.test(text)) {
        throw new Error('Isi file tidak terlihat seperti SVG yang valid.');
      }
      selectedSvgText = text;
      selectedFileSignature = signature;
      fileMeta.textContent = analyzeSvgText(text);
      status.textContent = 'SVG siap dikonversi.';
      return text;
    })
    .catch((error) => {
      selectedSvgText = '';
      selectedFileSignature = '';
      fileMeta.textContent = 'File gagal dibaca';
      status.textContent = `Gagal membaca SVG: ${error.message}. Pilih ulang file SVG.`;
      return '';
    })
    .finally(() => {
      convertBtn.disabled = false;
    });
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stat(label, value) {
  return `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
}

convertBtn.addEventListener('click', async () => {
  convertBtn.disabled = true;
  status.textContent = `Mengonversi dengan ${quality.options[quality.selectedIndex].text}…`;
  resultCard.classList.add('hidden');

  try {
    const file = fileInput.files?.[0];
    const signature = fileSignature(file);

    if (fileReadPromise && !selectedSvgText) await fileReadPromise;

    if (!selectedSvgText || (signature && selectedFileSignature && signature !== selectedFileSignature)) {
      if (!file) throw new Error('Pilih SVG terlebih dahulu.');
      selectedSvgText = await readFileAsText(file);
      selectedFileSignature = signature;
    }

    if (!selectedSvgText) throw new Error('SVG belum tersimpan di memori. Pilih ulang file SVG lalu coba lagi.');

    const response = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        svg: selectedSvgText,
        options: {
          title: lastBaseName,
          quality: quality.value,
          patchAreaPercent: Number($('patchAreaPercent').value),
          protectThinPercent: Number($('protectThinPercent').value),
          validateBounds: quality.value === 'lossless',
          requireExact: quality.value === 'lossless'
        }
      })
    });

    const rawResponse = await response.text();
    let data = {};
    try { data = rawResponse ? JSON.parse(rawResponse) : {}; } catch {}

    if (!response.ok || !data.ok) {
      const serverMessage = data.error || rawResponse.trim();
      const code = data.code ? ` [${data.code}]` : '';
      const losses = data.fidelity?.losses?.length
        ? ` — loss: ${data.fidelity.losses.map((loss) => loss.code).join(', ')}`
        : '';
      throw new Error(`${serverMessage || `HTTP ${response.status}`}${code}${losses}`);
    }

    lastXml = data.xml;
    xmlOutput.value = data.xml;

    const patchMode = data.profile?.quality === 'patch-clean';
    const colorMode = data.profile?.quality === 'color-group';
    const fidelityExact = data.fidelity?.exact === true;
    const fidelityLosses = data.fidelity?.losses?.length || 0;

    statsEl.innerHTML = patchMode ? [
      stat('Shape output', data.stats.outputShapes ?? 0),
      stat('Patch/subpath dibuang', data.cleanup?.removedSubpaths ?? 0),
      stat('Shape mikro dibuang', data.cleanup?.removedShapes ?? 0),
      stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
      stat('Stroke native', data.stats.strokes ?? 0),
      stat('Ukuran XML', `${((data.stats.outputBytes || 0) / 1024).toFixed(1)} KB`)
    ].join('') : colorMode ? [
      stat('Shape sumber', data.grouping?.inputShapes ?? 0),
      stat('Warna digrup', data.grouping?.groupedColors ?? 0),
      stat('Layer output', data.grouping?.outputLayers ?? data.stats.outputShapes ?? 0),
      stat('Shape digabung', data.grouping?.mergedShapes ?? 0),
      stat('Fallback kompleks', data.grouping?.fallbackLayers ?? 0),
      stat('Z-order barrier', data.grouping?.zOrderBarriers ?? 0),
      stat('Ukuran XML', `${((data.stats.outputBytes || 0) / 1024).toFixed(1)} KB`)
    ].join('') : [
      stat('Shape output', data.stats.outputShapes ?? 0),
      stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
      stat('Stroke native', data.stats.strokes ?? 0),
      stat('clipPath mask', data.stats.clipPathsApplied ?? 0),
      stat('BBox mismatch', data.stats.bboxMismatches ?? 0),
      stat('Audit fidelity', fidelityExact ? 'Tanpa loss' : `${fidelityLosses} loss`),
      stat('Ukuran XML', `${((data.stats.outputBytes || 0) / 1024).toFixed(1)} KB`)
    ].join('');

    const fidelityMessage = !patchMode
      ? [fidelityExact
          ? '✓ Audit fidelity: tidak ada kehilangan fitur yang diketahui.'
          : `⚠ Audit fidelity menemukan ${fidelityLosses} jenis perbedaan.`]
      : [];

    warningsEl.innerHTML = [...fidelityMessage, ...(data.warnings || []).map((w) => `⚠ ${w}`)]
      .map(escapeHtml)
      .join('<br>');

    $('resultTitle').textContent = patchMode
      ? `${data.width}×${data.height} · ${data.stats.outputShapes} shape · Small Patch Cleanup`
      : colorMode
        ? `${data.width}×${data.height} · ${data.grouping?.groupedColors || 0} warna · Color Groups`
        : `${data.width}×${data.height} · ${data.stats.outputShapes} shape · Maximum Fidelity`;

    resultCard.classList.remove('hidden');

    if (patchMode) {
      status.textContent = `Selesai · ${data.cleanup?.removedSubpaths || 0} subpath kecil + ${data.cleanup?.removedShapes || 0} shape mikro dibuang · z-order/stroke tetap dipertahankan.`;
    } else if (colorMode) {
      status.textContent = `Selesai · ${data.grouping?.inputShapes || 0} shape → ${data.grouping?.outputLayers || 0} layer · ${data.grouping?.groupedColors || 0} warna digrup.`;
    } else {
      status.textContent = `Selesai · ${data.stats.outputShapes} shape · Maximum Fidelity strict.`;
    }
  } catch (error) {
    status.textContent = `Gagal: ${error.message}`;
  } finally {
    convertBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastXml) return;
  const blob = new Blob([lastXml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${lastBaseName}-alight.xml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

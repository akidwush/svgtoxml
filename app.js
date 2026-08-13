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
  optimized: { maxShapes: 3000, minAreaPercent: 0.0004, precision: 4, nodeReduction: 38, microDetailPercent: 0.0015, maxOutputGroups: 320 },
  lossless: { maxShapes: 5000, minAreaPercent: 0, precision: 8, nodeReduction: 0, microDetailPercent: 0, maxOutputGroups: 1200 },
  accurate: { maxShapes: 5000, minAreaPercent: 0, precision: 5, nodeReduction: 35, microDetailPercent: 0, maxOutputGroups: 1200 },
  balanced: { maxShapes: 2500, minAreaPercent: 0.0002, precision: 4, nodeReduction: 50, microDetailPercent: 0, maxOutputGroups: 1200 },
  lightweight: { maxShapes: 1000, minAreaPercent: 0.001, precision: 3, nodeReduction: 65, microDetailPercent: 0, maxOutputGroups: 1200 }
};

function applyPreset(name) {
  const p = PRESETS[name] || PRESETS.optimized;
  const isLossless = name === 'lossless';
  const isOptimized = name === 'optimized';
  $('maxShapes').value = p.maxShapes;
  $('minArea').value = p.minAreaPercent;
  $('precision').value = p.precision;
  $('nodeReduction').value = p.nodeReduction;
  $('microDetailPercent').value = p.microDetailPercent ?? 0;
  $('maxOutputGroups').value = p.maxOutputGroups ?? 1200;
  for (const id of ['maxShapes', 'minArea', 'precision', 'nodeReduction']) $(id).disabled = isLossless;
  $('microDetailPercent').disabled = !isOptimized;
  $('maxOutputGroups').disabled = !isOptimized;
  const note = $('losslessNote');
  if (note) note.classList.toggle('hidden', !isLossless);
  const optimizedNote = $('optimizedNote');
  if (optimizedNote) optimizedNote.classList.toggle('hidden', !isOptimized);
}

quality.addEventListener('change', () => applyPreset(quality.value));
applyPreset(quality.value);

function fileSignature(file) {
  if (!file) return '';
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function readFileAsText(file) {
  if (!file) return Promise.reject(new Error('File SVG tidak tersedia.'));
  // Android/Chrome can revoke the underlying file reference after the picker
  // closes. Read it immediately and keep the SVG source in memory instead of
  // calling file.text() again when the user presses Convert.
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
  const gradients = (text.match(/<(?:linearGradient|radialGradient)\b/gi) || []).length;
  const clips = (text.match(/<(?:clipPath|mask)\b/gi) || []).length;
  return `${paths} path · ${gradients} gradient · ${clips} clip/mask`;
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileName.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : 'Belum ada file';
  fileMeta.textContent = '';
  selectedSvgText = '';
  selectedFileSignature = '';
  fileReadPromise = null;
  lastXml = '';
  resultCard.classList.add('hidden');

  if (!f) {
    status.textContent = '';
    return;
  }

  lastBaseName = f.name.replace(/\.svg$/i, '') || 'alight-motion';
  const signature = fileSignature(f);
  convertBtn.disabled = true;
  fileMeta.textContent = 'Membaca SVG…';
  status.textContent = 'Menyiapkan file SVG…';

  fileReadPromise = readFileAsText(f)
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
    .catch((err) => {
      selectedSvgText = '';
      selectedFileSignature = '';
      fileMeta.textContent = 'File gagal dibaca';
      status.textContent = `Gagal membaca SVG: ${err.message}. Pilih ulang file SVG.`;
      throw err;
    })
    .finally(() => {
      convertBtn.disabled = false;
    });
});

function stat(label, value) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}

convertBtn.addEventListener('click', async () => {
  convertBtn.disabled = true;
  status.textContent = `Mengonversi dengan mode ${quality.options[quality.selectedIndex].text}…`;
  resultCard.classList.add('hidden');
  try {
    const file = fileInput.files?.[0];
    const signature = fileSignature(file);

    // Prefer the source cached immediately after file selection. This avoids
    // Android's NotReadableError caused by re-reading a stale File reference.
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
          microDetailPercent: Number($('microDetailPercent').value),
          maxOutputGroups: Number($('maxOutputGroups').value),
          groupByColor: quality.value !== 'lossless',
          removeStrokes: !['lossless', 'optimized'].includes(quality.value),
          validateBounds: quality.value === 'lossless'
        }
      })
    });
    const rawResponse = await response.text();
    let data = {};
    try { data = rawResponse ? JSON.parse(rawResponse) : {}; } catch {}

    if (!response.ok || !data.ok) {
      const serverMessage = data.error || rawResponse.trim();
      const code = data.code ? ` [${data.code}]` : '';
      const detail = data.detail ? ` — ${data.detail}` : '';
      throw new Error(`${serverMessage || `HTTP ${response.status}`}${code}${detail}`);
    }

    lastXml = data.xml;
    xmlOutput.value = data.xml;
    const isLossless = data.profile?.quality === 'lossless';
    const isOptimized = data.profile?.quality === 'optimized';
    statsEl.innerHTML = isLossless ? [
      stat('Shape output', data.stats.outputShapes ?? 0),
      stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
      stat('Stroke native', data.stats.strokes ?? 0),
      stat('BBox mismatch', data.stats.bboxMismatches ?? 0),
      stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
    ].join('') : isOptimized ? [
      stat('Layer output', data.stats.outputShapes ?? 0),
      stat('Safe merge', data.stats.safeColorMerges ?? 0),
      stat('Titik mikro dibuang', data.stats.microSubpathsRemoved ?? 0),
      stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
      stat('Z-order barrier', data.stats.zOrderBarriers ?? 0),
      stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
    ].join('') : [
      stat('Group warna', data.stats.colorGroups ?? data.stats.outputShapes),
      stat('Shape digabung', data.stats.mergedShapes ?? 0),
      stat('Node', `${data.stats.nodesBefore ?? 0} → ${data.stats.nodesAfter ?? 0}`),
      stat('Stroke dihapus', data.stats.strokesRemoved ?? 0),
      stat('Fallback reducer', data.stats.nodeReductionFallbackShapes ?? 0),
      stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
    ].join('');
    warningsEl.innerHTML = (data.warnings || []).map((w) => `⚠ ${w}`).join('<br>');
    $('resultTitle').textContent = isLossless
      ? `${data.width}×${data.height} · ${data.stats.outputShapes} shape · Lossless`
      : isOptimized
        ? `${data.width}×${data.height} · ${data.stats.outputShapes} layer · AM Optimized`
        : `${data.width}×${data.height} · ${data.stats.colorGroups ?? data.stats.outputShapes} group warna · ${data.profile?.quality || quality.value}`;
    resultCard.classList.remove('hidden');
    if (isLossless) {
      status.textContent = `Selesai · ${data.stats.outputShapes} shape · node 0% reduction · stroke dipertahankan · z-order asli.`;
    } else if (isOptimized) {
      const reduced = Math.max(0, (data.stats.nodesBefore || 0) - (data.stats.nodesAfter || 0));
      status.textContent = `Selesai · ${data.stats.outputShapes} layer · ${data.stats.microSubpathsRemoved || 0} titik/subpath mikro dibuang · ${reduced} node dikurangi.`;
    } else {
      const reduced = Math.max(0, (data.stats.nodesBefore || 0) - (data.stats.nodesAfter || 0));
      status.textContent = `Selesai · ${data.stats.colorGroups ?? data.stats.outputShapes} group warna · ${reduced} node dikurangi · stroke dihapus.`;
    }
  } catch (err) {
    status.textContent = `Gagal: ${err.message}`;
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

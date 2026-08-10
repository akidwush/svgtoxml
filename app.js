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

const PRESETS = {
  accurate: { maxShapes: 2500, minAreaPercent: 0, precision: 5 },
  balanced: { maxShapes: 700, minAreaPercent: 0.001, precision: 4 },
  lightweight: { maxShapes: 180, minAreaPercent: 0.003, precision: 3 }
};

function applyPreset(name) {
  const p = PRESETS[name] || PRESETS.accurate;
  $('maxShapes').value = p.maxShapes;
  $('minArea').value = p.minAreaPercent;
  $('precision').value = p.precision;
}

quality.addEventListener('change', () => applyPreset(quality.value));
applyPreset('accurate');

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  fileName.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : 'Belum ada file';
  fileMeta.textContent = '';
  if (!f) return;
  lastBaseName = f.name.replace(/\.svg$/i, '') || 'alight-motion';
  try {
    const text = await f.text();
    const paths = (text.match(/<path\b/gi) || []).length;
    const gradients = (text.match(/<(?:linearGradient|radialGradient)\b/gi) || []).length;
    const clips = (text.match(/<(?:clipPath|mask)\b/gi) || []).length;
    fileMeta.textContent = `${paths} path · ${gradients} gradient · ${clips} clip/mask`;
  } catch {}
});

function stat(label, value) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}

convertBtn.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) {
    status.textContent = 'Pilih SVG terlebih dahulu.';
    return;
  }
  convertBtn.disabled = true;
  status.textContent = `Mengonversi dengan mode ${quality.options[quality.selectedIndex].text}…`;
  resultCard.classList.add('hidden');
  try {
    const svg = await file.text();
    const response = await fetch('/api/v1/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        svg,
        options: {
          title: lastBaseName,
          quality: quality.value,
          maxShapes: Number($('maxShapes').value),
          minAreaPercent: Number($('minArea').value),
          precision: Number($('precision').value)
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
    const removed = (data.stats.removedTiny || 0) + (data.stats.removedByLimit || 0);
    statsEl.innerHTML = [
      stat('Shape output', data.stats.outputShapes),
      stat('Shape dibuang', removed),
      stat('Gradient', data.stats.gradients),
      stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
    ].join('');
    warningsEl.innerHTML = (data.warnings || []).map((w) => `⚠ ${w}`).join('<br>');
    $('resultTitle').textContent = `${data.width}×${data.height} · ${data.stats.outputShapes} shape · ${data.profile?.quality || quality.value}`;
    resultCard.classList.remove('hidden');
    status.textContent = removed
      ? `Selesai, tetapi ${removed} shape dibuang oleh pengaturan saat ini.`
      : 'Selesai tanpa membuang shape karena filter/limit.';
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

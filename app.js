const $ = (id) => document.getElementById(id);
const fileInput = $('svgFile');
const fileName = $('fileName');
const convertBtn = $('convertBtn');
const status = $('status');
const resultCard = $('resultCard');
const xmlOutput = $('xmlOutput');
const statsEl = $('stats');
const warningsEl = $('warnings');
const downloadBtn = $('downloadBtn');
let lastXml = '';
let lastBaseName = 'alight-motion';

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileName.textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(1)} KB` : 'Belum ada file';
  if (f) lastBaseName = f.name.replace(/\.svg$/i, '') || 'alight-motion';
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
  status.textContent = 'Membaca SVG dan mengonversi…';
  resultCard.classList.add('hidden');
  try {
    const svg = await file.text();
    const headers = { 'content-type': 'application/json' };
    const key = $('apiKey').value.trim();
    if (key) headers['x-api-key'] = key;
    const response = await fetch('/api/convert', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        svg,
        options: {
          title: lastBaseName,
          maxShapes: Number($('maxShapes').value),
          minAreaPercent: Number($('minArea').value),
          precision: Number($('precision').value)
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    lastXml = data.xml;
    xmlOutput.value = data.xml;
    statsEl.innerHTML = [
      stat('Shape output', data.stats.outputShapes),
      stat('Detail dibuang', data.stats.removedTiny + data.stats.removedByLimit),
      stat('Gradient', data.stats.gradients),
      stat('Ukuran XML', `${(data.stats.outputBytes / 1024).toFixed(1)} KB`)
    ].join('');
    warningsEl.innerHTML = (data.warnings || []).map((w) => `⚠ ${w}`).join('<br>');
    $('resultTitle').textContent = `${data.width}×${data.height} · ${data.stats.outputShapes} shape`;
    resultCard.classList.remove('hidden');
    status.textContent = 'Konversi selesai.';
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

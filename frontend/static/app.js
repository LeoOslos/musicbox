const $ = id => document.getElementById(id);

let ws = null;
let wsRetryDelay = 2000;
let progressTimer = null;
let state = {};

// --- API helpers ---

async function post(path) {
  const r = await fetch(path, { method: 'POST' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    console.warn('API error:', err.detail);
  }
}

async function postJSON(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    console.warn('API error:', err.detail);
  }
}

// --- Connect ---

$('btn-connect').addEventListener('click', async () => {
  const ip = $('ip-input').value.trim();
  if (!ip) return;
  await postJSON('/api/config', { ip });
  connectWS();
});

// On load: if already configured (server auto-connected from inventory) just open WS.
// Otherwise try discovery, then fall back to manual entry.
(async () => {
  const cfg = await fetch('/api/config').then(r => r.json());
  if (cfg.configured) {
    $('ip-input').value = cfg.ip;
    $('ip-input').title = 'IP obtenida del inventario IoT';
    connectWS();
    return;
  }
  try {
    const disc = await fetch('/api/discover').then(r => r.json());
    if (disc.ip) {
      $('ip-input').value = disc.ip;
      $('ip-input').title = 'IP obtenida del inventario IoT';
    }
  } catch {}
})();

// --- WebSocket ---

function connectWS() {
  if (ws) { ws.onclose = null; ws.close(); }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    wsRetryDelay = 2000;
    $('conn-status').textContent = 'Conectado';
    $('conn-status').className = 'badge connected';
    $('ip-input').readOnly = true;
    $('btn-connect').style.display = 'none';
    $('main').classList.remove('hidden');
    loadEqList();
    loadEqBands();
    loadCd();
  };

  ws.onmessage = e => {
    try {
      state = JSON.parse(e.data);
      updateUI(state);
    } catch {}
  };

  ws.onclose = () => {
    $('conn-status').textContent = 'Reconectando…';
    $('conn-status').className = 'badge disconnected';
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 1.5, 30000);
  };

  ws.onerror = () => ws.close();
}

// --- UI update ---

let lastArtworkKey = null;

function updateUI(s) {
  // Status pill with animated dot
  const statusMap = { play: 'Reproduciendo', pause: 'Pausado', stop: 'Detenido', load: 'Cargando' };
  const statusEl = $('play-status');
  statusEl.textContent = statusMap[s.play_state] ?? s.play_state ?? '—';
  statusEl.classList.toggle('is-playing', s.is_playing === true);

  // Track. For a disc, the device reports our stream URL as the title, which is
  // no use to anyone — name the track instead.
  const onDisc = typeof s.title === 'string' && s.title.includes('/api/cd/track/');
  const named = onDisc ? cdTracks.find(t => t.number === s.cd_track) : null;
  $('track-title').textContent  = onDisc
    ? (named?.title || `Tema ${s.cd_track ?? ''}`.trim())
    : (s.title || '—');
  $('track-artist').textContent = onDisc ? (cdAlbumArtist || 'CD') : (s.artist || '—');
  $('track-album').textContent  = onDisc ? (cdAlbumTitle || '') : (s.album || '');

  // Artwork — reload only when track changes
  const artKey = `${s.title}|${s.artist}`;
  if (artKey !== lastArtworkKey) {
    lastArtworkKey = artKey;
    const bgArt = $('bg-art');
    if (s.has_artwork) {
      const url = `/api/artwork?t=${Date.now()}`;
      $('artwork').src = url;
      $('artwork').classList.remove('hidden');
      bgArt.classList.remove('visible');
      bgArt.src = url;
      bgArt.onload = () => bgArt.classList.add('visible');
    } else {
      $('artwork').classList.add('hidden');
      $('bg-art').classList.remove('visible');
    }
  }

  // Progress
  updateProgress(s.position ?? 0, s.duration ?? 0);
  restartProgressTimer(s);

  // Play button icon
  $('btn-toggle').innerHTML = s.is_playing ? '&#9646;&#9646;' : '&#9654;';

  // Volume (only update slider if user isn't dragging)
  if (s.volume !== null && s.volume !== undefined && !isDragging) {
    $('vol-slider').value      = s.volume;
    $('vol-label').textContent = s.volume;
  }

  // Mute
  const muteBtn = $('btn-mute');
  muteBtn.classList.toggle('muted', s.muted === true);
  muteBtn.title = s.muted ? 'Desmutear' : 'Mutear';

  // Source buttons
  const srcId = s.source ?? '';
  document.querySelectorAll('.source-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.source.replace('-', '_') === srcId || b.dataset.source === srcId);
  });

  // EQ current preset selection
  if (s.eq_preset) {
    const sel = $('eq-select');
    for (const opt of sel.options) {
      if (opt.value === s.eq_preset) { sel.value = s.eq_preset; break; }
    }
  }

  // CD track highlight — follows automatic advance, not just clicks
  if (s.cd_track !== undefined && s.cd_track !== cdCurrent) markCdTrack(s.cd_track);

  // Disc swapped in the drive: reload the track list by itself
  if (s.cd_disc !== undefined && cdDisc !== null && s.cd_disc !== cdDisc) loadCd(true);
  if (s.cd_disc !== undefined) cdDisc = s.cd_disc;

  // Device info — 2-column grid
  const fields = [
    ['Nombre',   s.name],
    ['Modelo',   s.model],
    ['Firmware', s.firmware],
    ['IP',       s.ip],
  ];
  $('device-details').innerHTML = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `
      <div class="device-field">
        <span class="device-field-label">${k}</span>
        <span class="device-field-value">${v}</span>
      </div>`)
    .join('');
}

// --- Progress ---

function fmtTime(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgress(pos, dur) {
  $('pos-label').textContent = fmtTime(pos);
  $('dur-label').textContent = fmtTime(dur);
  $('progress-fill').style.width = dur > 0 ? `${Math.min(100, (pos / dur) * 100)}%` : '0%';
}

let localPos = 0;
let localDur = 0;
let lastProgressUpdate = 0;

function restartProgressTimer(s) {
  if (progressTimer) clearInterval(progressTimer);
  localPos = s.position ?? 0;
  localDur = s.duration ?? 0;
  lastProgressUpdate = Date.now();

  if (s.is_playing && localDur > 0) {
    progressTimer = setInterval(() => {
      const elapsed = (Date.now() - lastProgressUpdate) / 1000;
      updateProgress(localPos + elapsed, localDur);
    }, 1000);
  }
}

// --- Progress bar seek on click ---

$('progress-bar-click').addEventListener('click', async e => {
  if (!localDur) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const sec = Math.round(ratio * localDur);
  await post(`/api/seek/${sec}`);
});

// --- Playback controls ---

// One transport for everything. When the disc is what's playing, prev/next/stop
// have to drive the CD endpoints — the device has no playlist of its own to
// step through, each track is a separate stream we push at it.
const onCd = () => cdCurrent !== null;

$('btn-toggle').addEventListener('click', () => postCd('/api/transport'));
$('btn-prev').addEventListener('click',   () => onCd() ? postCd('/api/cd/prev') : post('/api/prev'));
$('btn-next').addEventListener('click',   () => onCd() ? postCd('/api/cd/next') : post('/api/next'));
$('btn-stop').addEventListener('click',   () => onCd() ? postCd('/api/cd/stop') : post('/api/stop'));

// --- Volume ---

let isDragging = false;
let volDebounce = null;

$('vol-slider').addEventListener('mousedown', () => { isDragging = true; });
$('vol-slider').addEventListener('touchstart', () => { isDragging = true; });
$('vol-slider').addEventListener('mouseup',   () => { isDragging = false; });
$('vol-slider').addEventListener('touchend',  () => { isDragging = false; });

$('vol-slider').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  $('vol-label').textContent = v;
  clearTimeout(volDebounce);
  volDebounce = setTimeout(() => post(`/api/volume/${v}`), 200);
});

$('btn-mute').addEventListener('click', () => {
  post(`/api/mute/${state.muted ? 0 : 1}`);
});

// --- Source ---

document.querySelectorAll('.source-btn').forEach(btn => {
  btn.addEventListener('click', () => post(`/api/source/${btn.dataset.source}`));
});

// --- CD ---

let cdTracks = [];
let cdCurrent = null;
let cdDisc = null;   // disc generation from the server; a change means swapped disc
let cdAlbumTitle = '';
let cdAlbumArtist = '';

async function postCd(path) {
  const r = await fetch(path, { method: 'POST' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    console.warn('CD error:', err.detail);
    return null;
  }
  const data = await r.json().catch(() => ({}));
  if ('track' in data) markCdTrack(data.track);
  return data;
}

function markCdTrack(number) {
  cdCurrent = number;
  document.querySelectorAll('.cd-track').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.track) === number);
  });
}

// The TOC is cached server-side because reading it spins up the drive; the
// backend watches for disc swaps and tells us to reload through cd_disc.
async function loadCd(refresh = false) {
  const statusEl = $('cd-status');
  statusEl.textContent = 'Leyendo…';
  try {
    const s = await fetch('/api/cd/status').then(r => r.json());
    if (s.disc !== undefined) cdDisc = s.disc;
    if (s.status !== 'audio') {
      statusEl.textContent = s.status === 'no_disc' ? 'Sin disco' : 'Disco sin audio';
      $('cd-tracks').innerHTML = '';
      $('btn-cd-identify').classList.add('hidden');
      $('cd-candidates').classList.add('hidden');
      cdTracks = [];
      return;
    }
    cdTracks = await fetch(`/api/cd/tracks${refresh ? '?refresh=true' : ''}`).then(r => r.json());
    const total = cdTracks.reduce((a, t) => a + t.seconds, 0);
    const shape = `${cdTracks.length} temas · ${fmtTime(total)}`;
    statusEl.textContent = s.identified && s.album
      ? `${s.album}${s.artist ? ' · ' + s.artist : ''} — ${shape}`
      : shape;
    $('btn-cd-identify').classList.toggle('hidden', !!s.identified);
    cdAlbumTitle = s.identified ? (s.album || '') : '';
    cdAlbumArtist = s.identified ? (s.artist || '') : '';
    renderCdTracks();
    markCdTrack(s.current);
  } catch {
    statusEl.textContent = 'Error al leer';
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderCdTracks() {
  const named = cdTracks.some(t => t.title);
  $('cd-tracks').classList.toggle('named', named);
  $('cd-tracks').innerHTML = cdTracks.map(t => `
    <button class="cd-track" data-track="${t.number}" title="${esc(t.title || 'Tema ' + t.number)}">
      <span class="cd-track-num">${t.number}</span>
      ${t.title ? `<span class="cd-track-name">${esc(t.title)}</span>` : ''}
      <span class="cd-track-dur">${fmtTime(t.seconds)}</span>
    </button>`).join('');

  document.querySelectorAll('.cd-track').forEach(btn => {
    btn.addEventListener('click', () => postCd(`/api/cd/play/${btn.dataset.track}`));
  });
}

// --- Naming the disc ---

// Opt-in on purpose: an unidentified disc still plays and is fully controllable,
// so this never interrupts. Nothing is applied without the user choosing it.
$('btn-cd-identify').addEventListener('click', async () => {
  const box = $('cd-candidates');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="cd-candidate">Buscando álbumes que coincidan…</div>';
  try {
    const list = await fetch('/api/cd/candidates').then(r => r.json());
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = '<div class="cd-candidate">No se encontró ningún álbum parecido</div>';
      return;
    }
    box.innerHTML = list.map(c => `
      <button class="cd-candidate" data-release="${esc(c.release_id)}">
        <span class="cd-candidate-album">${esc(c.album || '—')}</span>
        <span>${esc(c.artist || '')}</span>
        <span class="cd-candidate-first">${esc(c.tracks['1'] || '')}</span>
        <span class="cd-candidate-meta">${esc([c.date, c.country].filter(Boolean).join(' · '))}</span>
      </button>`).join('');

    box.querySelectorAll('.cd-candidate[data-release]').forEach(btn => {
      btn.addEventListener('click', async () => {
        box.innerHTML = '<div class="cd-candidate">Guardando…</div>';
        await postCd(`/api/cd/identify/${btn.dataset.release}`);
        box.classList.add('hidden');
        loadCd();
      });
    });
  } catch {
    box.innerHTML = '<div class="cd-candidate">No se pudo consultar la base de datos</div>';
  }
});

$('btn-cd-eject').addEventListener('click', async () => {
  await postCd('/api/cd/eject');
  loadCd();
});

// --- EQ Presets ---

async function loadEqList() {
  try {
    const r = await fetch('/api/eq/list');
    const presets = await r.json();
    const sel = $('eq-select');
    sel.innerHTML = '';
    const offOpt = document.createElement('option');
    offOpt.value = 'off'; offOpt.textContent = 'Off';
    sel.appendChild(offOpt);
    (Array.isArray(presets) ? presets : []).forEach(p => {
      if (p.toLowerCase() === 'off') return;
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      if (p === state.eq_preset) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch {
    $('eq-select').innerHTML = '<option value="">Error al cargar</option>';
  }
}

$('btn-eq-apply').addEventListener('click', async () => {
  const preset = $('eq-select').value;
  if (preset) {
    await post(`/api/eq/preset/${encodeURIComponent(preset)}`);
    // Reload band values after preset change (device updates them)
    setTimeout(loadEqBands, 400);
  }
});

// --- EQ Bands ---

const EQ_FREQS = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
let eqBands = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
let eqDebounce = null;
let eqDragging = false;

function buildEqBands() {
  const container = $('eq-bands');
  container.innerHTML = '';
  EQ_FREQS.forEach((freq, i) => {
    const col = document.createElement('div');
    col.className = 'eq-band';
    col.innerHTML = `
      <span class="eq-val" id="eq-val-${i}">0</span>
      <div class="eq-band-wrap">
        <input type="range" class="eq-slider" id="eq-slider-${i}"
               min="0" max="99" value="50" data-idx="${i}">
      </div>
      <span class="eq-freq">${freq}</span>
    `;
    container.appendChild(col);
  });

  document.querySelectorAll('.eq-slider').forEach(slider => {
    const idx = parseInt(slider.dataset.idx);
    slider.addEventListener('mousedown',  () => { eqDragging = true; });
    slider.addEventListener('touchstart', () => { eqDragging = true; }, { passive: true });
    slider.addEventListener('mouseup',    () => { eqDragging = false; sendEqBands(); });
    slider.addEventListener('touchend',   () => { eqDragging = false; sendEqBands(); });
    slider.addEventListener('input', e => {
      eqBands[idx] = parseInt(e.target.value);
      updateEqVal(idx, eqBands[idx]);
    });
  });
}

function updateEqVal(idx, v) {
  const el = $(`eq-val-${idx}`);
  if (!el) return;
  const offset = v - 50;
  el.textContent = offset > 0 ? `+${offset}` : `${offset}`;
  el.className = 'eq-val' + (offset > 0 ? ' pos' : offset < 0 ? ' neg' : '');
}

function setEqSliders(bands) {
  eqBands = [...bands];
  bands.forEach((v, i) => {
    const slider = $(`eq-slider-${i}`);
    if (slider) slider.value = v;
    updateEqVal(i, v);
  });
}

async function loadEqBands() {
  try {
    const r = await fetch('/api/eq/bands');
    const data = await r.json();
    setEqSliders(data.bands);
  } catch {}
}

function sendEqBands() {
  clearTimeout(eqDebounce);
  eqDebounce = setTimeout(() => postJSON('/api/eq/bands', { bands: eqBands }), 150);
}

$('btn-eq-flat').addEventListener('click', async () => {
  setEqSliders([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
  await postJSON('/api/eq/bands', { bands: eqBands });
});

// Build sliders on page load (before WS connects)
buildEqBands();

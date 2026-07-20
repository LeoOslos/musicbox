const $ = id => document.getElementById(id);

let ws = null;
let wsRetryDelay = 2000;
let progressTimer = null;
let state = {};

// --- Colour from the cover ---
//
// The page takes its accent from whatever is playing instead of a fixed amber.
// This only works because /api/artwork is proxied by our own backend: an image
// served straight from the WiiM would taint the canvas and readPixels would throw.

const ART_FALLBACK = '#BA7517';

// The device reports our own stream URL as the title — that is how a disc is
// told apart from Spotify or anything else playing.
const CD_URL_MARK = '/api/cd/track/';

// Picks the most present colour that is actually a colour: near-black, near-white
// and grey pixels are skipped, because averaging them gives mud every time.
function coverAccent(img) {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;  // tainted canvas: leave the fixed palette alone
  }
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 128) continue;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 45 || min > 225 || max - min < 28) continue;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const seen = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    buckets.set(key, { r: seen.r + r, g: seen.g + g, b: seen.b + b, n: seen.n + 1 });
  }
  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  if (!best) return null;
  return lift(best.r / best.n, best.g / best.n, best.b / best.n);
}

// A dark cover would hand us a dark accent, which then disappears against the
// page. Accents are pushed into a band that stays legible on near-black.
function lift(r, g, b) {
  const max = Math.max(r, g, b) || 1;
  const scale = Math.min(235 / max, 2.2);
  const mix = (v) => Math.round(Math.min(235, Math.max(70, v * scale)));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function setAccent(colour) {
  document.documentElement.style.setProperty('--art-accent', colour || ART_FALLBACK);
}

// --- The cover a CD does not have ---
//
// A disc carries no artwork, and the WiiM answers with its own manufacturer logo
// — a black square, which is what made the page look dead while a CD played. So
// we draw the cover from what the disc itself tells us: one arc per track, each
// as long as the track lasts, with the one playing lit. The sleeve is the TOC.

let coverHue = 210;

// Same album, same colour, every time — derived from the name, not random.
function albumHue(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 3600;
  return hash / 10;
}

function discCover(album, artist, tracks, current) {
  const S = 640;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const hue = coverHue;

  const bg = ctx.createRadialGradient(S * 0.5, S * 0.42, S * 0.05, S * 0.5, S * 0.5, S * 0.75);
  bg.addColorStop(0, `hsl(${hue}, 34%, 22%)`);
  bg.addColorStop(1, `hsl(${(hue + 28) % 360}, 40%, 8%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  const total = tracks.reduce((sum, t) => sum + t.seconds, 0) || 1;
  const radius = S * 0.375;
  const gap = 0.014;
  let angle = -Math.PI / 2;
  ctx.lineCap = 'butt';
  tracks.forEach(t => {
    const sweep = (t.seconds / total) * Math.PI * 2;
    const playing = t.number === current;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, radius, angle + gap / 2, angle + sweep - gap / 2);
    ctx.strokeStyle = playing ? `hsl(${hue}, 85%, 68%)` : `hsla(${hue}, 45%, 78%, 0.26)`;
    ctx.lineWidth = playing ? 15 : 6;
    ctx.stroke();
    angle += sweep;
  });

  // No centre hole: it collided with the title, and the ring already reads as
  // a disc without it.
  ctx.textAlign = 'center';
  ctx.fillStyle = `hsla(${hue}, 30%, 92%, 0.62)`;
  ctx.font = '500 20px Inter, system-ui, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText((artist || '').toUpperCase(), S / 2, S * 0.4, S * 0.56);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = 'rgba(250, 246, 240, 0.96)';
  const lines = wrapText(ctx, album || 'Disco sin nombre', S * 0.5, 44);
  lines.forEach((line, i) => {
    ctx.font = '500 44px Inter, system-ui, sans-serif';
    ctx.fillText(line, S / 2, S * 0.5 + 16 + i * 52, S * 0.58);
  });
  return canvas.toDataURL('image/png');
}

function wrapText(ctx, text, maxWidth, size) {
  ctx.font = `500 ${size}px Inter, system-ui, sans-serif`;
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

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

// Both covers land here: the drawn one for a disc, the device's own for anything
// else. Reloaded only when the key changes, so this runs once per track, never
// per state push.
function refreshCover(s, onDisc) {
  const art = $('artwork'), bgArt = $('bg-art');
  const key = onDisc
    ? `cd|${cdAlbumTitle}|${cdTracks.length}|${s.cd_track}`
    : `${s.title}|${s.artist}`;
  if (key === lastArtworkKey) return;
  lastArtworkKey = key;

  const show = (src, accent) => {
    art.src = src;
    art.classList.remove('hidden');
    bgArt.classList.remove('visible');
    bgArt.src = src;
    bgArt.onload = () => {
      bgArt.classList.add('visible');
      setAccent(accent === undefined ? coverAccent(bgArt) : accent);
    };
  };

  if (onDisc && cdTracks.length) {
    coverHue = albumHue(cdAlbumTitle || cdAlbumArtist || 'CD');
    show(discCover(cdAlbumTitle, cdAlbumArtist, cdTracks, s.cd_track),
         `hsl(${coverHue}, 78%, 62%)`);
  } else if (s.has_artwork) {
    show(`/api/artwork?t=${Date.now()}`);
  } else {
    art.classList.add('hidden');
    bgArt.classList.remove('visible');
    setAccent(null);
  }
}

function updateUI(s) {
  // Status pill with animated dot
  const statusMap = { play: 'Reproduciendo', pause: 'Pausado', stop: 'Detenido', load: 'Cargando' };
  const statusEl = $('play-status');
  statusEl.textContent = statusMap[s.play_state] ?? s.play_state ?? '—';
  statusEl.classList.toggle('is-playing', s.is_playing === true);

  // Track. For a disc, the device reports our stream URL as the title, which is
  // no use to anyone — name the track instead.
  const onDisc = typeof s.title === 'string' && s.title.includes(CD_URL_MARK);
  const named = onDisc ? cdTracks.find(t => t.number === s.cd_track) : null;
  $('track-title').textContent  = onDisc
    ? (named?.title || `Tema ${s.cd_track ?? ''}`.trim())
    : (s.title || '—');
  $('track-artist').textContent = onDisc ? (cdAlbumArtist || 'CD') : (s.artist || '—');
  $('track-album').textContent  = onDisc ? (cdAlbumTitle || '') : (s.album || '');

  refreshCover(s, onDisc);

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
let cdIdentified = false;
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
      $('cd-identify-panel').classList.add('hidden');
      cdTracks = [];
      return;
    }
    cdTracks = await fetch(`/api/cd/tracks${refresh ? '?refresh=true' : ''}`).then(r => r.json());
    const total = cdTracks.reduce((a, t) => a + t.seconds, 0);
    const shape = `${cdTracks.length} temas · ${fmtTime(total)}`;
    statusEl.textContent = s.identified && s.album
      ? `${s.album}${s.artist ? ' · ' + s.artist : ''} — ${shape}`
      : shape;
    // Always offered, never forced: an identification can also be corrected
    $('btn-cd-identify').classList.remove('hidden');
    $('btn-cd-identify').textContent = s.identified ? 'Cambiar nombres' : 'Identificar disco';
    cdIdentified = !!s.identified;
    cdAlbumTitle = s.identified ? (s.album || '') : '';
    cdAlbumArtist = s.identified ? (s.artist || '') : '';
    renderCdTracks();
    markCdTrack(s.current);
    // The drawn cover needs the album name and the track list, which arrive
    // here — after the state push that first asked for a cover.
    lastArtworkKey = null;
    refreshCover(state, typeof state.title === 'string' && state.title.includes(CD_URL_MARK));
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
      ${named ? `<span class="cd-track-edit${t.edited ? ' edited' : ''}" data-edit="${t.number}"
        role="button" tabindex="0" title="Corregir el nombre">✎</span>` : ''}
    </button>`).join('');

  document.querySelectorAll('.cd-track').forEach(btn => {
    btn.addEventListener('click', () => postCd(`/api/cd/play/${btn.dataset.track}`));
  });
  // Inside the play button, so every path to it has to stop the click from
  // reaching the tile — otherwise correcting a name also starts the track.
  document.querySelectorAll('.cd-track-edit').forEach(pen => {
    pen.addEventListener('click', ev => { ev.stopPropagation(); editTitle(pen.dataset.edit); });
    pen.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      ev.stopPropagation();
      editTitle(pen.dataset.edit);
    });
  });
}

// Corrections outrank the databases, so this is also the way out of a title
// that arrived broken. Emptying the box restores the looked-up name.
async function editTitle(number) {
  const track = cdTracks.find(t => t.number === parseInt(number));
  if (!track) return;
  const typed = prompt(`Nombre del tema ${number} (vacío = volver al de la base)`, track.title || '');
  if (typed === null) return;
  await postJSON(`/api/cd/title/${number}`, { title: typed });
  await loadCd();
}

// --- Naming the disc ---

// Opt-in on purpose: an unidentified disc still plays and is fully controllable,
// so this never interrupts. Nothing is applied without the user choosing it.
function renderCandidates(list, box) {
  const escapeRow = `
    <button class="cd-candidate cd-candidate-none" data-none="1">
      <span class="cd-candidate-album">No estoy seguro</span>
      <span>${cdIdentified ? 'quitar los nombres guardados' : 'dejarlo sin nombres por ahora'}</span>
    </button>`;
  box.innerHTML = escapeRow + list.map(c => `
    <button class="cd-candidate" data-release="${esc(c.release_id)}">
      <span class="cd-candidate-album">${esc(c.album || '—')}</span>
      <span>${esc(c.artist || '')}</span>
      <span class="cd-candidate-first">${esc(c.tracks['1'] || '')}</span>
      ${c.exact === false ? `<span class="cd-candidate-warn">${c.track_count} temas, tu disco tiene ${cdTracks.length}</span>` : ''}
      <span class="cd-candidate-meta">${esc([c.date, c.country, c.source === 'gnudb' ? 'GnuDB' : ''].filter(Boolean).join(' · '))}</span>
    </button>`).join('');
  wireCandidates(box);
}

function wireCandidates(box) {
  box.querySelector('.cd-candidate[data-none]')?.addEventListener('click', async () => {
    if (cdIdentified) await postCd('/api/cd/forget');
    $('cd-identify-panel').classList.add('hidden');
    loadCd();
  });
  box.querySelectorAll('.cd-candidate[data-release]').forEach(btn => {
    btn.addEventListener('click', async () => {
      box.innerHTML = '<div class="cd-candidate">Guardando…</div>';
      await postCd(`/api/cd/identify/${btn.dataset.release}`);
      $('cd-identify-panel').classList.add('hidden');
      loadCd();
    });
  });
}

// Searching by name covers what the TOC search cannot see: a pressing nobody
// ever registered is invisible to it even when the album is in the database.
async function searchByName() {
  const q = $('cd-search').value.trim();
  if (!q) return;
  const box = $('cd-candidates');
  box.innerHTML = '<div class="cd-candidate">Buscando…</div>';
  try {
    const list = await fetch(`/api/cd/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = '<div class="cd-candidate">Sin resultados para ese nombre</div>';
      return;
    }
    renderCandidates(list, box);
  } catch {
    box.innerHTML = '<div class="cd-candidate">No se pudo consultar la base de datos</div>';
  }
}

$('btn-cd-search').addEventListener('click', searchByName);
$('cd-search').addEventListener('keydown', e => { if (e.key === 'Enter') searchByName(); });

$('btn-cd-identify').addEventListener('click', async () => {
  const panel = $('cd-identify-panel');
  const box = $('cd-candidates');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  box.innerHTML = '<div class="cd-candidate">Buscando álbumes que coincidan…</div>';
  try {
    const list = await fetch('/api/cd/candidates').then(r => r.json());
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML = '<div class="cd-candidate">Ninguno coincide por índice — probá buscando por nombre</div>';
      wireCandidates(box);
      return;
    }
    renderCandidates(list, box);
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

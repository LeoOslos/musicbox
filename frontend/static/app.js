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
  // Try inventory discovery
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
    $('main').classList.remove('hidden');
    loadEqList();
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
  // Status badge
  const statusMap = { play: 'Reproduciendo', pause: 'Pausado', stop: 'Detenido', load: 'Cargando' };
  $('play-status').textContent = statusMap[s.play_state] ?? s.play_state ?? '—';

  // Track
  $('track-title').textContent  = s.title  || '—';
  $('track-artist').textContent = s.artist || '—';
  $('track-album').textContent  = s.album  || '';

  // Artwork — reload only when track changes
  const artKey = `${s.title}|${s.artist}`;
  if (artKey !== lastArtworkKey) {
    lastArtworkKey = artKey;
    if (s.has_artwork) {
      $('artwork').src = `/api/artwork?t=${Date.now()}`;
      $('artwork').classList.remove('hidden');
    } else {
      $('artwork').classList.add('hidden');
    }
  }

  // Progress
  updateProgress(s.position ?? 0, s.duration ?? 0);
  restartProgressTimer(s);

  // Play button icon
  $('btn-toggle').innerHTML = s.is_playing ? '&#9646;&#9646;' : '&#9654;';

  // Volume (only update slider if user isn't dragging)
  if (s.volume !== null && s.volume !== undefined && !isDragging) {
    $('vol-slider').value  = s.volume;
    $('vol-label').textContent = s.volume;
  }

  // Mute
  $('btn-mute').textContent = s.muted ? '🔇' : '🔊';

  // Source buttons
  const srcId = s.source ?? '';
  document.querySelectorAll('.source-btn').forEach(b => {
    // pywiim canonical ids use underscores; buttons use hyphens
    b.classList.toggle('active', b.dataset.source.replace('-', '_') === srcId || b.dataset.source === srcId);
  });

  // Device info
  const fields = [
    ['Nombre',   s.name],
    ['Modelo',   s.model],
    ['Firmware', s.firmware],
    ['IP',       s.ip],
  ];
  $('device-details').innerHTML = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="key">${k}</span><span>${v}</span>`)
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

$('progress-fill').parentElement.addEventListener('click', async e => {
  if (!localDur) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const sec = Math.round(ratio * localDur);
  await post(`/api/seek/${sec}`);
});

// --- Playback controls ---

$('btn-toggle').addEventListener('click', () => post('/api/toggle'));
$('btn-prev').addEventListener('click',   () => post('/api/prev'));
$('btn-next').addEventListener('click',   () => post('/api/next'));
$('btn-stop').addEventListener('click',   () => post('/api/stop'));

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

// --- EQ ---

async function loadEqList() {
  try {
    const r = await fetch('/api/eq/list');
    const presets = await r.json();
    const sel = $('eq-select');
    sel.innerHTML = '';
    (Array.isArray(presets) ? presets : []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      if (p === state.eq_preset) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch {
    $('eq-select').innerHTML = '<option value="">Error al cargar</option>';
  }
}

$('btn-eq-apply').addEventListener('click', () => {
  const preset = $('eq-select').value;
  if (preset) post(`/api/eq/preset/${encodeURIComponent(preset)}`);
});

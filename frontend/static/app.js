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

const ART_FALLBACK = { light: '#E0761B', dark: '#E39B3A' };

// --- Tema ---
//
// Pop es el default. La elección se guarda: quien prefiere oscuro no quiere
// volver a pedirlo cada vez que abre la página.

const THEME_KEY = 'wiim-theme';
let theme = 'light';

function readStoredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch { return null; }
}

function applyTheme(next, remember = true) {
  theme = next;
  document.documentElement.setAttribute('data-theme', next);
  document.getElementById('icon-moon')?.classList.toggle('hidden', next === 'dark');
  document.getElementById('icon-sun')?.classList.toggle('hidden', next !== 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#0B0A09' : '#FBF3E9');
  if (remember) { try { localStorage.setItem(THEME_KEY, next); } catch {} }
  // El acento y la tapa dibujada del CD se calculan distinto en cada tema
  setAccent(rawAccent);
  lastArtworkKey = null;
  if (state && Object.keys(state).length) {
    refreshCover(state, typeof state.title === 'string' && state.title.includes(CD_URL_MARK));
  }
}


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
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

// Una tapa oscura entrega un acento oscuro, que después desaparece contra la
// página — y en el tema claro pasa lo simétrico con las tapas luminosas. Cada
// tema empuja el color a la banda donde se lee, sin perder el tono.
function lift(r, g, b) {
  const max = Math.max(r, g, b) || 1;
  const scale = Math.min(235 / max, 2.2);
  const mix = (v) => Math.round(Math.min(235, Math.max(70, v * scale)));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Para el tema claro: mismo tono, saturado, con la luminosidad bajada a donde
// contrasta contra crema (y sirve de fondo del botón de play con texto blanco).
function deepen(r, g, b) {
  const [h, s] = rgbToHs(r, g, b);
  return `hsl(${h}, ${Math.min(92, Math.max(55, s))}%, 42%)`;
}

function rgbToHs(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
  }
  h = Math.round(h * 60);
  if (h < 0) h += 360;
  const l = (max + min) / 2;
  const s = d ? Math.round((d / (1 - Math.abs(2 * l - 1))) * 100) : 0;
  return [h, s];
}

// El color crudo de la tapa, para poder recalcularlo al cambiar de tema.
let rawAccent = null;

function setAccent(rgb) {
  rawAccent = rgb || null;
  const root = document.documentElement;
  if (!rgb) {
    root.style.setProperty('--art-accent', ART_FALLBACK[theme]);
    root.style.removeProperty('--art-accent-2');
    return;
  }
  const [r, g, b] = rgb;
  root.style.setProperty('--art-accent', theme === 'dark' ? lift(r, g, b) : deepen(r, g, b));
  // El segundo color, para la mancha opuesta del fondo pop: el tono girado, no
  // el complementario exacto, que con muchas tapas da un choque feo.
  const [h, s] = rgbToHs(r, g, b);
  const sat = Math.min(90, Math.max(62, s));
  root.style.setProperty('--art-accent-2', `hsl(${(h + 155) % 360}, ${sat}%, ${theme === 'dark' ? 55 : 60}%)`);
  // Un tercer tono, más cerca del original, para que el fondo pop tenga
  // profundidad en vez de dos manchas planas.
  root.style.setProperty('--art-accent-3', `hsl(${(h + 45) % 360}, ${sat}%, ${theme === 'dark' ? 52 : 64}%)`);
}

// --- The cover a CD does not have ---
//
// A disc carries no artwork, and the WiiM answers with its own manufacturer logo
// — a black square, which is what made the page look dead while a CD played. So
// we draw the cover from what the disc itself tells us: one arc per track, each
// as long as the track lasts, with the one playing lit. The sleeve is the TOC.

let coverHue = 210;

// Same album, same colour, every time — derived from the name, not random.
// La tapa dibujada no tiene de dónde sacar un color: el tono del álbum es el
// acento, así que se convierte al mismo formato crudo que el resto.
function hueToRgb(hue) {
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const a = 0.62 * Math.min(0.5, 1 - 0.5);
    return Math.round(255 * (0.5 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
  };
  return [f(0), f(8), f(4)];
}

// Los papeles del póster de Matisse: naranja, bermellón, teja, salmón, hoja y
// celeste. La tapa dibujada elige uno de esos y no un tono cualquiera del
// círculo, así el CD no choca contra el papel recortado del fondo. Ninguno baja
// del 50% de luz: el título va en tinta oscura encima.
const MATISSE_PAPERS = [
  { h: 26,  s: 82, l: 56 },
  { h: 8,   s: 70, l: 55 },
  { h: 14,  s: 66, l: 51 },
  { h: 20,  s: 58, l: 70 },
  { h: 158, s: 34, l: 52 },
  { h: 204, s: 40, l: 66 },
];

// El mismo álbum, el mismo papel, siempre.
function albumPaper(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 3600;
  return MATISSE_PAPERS[hash % MATISSE_PAPERS.length];
}

function albumHue(name) {
  return albumPaper(name).h;
}

function discCover(album, artist, tracks, current) {
  const S = 640;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const hue = coverHue;

  const pop = theme !== 'dark';
  const bg = ctx.createRadialGradient(S * 0.5, S * 0.42, S * 0.05, S * 0.5, S * 0.5, S * 0.75);
  if (pop) {
    const paper = albumPaper(album || artist || 'CD');
    bg.addColorStop(0, `hsl(${paper.h}, ${paper.s}%, ${paper.l}%)`);
    bg.addColorStop(1, `hsl(${(paper.h + 14) % 360}, ${paper.s}%, ${paper.l - 13}%)`);
  } else {
    bg.addColorStop(0, `hsl(${hue}, 34%, 22%)`);
    bg.addColorStop(1, `hsl(${(hue + 28) % 360}, 40%, 8%)`);
  }
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
    ctx.strokeStyle = playing
      ? (pop ? 'rgba(255, 255, 255, 0.98)' : `hsl(${hue}, 85%, 68%)`)
      : (pop ? 'rgba(255, 255, 255, 0.34)' : `hsla(${hue}, 45%, 78%, 0.26)`);
    ctx.lineWidth = playing ? 15 : 6;
    ctx.stroke();
    angle += sweep;
  });

  // No centre hole: it collided with the title, and the ring already reads as
  // a disc without it.
  ctx.textAlign = 'center';
  ctx.fillStyle = pop ? 'rgba(28, 16, 6, 0.62)' : `hsla(${hue}, 30%, 92%, 0.62)`;
  ctx.font = '500 20px Inter, system-ui, sans-serif';
  ctx.letterSpacing = '2px';
  ctx.fillText((artist || '').toUpperCase(), S / 2, S * 0.4, S * 0.56);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = pop ? 'rgba(24, 14, 5, 0.94)' : 'rgba(250, 246, 240, 0.96)';
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
    loadSpotifyStatus();
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
let coverFadeTimer = null;

// Both covers land here: the drawn one for a disc, the device's own for anything
// else. Reloaded only when the key changes, so this runs once per track, never
// per state push.
function refreshCover(s, onDisc) {
  const art = $('artwork'), bgArt = $('bg-art'), empty = $('cover-empty');
  const key = onDisc
    ? `cd|${cdAlbumTitle}|${cdTracks.length}|${s.cd_track}`
    : `${s.title}|${s.artist}`;
  if (key === lastArtworkKey) return;
  lastArtworkKey = key;

  // La tapa es el elemento mas grande de la pagina: cambiarla de golpe se ve
  // como un corte. La saliente queda congelada abajo y la entrante se funde
  // encima, pero recien cuando ya decodifico — antes se asignaba el src a ciegas
  // y el marco parpadeaba vacio mientras bajaba la imagen.
  const show = (src, accent) => {
    const prev = $('artwork-prev');
    const hadCover = !art.classList.contains('hidden') && art.getAttribute('src');
    if (hadCover) {
      prev.src = art.src;
      prev.classList.remove('hidden');
    }
    art.classList.add('is-loading');

    const paint = () => {
      art.src = src;
      art.classList.remove('hidden');
      empty.classList.add('hidden');
      // Dos frames: uno para que el navegador registre opacity 0 con el src
      // nuevo, otro para que la vuelta a 1 sea una transicion y no un salto.
      requestAnimationFrame(() => requestAnimationFrame(() => art.classList.remove('is-loading')));
      if (coverFadeTimer) clearTimeout(coverFadeTimer);
      coverFadeTimer = setTimeout(() => prev.classList.add('hidden'), 340);
    };

    const pre = new Image();
    pre.onload = paint;
    pre.onerror = paint;
    pre.src = src;

    bgArt.classList.remove('visible');
    bgArt.src = src;
    bgArt.onload = () => {
      bgArt.classList.add('visible');
      setAccent(accent === undefined ? coverAccent(bgArt) : accent);
    };
  };

  if (onDisc && cdTracks.length) {
    coverHue = albumHue(cdAlbumTitle || cdAlbumArtist || 'CD');
    show(discCover(cdAlbumTitle, cdAlbumArtist, cdTracks, s.cd_track), hueToRgb(coverHue));
  } else if (s.has_artwork) {
    show(`/api/artwork?t=${Date.now()}`);
  } else {
    art.classList.add('hidden');
    art.classList.remove('is-loading');
    $('artwork-prev').classList.add('hidden');
    empty.classList.remove('hidden');
    bgArt.classList.remove('visible');
    setAccent(null);
  }
}

// El WiiM devuelve como título la URL del WAV que le pasamos: .../api/cd/track/7.wav
function trackFromUrl(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/\/api\/cd\/track\/(\d+)\.wav/);
  return m ? parseInt(m[1]) : null;
}

// Input names as the device reports them, written the way the buttons read.
const SOURCE_NAMES = {
  wifi: 'Wi-Fi', bluetooth: 'Bluetooth', 'line-in': 'Line-In', line_in: 'Line-In',
  optical: 'Óptica', hdmi: 'HDMI', udisk: 'USB',
};

// El estado llega una vez por segundo; el texto casi nunca cambia. Solo cuando
// cambia de verdad vale un fundido — salida corta, entrada mas tranquila — y la
// primera pintada entra sin animacion, que no hay nada de donde venir.
let lastTrackKey = null;
let trackSwapTimer = null;

function setTrackText(title, artist, album) {
  const key = `${title}|${artist}|${album}`;
  if (key === lastTrackKey) return;
  const first = lastTrackKey === null;
  lastTrackKey = key;

  const write = () => {
    $('track-title').textContent  = title;
    $('track-artist').textContent = artist;
    $('track-album').textContent  = album;
  };
  if (first) { write(); return; }

  const col = document.querySelector('.now-col');
  col.classList.add('is-swapping');
  if (trackSwapTimer) clearTimeout(trackSwapTimer);
  trackSwapTimer = setTimeout(() => {
    write();
    col.classList.remove('is-swapping');
  }, 140);
}

function updateUI(s) {
  // Status tag with animated dot
  const statusMap = { play: 'Reproduciendo', pause: 'Pausado', stop: 'Detenido', load: 'Cargando' };
  const statusEl = $('play-status');
  statusEl.textContent = statusMap[s.play_state] ?? s.play_state ?? '—';
  statusEl.classList.toggle('is-playing', s.is_playing === true);

  // Track. For a disc, the device reports our stream URL as the title, which is
  // no use to anyone — name the track instead.
  const onDisc = typeof s.title === 'string' && s.title.includes(CD_URL_MARK);
  // cd_track puede llegar vacío (el equipo pausado no siempre lo informa), y el
  // número está igual en la URL del stream que él mismo reporta como título.
  const num = s.cd_track ?? trackFromUrl(s.title);
  const named = onDisc ? cdTracks.find(t => t.number === num) : null;
  const title = onDisc
    ? (named?.title || (num ? `Tema ${num}` : cdAlbumTitle || 'Disco'))
    : s.title;
  setTrackText(
    title || 'Nada sonando',
    onDisc ? (cdAlbumArtist || 'CD') : (s.artist || ''),
    onDisc ? (cdAlbumTitle || '') : (s.album || ''));
  $('cd-tag').classList.toggle('hidden', !onDisc);

  maybeLoadLyrics(
    onDisc ? (named?.title || '') : (s.title || ''),
    onDisc ? (cdAlbumArtist || '') : (s.artist || ''),
    onDisc ? (cdAlbumTitle || '') : (s.album || ''),
    s.duration || 0);

  // Source, shown next to the status instead of only inside the settings panel
  const srcId = s.source ?? '';
  const srcChip = $('source-chip');
  const srcLabel = SOURCE_NAMES[srcId] || s.source_name || srcId;
  srcChip.textContent = srcLabel;
  srcChip.classList.toggle('hidden', !srcLabel || onDisc);

  $('dev-name').textContent = s.name || '—';

  refreshCover(s, onDisc);

  // Progress
  updateProgress(s.position ?? 0, s.duration ?? 0);
  restartProgressTimer(s);

  // Play button icon
  $('icon-play').classList.toggle('hidden', s.is_playing === true);
  $('icon-pause').classList.toggle('hidden', s.is_playing !== true);

  // Volume (only update slider if user isn't dragging)
  if (s.volume !== null && s.volume !== undefined && !isDragging) {
    $('vol-slider').value      = s.volume;
    $('vol-label').textContent = s.volume;
  }

  // Mute
  const muteBtn = $('btn-mute');
  muteBtn.classList.toggle('muted', s.muted === true);
  muteBtn.title = s.muted ? 'Desmutear' : 'Silenciar';

  // Source buttons
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
  if (num !== null && num !== undefined && num !== cdCurrent) markCdTrack(num);

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
        <span class="device-field-value">${esc(v)}</span>
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
  updateLyricsHighlight(pos);
  // scaleX del relleno + translateX del riel del knob, los dos con la misma
  // transicion lineal de 0.9s: van sincronizados y no tocan el layout.
  const p = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
  $('progress-fill').style.transform = `scaleX(${p})`;
  $('progress-knob-rail').style.transform = `translateX(${(p * 100).toFixed(3)}%)`;
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
  const sec = Math.round(Math.min(1, Math.max(0, ratio)) * localDur);
  await post(`/api/seek/${sec}`);
});

// --- Playback controls ---

// One transport for everything. When the disc is what's playing, prev/next/stop
// have to drive the CD endpoints — the device has no playlist of its own to
// step through, each track is a separate stream we push at it.
const onCd = () => cdCurrent !== null;

const doToggle = () => postCd('/api/transport');
const doPrev   = () => onCd() ? postCd('/api/cd/prev') : post('/api/prev');
const doNext   = () => onCd() ? postCd('/api/cd/next') : post('/api/next');
const doStop   = () => onCd() ? postCd('/api/cd/stop') : post('/api/stop');

$('btn-toggle').addEventListener('click', doToggle);
$('btn-prev').addEventListener('click',   doPrev);
$('btn-next').addEventListener('click',   doNext);
$('btn-stop').addEventListener('click',   doStop);

// --- Keyboard ---
//
// This is used mostly from a desktop, where reaching for the mouse to pause is
// the slowest thing on the page. Ignored while typing in a field.

document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;

  const nudge = delta => {
    const slider = $('vol-slider');
    const v = Math.min(100, Math.max(0, parseInt(slider.value || '0') + delta));
    slider.value = v;
    $('vol-label').textContent = v;
    post(`/api/volume/${v}`);
  };

  switch (e.key) {
    case ' ':          e.preventDefault(); doToggle(); break;
    case 'ArrowLeft':  e.preventDefault(); doPrev();   break;
    case 'ArrowRight': e.preventDefault(); doNext();   break;
    case 'ArrowUp':    e.preventDefault(); nudge(+5);  break;
    case 'ArrowDown':  e.preventDefault(); nudge(-5);  break;
    case 'm': case 'M': post(`/api/mute/${state.muted ? 0 : 1}`); break;
  }
});

// --- Volume ---

let isDragging = false;
let volDebounce = null;

$('vol-slider').addEventListener('mousedown', () => { isDragging = true; });
$('vol-slider').addEventListener('touchstart', () => { isDragging = true; }, { passive: true });
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

$('btn-theme').addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));

// --- Settings tabs ---
//
// Closed by default and one at a time: these are set once and then only get in
// the way of the thing the page is actually for.

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.panel;
    const wasOpen = tab.classList.contains('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (!wasOpen) {
      tab.classList.add('active');
      $(`panel-${target}`).classList.remove('hidden');
    }
    // Con un panel abierto la pantalla tiene que dar para todo: el CSS achica
    // la escena en vez de dejar que aparezca la barra de scroll.
    document.body.classList.toggle('panel-open', !wasOpen);
  });
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
  const statusEl = $('cd-status'), shapeEl = $('cd-shape');
  statusEl.textContent = 'Leyendo…';
  try {
    const s = await fetch('/api/cd/status').then(r => r.json());
    if (s.disc !== undefined) cdDisc = s.disc;
    if (s.status !== 'audio') {
      // No disc: the column disappears instead of sitting there empty, and the
      // stage closes up around what is playing.
      document.body.classList.remove('has-disc');
      statusEl.textContent = s.status === 'no_disc' ? 'Sin disco' : 'Disco sin audio';
      shapeEl.textContent = '';
      $('cd-tracks').innerHTML = '';
      $('btn-cd-identify').classList.add('hidden');
      $('cd-identify-panel').classList.add('hidden');
      cdTracks = [];
      return;
    }
    cdTracks = await fetch(`/api/cd/tracks${refresh ? '?refresh=true' : ''}`).then(r => r.json());
    document.body.classList.add('has-disc');
    const total = cdTracks.reduce((a, t) => a + t.seconds, 0);
    statusEl.textContent = s.identified && s.album
      ? `${s.album}${s.artist ? ' · ' + s.artist : ''}`
      : 'Disco sin identificar';
    shapeEl.textContent = `${cdTracks.length} temas · ${fmtTime(total)}`;
    // Always offered, never forced: an identification can also be corrected
    $('btn-cd-identify').classList.remove('hidden');
    $('btn-cd-identify').textContent = s.identified ? 'Cambiar' : 'Identificar';
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
  $('cd-tracks').innerHTML = cdTracks.map(t => `
    <button class="cd-track" data-track="${t.number}" title="${esc(t.title || 'Tema ' + t.number)}">
      <span class="cd-track-num">${t.number}</span>
      <span class="cd-track-name">${esc(t.title || 'Tema ' + t.number)}</span>
      <span class="cd-track-dur">${fmtTime(t.seconds)}</span>
      ${named ? `<span class="cd-track-edit${t.edited ? ' edited' : ''}" data-edit="${t.number}"
        role="button" tabindex="0" title="Corregir el nombre">✎</span>` : '<span></span>'}
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

// --- Lyrics ---

let lyricsStatus = 'none';
let lyricsLines = [];
let lyricsPlain = '';
let lastLyricsKey = null;
let activeLyricIdx = -1;

async function maybeLoadLyrics(title, artist, album, duration) {
  const key = `${artist}|${title}`;
  if (key === lastLyricsKey) return;
  lastLyricsKey = key;
  activeLyricIdx = -1;

  if (!title || !artist) {
    lyricsStatus = 'none'; lyricsLines = []; lyricsPlain = '';
    renderLyrics();
    return;
  }

  lyricsStatus = 'loading';
  renderLyrics();
  try {
    const params = new URLSearchParams({ artist, title });
    if (album) params.set('album', album);
    if (duration) params.set('duration', Math.round(duration));
    const data = await fetch(`/api/lyrics?${params}`).then(r => r.json());
    // A slow request can land after a later track already started loading —
    // never overwrite a newer key with a stale answer.
    if (key !== lastLyricsKey) return;
    lyricsStatus = data.status;
    lyricsLines = data.lines || [];
    lyricsPlain = data.plain || '';
  } catch {
    if (key !== lastLyricsKey) return;
    lyricsStatus = 'none';
  }
  renderLyrics();
}

function renderLyrics() {
  const box = $('lyrics-body');
  if (!box) return;
  activeLyricIdx = -1;
  if (lyricsStatus === 'loading') {
    box.innerHTML = '<p class="lyrics-empty">Buscando letra…</p>';
  } else if (lyricsStatus === 'synced') {
    box.innerHTML = lyricsLines.map((l, i) => `<p class="lyrics-line" data-i="${i}">${esc(l.text)}</p>`).join('');
  } else if (lyricsStatus === 'plain') {
    box.innerHTML = `<p class="lyrics-plain">${esc(lyricsPlain)}</p>`;
  } else if (lyricsStatus === 'instrumental') {
    box.innerHTML = '<p class="lyrics-empty">Instrumental — sin letra</p>';
  } else {
    box.innerHTML = '<p class="lyrics-empty">Sin letra para este tema</p>';
  }
}

// Piggybacks on the same 1s tick that already interpolates the progress bar —
// no extra timer just to follow along with the lyrics.
function updateLyricsHighlight(pos) {
  if (lyricsStatus !== 'synced' || !lyricsLines.length) return;
  let idx = -1;
  for (let i = 0; i < lyricsLines.length; i++) {
    if (lyricsLines[i].time <= pos) idx = i; else break;
  }
  if (idx === activeLyricIdx) return;
  const box = $('lyrics-body');
  if (!box) return;
  box.querySelector('.lyrics-line.active')?.classList.remove('active');
  activeLyricIdx = idx;
  const el = idx >= 0 ? box.querySelector(`.lyrics-line[data-i="${idx}"]`) : null;
  if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

// --- Spotify ---

async function loadSpotifyStatus() {
  try {
    const s = await fetch('/api/spotify/status').then(r => r.json());
    $('spotify-login').classList.toggle('hidden', s.authenticated);
    $('spotify-search-row').classList.toggle('hidden', !s.authenticated);
    if (!s.configured) {
      $('spotify-login').textContent = 'Falta configurar SPOTIFY_CLIENT_ID en .env';
      $('spotify-login').removeAttribute('href');
    }
  } catch {}
}

async function spotifySearch() {
  const q = $('spotify-search').value.trim();
  if (!q) return;
  const box = $('spotify-results');
  box.innerHTML = '<div class="cd-candidate">Buscando…</div>';
  try {
    const r = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({ detail: r.statusText }));
      box.innerHTML = `<div class="cd-candidate">${esc(err.detail)}</div>`;
      return;
    }
    const results = await r.json();
    if (!Array.isArray(results) || !results.length) {
      box.innerHTML = '<div class="cd-candidate">Sin resultados</div>';
      return;
    }
    box.innerHTML = results.map(t => `
      <button class="cd-candidate spotify-result" data-uri="${esc(t.uri)}">
        <span class="cd-candidate-album">${esc(t.name)}</span>
        <span>${esc(t.artist)}</span>
        <span class="cd-candidate-meta">${esc(t.album)}</span>
      </button>`).join('');
    box.querySelectorAll('.spotify-result').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const resp = await fetch('/api/spotify/play', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: btn.dataset.uri }),
        });
        btn.disabled = false;
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: resp.statusText }));
          alert(err.detail);
        }
      });
    });
  } catch {
    box.innerHTML = '<div class="cd-candidate">Error al buscar</div>';
  }
}

$('btn-spotify-search').addEventListener('click', spotifySearch);
$('spotify-search').addEventListener('keydown', e => { if (e.key === 'Enter') spotifySearch(); });

// Build sliders on page load (before WS connects)
buildEqBands();

// El tema ya lo fijó el script del <head> para que no haya un fogonazo blanco
// antes de pintar; acá solo se sincronizan los iconos y el acento.
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);

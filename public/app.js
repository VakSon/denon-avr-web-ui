// app.js — front-end for the Denon Web UI.
// Talks to the local server's REST API and listens to the SSE stream for live
// state, so the UI updates instantly when the receiver changes (even from its
// own remote).

const state = { devices: new Map(), selected: null, dragging: false };

// Common Denon input sources (SI codes) and surround modes (MS values).
const INPUTS = [
  ['TV', 'TV Audio'], ['CBL/SAT', 'Cable/Sat'], ['DVD', 'DVD'], ['BD', 'Blu-ray'],
  ['GAME', 'Game'], ['MPLAY', 'Media Player'], ['CD', 'CD'], ['TUNER', 'Tuner'],
  ['NET', 'Network'], ['BT', 'Bluetooth'], ['AUX1', 'Aux 1'], ['PHONO', 'Phono'],
];
const SURROUND = [
  ['MOVIE', 'Movie'], ['MUSIC', 'Music'], ['GAME', 'Game'], ['AUTO', 'Auto'],
  ['STEREO', 'Stereo'], ['DIRECT', 'Direct'], ['PURE DIRECT', 'Pure Direct'],
  ['DOLBY DIGITAL', 'Dolby'], ['MCH STEREO', 'Multi Ch Stereo'],
];

// Friendly names + preferred display order for the per-channel level trims.
const CHANNEL_NAMES = {
  FL: 'Front Left', FR: 'Front Right', C: 'Center', SW: 'Subwoofer', SW2: 'Subwoofer 2',
  SL: 'Surround Left', SR: 'Surround Right', SBL: 'Surr. Back Left', SBR: 'Surr. Back Right',
  SB: 'Surround Back', FHL: 'Front Height L', FHR: 'Front Height R',
  TFL: 'Top Front L', TFR: 'Top Front R', TML: 'Top Middle L', TMR: 'Top Middle R',
  TRL: 'Top Rear L', TRR: 'Top Rear R', FWL: 'Front Wide L', FWR: 'Front Wide R',
};
const CHANNEL_ORDER = ['FL', 'FR', 'C', 'SW', 'SW2', 'SL', 'SR', 'SBL', 'SBR', 'SB',
  'FHL', 'FHR', 'FWL', 'FWR', 'TFL', 'TFR', 'TML', 'TMR', 'TRL', 'TRR'];
// Channels that count as "height/overhead" for the X.Y.Z layout label.
const HEIGHT_CH = new Set(['FHL', 'FHR', 'TFL', 'TFR', 'TML', 'TMR', 'TRL', 'TRR',
  'RHL', 'RHR', 'FWL', 'FWR', 'FDL', 'FDR', 'SDL', 'SDR', 'BDL', 'BDR']);

// Derive a "5.1" / "2.0" / "7.1.2" style label from the active channels.
function speakerLayout(channels) {
  const keys = Object.keys(channels || {});
  if (!keys.length) return null;
  const subs = keys.filter((k) => k.startsWith('SW')).length;
  const height = keys.filter((k) => HEIGHT_CH.has(k)).length;
  const base = keys.filter((k) => !k.startsWith('SW') && !HEIGHT_CH.has(k)).length;
  return `${base}.${subs}` + (height ? `.${height}` : '');
}
const fmtDb = (db) => (db > 0 ? '+' : '') + db.toFixed(1);

// Denon master volume is an internal 0..98 scale where 80 = 0.0 dB (reference).
// The UI shows the receiver's own relative scale, e.g. -40.5 dB .. +12 dB.
const VOL_REF = 80;
const toDb = (internal) => internal - VOL_REF;
const fromDb = (db) => db + VOL_REF;

// A small "?" icon with a hover explanation.
function help(text) {
  return `<span class="help" data-tip="${escapeHtml(text)}">?</span>`;
}

// Input source labels come from the receiver itself (SSFUN?), so a source you
// renamed on the AVR (e.g. DVD -> PC) shows up here automatically. On top of
// that you can set an override, which is stored server-side (in receivers.json)
// so it survives restarts and is shared across browsers.
const DEFAULT_INPUT_LABEL = Object.fromEntries(INPUTS);

// Name reported by the receiver for a source code, if any.
function receiverName(code) {
  const d = state.devices.get(state.selected);
  return d && d.sourceNames ? d.sourceNames[code] : undefined;
}
// The user's saved override for a source code, if any.
function overrideName(code) {
  const d = state.devices.get(state.selected);
  return d && d.customLabels ? d.customLabels[code] : undefined;
}
// Priority: user override > receiver's own name > built-in default > raw code.
const inputLabel = (code) => overrideName(code) || receiverName(code) || DEFAULT_INPUT_LABEL[code] || code;

function renameInput(code) {
  const base = receiverName(code) || DEFAULT_INPUT_LABEL[code] || code;
  const name = prompt(`Rename input "${code}" to:`, overrideName(code) || base);
  if (name === null) return;
  const trimmed = name.trim();
  // Clearing it (or matching the receiver's own name) removes the override.
  act(state.selected, 'labels', { code, name: trimmed === base ? '' : trimmed });
}

// Handy reference of common Denon control codes for the raw-command box.
const RAW_COMMANDS = [
  ['PWON', 'Power on'],
  ['PWSTANDBY', 'Power off (standby)'],
  ['ZMON', 'Main zone on'],
  ['ZMOFF', 'Main zone off'],
  ['MVUP', 'Volume up one step'],
  ['MVDOWN', 'Volume down one step'],
  ['MV60', 'Set volume (internal 00–98, 80 = 0 dB)'],
  ['MUON', 'Mute on'],
  ['MUOFF', 'Mute off'],
  ['SIDVD', 'Input: DVD'],
  ['SITV', 'Input: TV Audio'],
  ['SITUNER', 'Input: Tuner'],
  ['SIBD', 'Input: Blu-ray'],
  ['SIGAME', 'Input: Game'],
  ['SINET', 'Input: Network / streaming'],
  ['SIBT', 'Input: Bluetooth'],
  ['MSMOVIE', 'Sound mode: Movie'],
  ['MSMUSIC', 'Sound mode: Music'],
  ['MSSTEREO', 'Sound mode: Stereo'],
  ['MSDIRECT', 'Sound mode: Direct'],
  ['MSAUTO', 'Sound mode: Auto'],
  ['CVC 51', 'Center channel +1 dB (50 = 0 dB)'],
  ['CVSW 52', 'Subwoofer +2 dB'],
  ['PSBAS UP', 'Bass +'],
  ['PSTRE UP', 'Treble +'],
  ['Z2ON', 'Zone 2 on'],
  ['Z2OFF', 'Zone 2 off'],
  ['SLP30', 'Sleep timer 30 min (SLPOFF = off)'],
  ['SSINFAISSIG ?', 'Query current input signal format'],
  ['MV?', 'Query current volume'],
];

const $ = (s, r = document) => r.querySelector(s);

// ---- API helpers ----
async function api(pathname, method = 'GET', body) {
  const res = await fetch('/api' + pathname, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json().catch(() => ({})) : Promise.reject(res);
}
// Merge a fresh device-state object (from an SSE push or an action response)
// into our local map and re-render.
function applyDeviceState(s) {
  if (!s || !s.id) return;
  state.devices.set(s.id, s);
  renderList();
  if (state.selected === s.id) renderPanel();
}

// Fire an action; when the server replies with the receiver's updated state,
// apply it. This is what keeps the UI correct even if the live SSE stream is
// blocked (some proxies/browsers buffer server-sent events).
const act = (id, action, body) =>
  api(`/devices/${id}/${action}`, 'POST', body).then(applyDeviceState).catch(() => {});

// Apply an immediate local state change so the UI responds instantly, without
// waiting for the receiver to echo the change back over the (sometimes laggy)
// telnet link. The action response / SSE reconciles this shortly after.
function optimistic(id, patch) {
  const d = state.devices.get(id);
  if (!d) return;
  Object.assign(d, patch);
  renderList();
  if (state.selected === id) renderPanel();
}

// ---- Live stream ----
function connectStream() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      msg.devices.forEach((d) => state.devices.set(d.id, d));
      if (!state.selected && msg.devices[0]) state.selected = msg.devices[0].id;
      renderAll();
    } else if (msg.type === 'status') {
      applyDeviceState(msg.device);
    }
  };
  es.onerror = () => {/* EventSource auto-reconnects */};
}

// ---- Render: sidebar list ----
function renderList() {
  const list = $('#deviceList');
  const devices = [...state.devices.values()];
  $('#noDevices').style.display = devices.length ? 'none' : 'block';
  list.innerHTML = '';
  for (const d of devices) {
    const li = document.createElement('li');
    li.className = d.id === state.selected ? 'active' : '';
    li.innerHTML = `
      <span class="dot ${d.connected ? 'online' : ''}"></span>
      <span class="meta">
        <span class="name">${escapeHtml(d.name)}</span>
        <span class="host">${escapeHtml(d.host)}${d.connected ? '' : ' · offline'}</span>
      </span>`;
    li.onclick = () => { state.selected = d.id; renderAll(); };
    list.appendChild(li);
  }
}

// ---- Render: control panel ----
function renderPanel() {
  const panel = $('#panel');
  const d = state.devices.get(state.selected);
  if (!d) { panel.innerHTML = '<div class="empty"><p>Select a receiver on the left, or add one to get started.</p></div>'; return; }

  const powerOn = d.power === 'on';
  const vol = d.volume ?? 0;
  const volMax = d.volumeMax ?? 98;
  const volDb = toDb(vol);
  const volDbMax = toDb(volMax);

  panel.innerHTML = `
    <div class="card">
      <div class="device-head">
        <div>
          <div class="title">${escapeHtml(d.name)}</div>
          <div class="sub">${escapeHtml(d.host)} ·
            <span class="badge ${d.connected ? 'on' : ''}">${d.connected ? 'connected' : 'connecting…'}</span>
          </div>
        </div>
        <button class="power-toggle ${powerOn ? 'on' : ''}" id="powerBtn" title="Power">⏻</button>
      </div>
    </div>

    <div class="card">
      <h3>Volume</h3>
      <div class="row spread">
        <div class="vol-value">${volDb.toFixed(1)}<small> dB</small></div>
        <div class="row">
          <button class="icon" id="volDown">−</button>
          <button class="icon" id="volUp">+</button>
          <button class="pill ${d.muted ? 'active' : ''}" id="muteBtn">${d.muted ? '🔇 Muted' : '🔊 Mute'}</button>
        </div>
      </div>
      <input type="range" id="volSlider" min="-80" max="${volDbMax}" step="0.5" value="${volDb}" ${powerOn ? '' : 'disabled'} />
      <div class="row spread"><span class="hint">−80 dB</span><span class="hint">${volDbMax.toFixed(0)} dB (max)</span></div>
    </div>

    <div class="card">
      <div class="row spread">
        <h3 style="margin:0">Input source ${d.input ? `<span class="badge on">now: ${escapeHtml(inputLabel(d.input))}</span>` : ''}</h3>
        <button class="ghost pill" id="editInputs">${state.editInputs ? '✓ Done' : '✎ Rename'}</button>
      </div>
      <div class="chips" id="inputs" style="margin-top:12px">
        ${inputChips(d).map(([code, label]) =>
          `<button class="pill ${d.input === code ? 'active' : ''} ${state.editInputs ? 'editing' : ''}" data-input="${code}">${escapeHtml(label)}${state.editInputs ? ' ✎' : ''}</button>`).join('')}
      </div>
      ${state.editInputs ? '<p class="hint" style="margin-top:10px">Names come from the receiver. Click an input to set a local override (saved in this browser only).</p>' : ''}
    </div>

    <div class="card">
      <h3>Sound mode</h3>
      <div class="chips" id="surround">
        ${SURROUND.map(([code, label]) =>
          `<button class="pill ${d.surround === code ? 'active' : ''}" data-surround="${code}">${label}</button>`).join('')}
      </div>
    </div>

    ${renderNowPlaying(d)}
    ${renderChannels(d)}

    <div class="card">
      <h3>Advanced — raw command</h3>
      <div class="raw-row">
        <input type="text" id="rawInput" placeholder="e.g. PWON, MV55, SITUNER" autocomplete="off" />
        <button class="primary" id="rawSend">Send</button>
      </div>
      <p class="hint">Sends a raw Denon control command over telnet. Click a command below to drop it into the box.</p>
      <details class="rawref">
        <summary>Common commands ${help('Click a command to drop it into the box above, then edit and send.')}</summary>
        <table>${RAW_COMMANDS.map(([cmd, desc]) =>
          `<tr><td><button class="rawcmd" data-cmd="${escapeHtml(cmd)}">${escapeHtml(cmd)}</button></td><td>${escapeHtml(desc)}</td></tr>`).join('')}</table>
      </details>
      <div class="row" style="margin-top:14px">
        <button class="ghost" id="refreshBtn">↻ Refresh state</button>
        <button class="danger" id="removeBtn">Remove receiver</button>
      </div>
    </div>
  `;

  const id = d.id;
  $('#powerBtn').onclick = () => { optimistic(id, { power: powerOn ? 'off' : 'on' }); act(id, 'power', { on: !powerOn }); };
  $('#muteBtn').onclick = () => { optimistic(id, { muted: !d.muted }); act(id, 'mute', { on: !d.muted }); };
  $('#volUp').onclick = () => act(id, 'volume/up');
  $('#volDown').onclick = () => act(id, 'volume/down');

  const slider = $('#volSlider');
  slider.oninput = () => { state.dragging = true; $('.vol-value').firstChild.nodeValue = Number(slider.value).toFixed(1); };
  slider.onchange = () => { state.dragging = false; act(id, 'volume', { value: fromDb(Number(slider.value)) }); };

  $('#editInputs').onclick = () => { state.editInputs = !state.editInputs; renderPanel(); };
  $('#inputs').querySelectorAll('[data-input]').forEach((b) =>
    b.onclick = () => {
      if (state.editInputs) renameInput(b.dataset.input);
      else { optimistic(id, { input: b.dataset.input }); act(id, 'input', { source: b.dataset.input }); }
    });
  $('#surround').querySelectorAll('[data-surround]').forEach((b) =>
    b.onclick = () => { optimistic(id, { surround: b.dataset.surround }); act(id, 'surround', { mode: b.dataset.surround }); });

  panel.querySelectorAll('[data-ch]').forEach((b) => {
    b.onclick = () => {
      const ch = b.dataset.ch;
      const cur = (d.channels && d.channels[ch]) || 0;
      const db = Math.max(-12, Math.min(12, cur + Number(b.dataset.dir) * 0.5));
      act(id, 'channel', { channel: ch, db });
    };
  });

  const rawSend = () => { const v = $('#rawInput').value.trim(); if (v) { act(id, 'raw', { command: v }); $('#rawInput').value = ''; } };
  $('#rawSend').onclick = rawSend;
  panel.querySelectorAll('.rawcmd').forEach((b) =>
    b.onclick = (e) => { e.preventDefault(); $('#rawInput').value = b.dataset.cmd; $('#rawInput').focus(); });
  $('#rawInput').onkeydown = (e) => { if (e.key === 'Enter') rawSend(); };

  $('#refreshBtn').onclick = () => act(id, 'refresh');
  $('#removeBtn').onclick = async () => {
    if (!confirm(`Remove "${d.name}"?`)) return;
    await api(`/devices/${id}`, 'DELETE');
    state.devices.delete(id);
    if (state.selected === id) state.selected = [...state.devices.keys()][0] || null;
    renderAll();
  };
}

// Build the list of [code, label] input chips, always including the currently
// active input even if it isn't one of the common presets.
function inputChips(d) {
  // Prefer the actual sources the receiver reports; fall back to the presets.
  const recvCodes = d.sourceNames ? Object.keys(d.sourceNames) : [];
  const list = recvCodes.length
    ? recvCodes.map((code) => [code, inputLabel(code)])
    : INPUTS.map(([code]) => [code, inputLabel(code)]);
  if (d.input && !list.some(([c]) => c === d.input)) list.unshift([d.input, inputLabel(d.input)]);
  return list;
}

// "Now playing" — what the receiver is actually outputting.
function renderNowPlaying(d) {
  const layout = speakerLayout(d.channels);
  const cells = [
    ['Speaker output', layout || '—',
      'How many speakers the receiver is driving: X.Y.Z = X main + Y subwoofers + Z height/overhead (e.g. 5.1). Derived from the active channels. Note: when a stereo source is upmixed (Multi Ch Stereo, Dolby Surround) this can show more channels even though the input is only 2.0.'],
    ['Sound mode', d.surround ? titleCase(d.surround) : '—',
      'The audio processing mode the receiver is applying right now — the decoder/upmixer: Stereo, Direct, Dolby Digital, Multi Ch Stereo, Movie/Music, etc. It decides how the source is played across the speakers.'],
    ['Input signal', d.signalFormat || '—',
      'The audio format coming FROM the source (Dolby Digital, DTS, PCM, Analog…). This is the best hint for whether the source is really sending stereo or surround. Some older models do not report this over the network — then it shows "—".'],
    ['Sample rate', d.sampleRate ? d.sampleRate.replace('K', ' kHz') : '—',
      'Sample rate of the incoming signal (48 kHz = typical video, 96/192 kHz = hi-res audio).'],
  ];
  return `
    <div class="card">
      <h3>Now playing</h3>
      <div class="nowplaying">
        ${cells.map(([k, v, tip]) => `<div class="np-cell"><span class="np-label">${k} ${help(tip)}</span><span class="np-value">${escapeHtml(String(v))}</span></div>`).join('')}
      </div>
    </div>`;
}

// Per-channel level trims (subwoofer, center, surrounds, …).
function renderChannels(d) {
  const chans = d.channels || {};
  const keys = Object.keys(chans).sort((a, b) => {
    const ia = CHANNEL_ORDER.indexOf(a), ib = CHANNEL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (!keys.length) {
    return `<div class="card"><h3>Channel levels</h3>
      <p class="hint">No channel data yet — available once the receiver is on and connected.</p></div>`;
  }
  const rows = keys.map((ch) => {
    const db = chans[ch];
    return `
      <div class="ch-row">
        <span class="ch-name">${escapeHtml(CHANNEL_NAMES[ch] || ch)}</span>
        <div class="ch-ctrl">
          <button class="icon sm" data-ch="${ch}" data-dir="-1" ${db <= -12 ? 'disabled' : ''}>−</button>
          <span class="ch-db ${db > 0 ? 'pos' : db < 0 ? 'neg' : ''}">${fmtDb(db)} dB</span>
          <button class="icon sm" data-ch="${ch}" data-dir="1" ${db >= 12 ? 'disabled' : ''}>＋</button>
        </div>
      </div>`;
  }).join('');
  return `<div class="card"><h3>Channel levels</h3><div class="ch-grid">${rows}</div></div>`;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderAll() { renderList(); renderPanel(); }

// Avoid stomping the slider while the user is dragging.
const _origRenderPanel = renderPanel;
renderPanel = function () { if (state.dragging) return; _origRenderPanel(); };

// ---- Add-receiver dialog ----
const dialog = $('#addDialog');
$('#addBtn').onclick = () => { $('#addForm').reset(); dialog.showModal(); };
$('#addCancel').onclick = () => dialog.close();
$('#addForm').onsubmit = async (e) => {
  const data = new FormData(e.target);
  const host = (data.get('host') || '').trim();
  if (!host) return;
  try {
    const dev = await api('/devices', 'POST', { host, name: (data.get('name') || '').trim() });
    state.devices.set(dev.id, dev);
    state.selected = dev.id;
    renderAll();
  } catch { alert('Could not add receiver.'); }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

connectStream();

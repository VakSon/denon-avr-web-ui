// denon.js — Denon/Marantz AVR control over the telnet protocol (TCP port 23).
//
// Denon AVRs expose a plain-text control protocol. You open a TCP socket to
// port 23, send commands terminated by a carriage return (\r) and the receiver
// replies with status lines (also \r-terminated). The same lines are pushed
// unsolicited whenever the receiver state changes (e.g. someone uses the remote),
// which lets us keep a live mirror of the device state.
//
// Command reference (most common ones):
//   PW?            -> PWON / PWSTANDBY          main power
//   ZMON / ZMOFF   main-zone on/off             ZM?
//   MV?            -> MV50 / MV505 (=50.5)       master volume (0..98, .5 steps)
//   MVUP / MVDOWN  step volume
//   MV50           set volume to 50
//   MU?            -> MUON / MUOFF              mute
//   SI?            -> SIDVD / SITV / ...        input source select
//   MS?            -> MSMOVIE / MSSTEREO / ...  surround mode

import net from 'node:net';
import { EventEmitter } from 'node:events';

const PORT = Number(process.env.DENON_PORT) || 23;
const RECONNECT_MS = 4000;
// Denon requires a small gap between commands or it drops them.
const COMMAND_GAP_MS = 60;

// Best-effort decode of the input-signal-format code reported by SSINFAISSIG.
// Falls back to the raw code when a model uses a value we don't recognise.
const SIGNAL_MAP = {
  '01': 'Analog', '02': 'PCM', '03': 'Dolby Digital', '04': 'Dolby Digital+',
  '05': 'Dolby TrueHD', '06': 'Dolby Atmos', '07': 'DTS', '08': 'DTS-HD',
  '09': 'DTS:X', '10': 'Multichannel PCM', '11': 'MPEG', '12': 'AAC',
};

export class DenonDevice extends EventEmitter {
  constructor(id, host, name, labels) {
    super();
    this.id = id;
    this.host = host;
    this.name = name || host;
    // User's local name overrides for input sources, e.g. { DVD: 'PC' }.
    // Persisted server-side so they survive restarts and are shared across browsers.
    this.labels = labels || {};
    this.socket = null;
    this.connected = false;
    this.buffer = '';
    this.queue = [];
    this.sending = false;
    this.reconnectTimer = null;
    this.closedByUser = false;

    // Mirror of the receiver's state, updated from its replies.
    this.state = {
      power: null,      // 'on' | 'off'
      volume: null,     // number, dB-ish 0..98
      volumeMax: null,  // number
      muted: null,      // boolean
      input: null,      // string e.g. 'TV', 'DVD'
      surround: null,   // string
      channels: {},     // { FL: +1.5, C: -2, SW: 0, ... } per-channel level in dB
      signalFormat: null, // decoded input signal format (e.g. 'Dolby Digital')
      sampleRate: null,   // input sample rate string (e.g. '48K')
      sourceNames: {},    // { DVD: 'PC', TV: 'TV Audio', ... } as named on the receiver
    };
  }

  connect() {
    this.closedByUser = false;
    if (this.socket) return;
    const socket = net.createConnection({ host: this.host, port: PORT });
    this.socket = socket;
    socket.setEncoding('ascii');
    socket.setTimeout(0);

    socket.on('connect', () => {
      this.connected = true;
      this.emit('status', this.publicState());
      // Query everything once we're connected to prime the state mirror.
      this.refresh();
    });

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('error', () => { /* handled by close */ });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.sending = false;
      this.emit('status', this.publicState());
      if (!this.closedByUser) {
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
      }
    });
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }

  // Ask the receiver for the current value of the main controls.
  refresh() {
    // CV? returns the level of every active channel (also tells us the speaker
    // layout). The SSINFAIS* queries report the current input signal.
    // SSFUN? returns each source's user-assigned name (e.g. renamed DVD -> PC).
    ['PW?', 'ZM?', 'MV?', 'MU?', 'SI?', 'MS?', 'CV?', 'SSFUN ?', 'SSINFAISSIG ?', 'SSINFAISFSV ?']
      .forEach((c) => this.send(c));
  }

  send(command) {
    this.queue.push(command);
    this._drain();
  }

  _drain() {
    if (this.sending || this.queue.length === 0) return;
    if (!this.socket || !this.connected) return;
    this.sending = true;
    const cmd = this.queue.shift();
    this.socket.write(cmd + '\r', () => {
      setTimeout(() => {
        this.sending = false;
        this._drain();
      }, COMMAND_GAP_MS);
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this._parse(line);
    }
  }

  _parse(line) {
    let changed = false;
    const set = (k, v) => {
      if (this.state[k] !== v) { this.state[k] = v; changed = true; }
    };

    if (line === 'PWON') set('power', 'on');
    else if (line === 'PWSTANDBY') set('power', 'off');
    else if (line === 'ZMON') set('power', 'on');
    else if (line === 'ZMOFF') set('power', 'off');
    else if (line === 'MUON') set('muted', true);
    else if (line === 'MUOFF') set('muted', false);
    else if (line.startsWith('MVMAX ')) {
      set('volumeMax', this._decodeVolume(line.slice(6)));
    } else if (line.startsWith('MV')) {
      const v = this._decodeVolume(line.slice(2));
      if (v !== null) set('volume', v);
    } else if (line.startsWith('SSFUN')) {
      // e.g. "SSFUNDVD PC" -> code "DVD", user name "PC". ("SSFUN END" is the
      // end-of-list marker and won't match because of the space.)
      const m = line.match(/^SSFUN(\S+) (.+)$/);
      if (m) {
        const code = m[1];
        const name = m[2].trim();
        if (this.state.sourceNames[code] !== name) {
          this.state.sourceNames = { ...this.state.sourceNames, [code]: name };
          changed = true;
        }
      }
    } else if (line.startsWith('SSINFAISSIG')) {
      const code = line.slice('SSINFAISSIG'.length).trim();
      set('signalFormat', SIGNAL_MAP[code] || code);
    } else if (line.startsWith('SSINFAISFSV')) {
      const v = line.slice('SSINFAISFSV'.length).trim();
      set('sampleRate', v === 'NON' ? null : v);
    } else if (line === 'CVEND') {
      /* end-of-list marker, nothing to store */
    } else if (line.startsWith('CV')) {
      // e.g. "CVFL 50" (0 dB), "CVC 44" (-6 dB), "CVSW 515" (+1.5 dB).
      const m = line.match(/^CV([A-Z0-9]+) (\d+)$/);
      if (m) {
        const dec = this._decodeVolume(m[2]);
        if (dec !== null) {
          const db = dec - 50; // Denon centres channel level on 50 = 0 dB
          if (this.state.channels[m[1]] !== db) {
            this.state.channels = { ...this.state.channels, [m[1]]: db };
            changed = true;
          }
        }
      }
    } else if (line.startsWith('SI')) {
      set('input', line.slice(2));
    } else if (line.startsWith('MS')) {
      set('surround', line.slice(2));
    }

    if (changed) this.emit('status', this.publicState());
  }

  // Denon volume: "50" -> 50, "505" -> 50.5, "80" -> 80.
  _decodeVolume(raw) {
    const digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length === 3) return parseInt(digits.slice(0, 2), 10) + 0.5;
    return parseInt(digits, 10);
  }

  // Encode a numeric volume back into Denon's wire format.
  _encodeVolume(v) {
    const clamped = Math.max(0, Math.min(v, this.state.volumeMax || 98));
    const whole = Math.floor(clamped);
    const half = clamped - whole >= 0.5;
    const s = String(whole).padStart(2, '0');
    return half ? s + '5' : s;
  }

  // ---- High-level actions used by the API ----
  setPower(on) { this.send(on ? 'ZMON' : 'ZMOFF'); }
  setMute(on) { this.send(on ? 'MUON' : 'MUOFF'); }
  volumeUp() { this.send('MVUP'); }
  volumeDown() { this.send('MVDOWN'); }
  setVolume(v) { this.send('MV' + this._encodeVolume(v)); }
  setInput(src) { this.send('SI' + src); }
  setSurround(mode) { this.send('MS' + mode); }

  // Set a single channel's trim level in dB (-12..+12, 0.5 steps).
  setChannel(channel, db) {
    const clamped = Math.max(-12, Math.min(12, db));
    const val = 50 + clamped; // wire value is centred on 50 = 0 dB
    const whole = Math.floor(val);
    const half = val - whole >= 0.5;
    const wire = String(whole).padStart(2, '0') + (half ? '5' : '');
    this.send('CV' + channel + ' ' + wire);
  }

  raw(cmd) { this.send(cmd); }

  // Set/clear a local display-name override for an input source. Returns true
  // if it changed (so the server knows to persist).
  setLabel(code, name) {
    const clean = (name || '').trim();
    if (clean) this.labels = { ...this.labels, [code]: clean };
    else { const { [code]: _drop, ...rest } = this.labels; this.labels = rest; }
    this.emit('status', this.publicState());
    return true;
  }

  publicState() {
    return {
      id: this.id,
      host: this.host,
      name: this.name,
      connected: this.connected,
      customLabels: this.labels,
      ...this.state,
    };
  }
}

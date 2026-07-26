'use strict';

const { EventEmitter } = require('events');

// Nordic UART Service, as used by Novy Pureline Pro / Cloud hoods.
// Protocol reverse-engineered by Bert Wynants (MIT):
// https://github.com/bwynants/hass-purelinepro — see PROTOCOL.md.
const UART_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
const UART_RX = '6e400002b5a3f393e0a9e50e24dcca9e'; // write: client -> hood
const UART_TX = '6e400003b5a3f393e0a9e50e24dcca9e'; // notify: hood -> client

const CMD = {
  POWER: 10,
  LIGHT_ON_AMBI: 15,
  LIGHT_ON_WHITE: 16,
  LIGHT_BRIGHTNESS: 21,
  LIGHT_COLORTEMP: 22,
  RESET_GREASE: 23,
  FAN_RECIRCULATE: 25,
  FAN_SPEED: 28,
  FAN_STATE: 29,
  LIGHT_OFF: 36,
  FAN_DEFAULT: 41,
  LIGHT_DEFAULT: 42,
  STATUS: 400,
  STATUS_402: 402,
  STATUS_403: 403,
  STATUS_404: 404,
};

const REQUEST_TIMEOUT_MS = 8000;
// The hood (or its BLE stack) drops the link when writes arrive back-to-back.
const WRITE_GAP_MS = 200;
const CONNECT_SETTLE_MS = 500;
const POLL_INTERVAL_MS = 5000;
// Every Nth poll also refresh the slow-changing extended status (402).
const EXTENDED_POLL_EVERY = 6;
const RECONNECT_BASE_MS = 5000;

class NovyHood extends EventEmitter {

  constructor({ homey, uuid, address, localName, log, error }) {
    super();
    this.setMaxListeners(20);
    this._homey = homey;
    this._uuid = uuid;
    this._address = address;
    this._localName = localName || '';
    this.log = log || (() => {});
    this.error = error || (() => {});

    this._peripheral = null;
    this._rxCharacteristic = null;
    this._connected = false;
    this._destroyed = false;
    this._connecting = null;

    // All GATT writes are serialised through this promise chain: the hood
    // answers every frame with exactly one notification and gets confused
    // by overlapping commands.
    this._queue = Promise.resolve();
    this._pendingCmd = null;
    this._pendingResolve = null;
    this._pendingTimer = null;

    this._pollTimer = null;
    this._pollCount = 0;
    this._reconnectAttempt = 0;
    this._autoOffTimer = null;

    this.state = {};
  }

  get address() {
    return this._address;
  }

  get localName() {
    return this._localName;
  }

  get connected() {
    return this._connected && this._peripheral && this._peripheral.isConnected;
  }

  /** Start the connection + polling loop. Resolves immediately; connection
   *  progress is reported via 'available' events. */
  start() {
    this._schedulePoll(0);
  }

  async destroy() {
    this._destroyed = true;
    this._cancelAutoOff();
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    await this._disconnect();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------
  // High-level commands (used by the Homey devices)
  // ---------------------------------------------------------------------

  async setFanState(on) {
    this._cancelAutoOff();
    await this._send(CMD.FAN_STATE, 1, on ? 1 : 0);
    await this._send(CMD.STATUS, 0);
  }

  async setFanSpeed(pct) {
    this._cancelAutoOff();
    const speed = Math.max(1, Math.min(100, Math.round(pct)));
    if (!this.state.fanState) await this._send(CMD.FAN_STATE, 1, 1);
    await this._send(CMD.FAN_SPEED, 1, speed);
    await this._send(CMD.STATUS, 0);
  }

  async boost() {
    await this.setFanSpeed(100);
  }

  /** Run-out mode, mirroring the reference implementation: light to ambient,
   *  fan down to its configured switch-off speed, then off after 5 minutes
   *  (30 in recirculation mode, where the plasma filter needs the airflow). */
  async runOut() {
    this._cancelAutoOff();
    const state = this.state;
    if (!state.fanState) return;
    if (state.lightState) await this._send(CMD.LIGHT_ON_AMBI, 0);
    const target = state.switchOffFanSpeed || 25;
    if (state.fanSpeed > target) await this._send(CMD.FAN_SPEED, 1, target);
    await this._send(CMD.STATUS, 0);
    const minutes = state.recirculate ? 30 : 5;
    this._autoOffTimer = setTimeout(() => {
      this._autoOffTimer = null;
      this.log('Run-out timer expired — turning fan off');
      this.setFanState(false).catch(err => this.error(`Run-out auto-off failed: ${err}`));
    }, minutes * 60 * 1000);
  }

  _cancelAutoOff() {
    if (this._autoOffTimer) {
      clearTimeout(this._autoOffTimer);
      this._autoOffTimer = null;
    }
  }

  async setLight(on, { brightness, colortemp } = {}) {
    if (!on) {
      await this._send(CMD.LIGHT_OFF, 0);
      await this._send(CMD.STATUS, 0);
      return;
    }
    // The hood has two presets: warm/amber "ambi" and cool "white". Mirror the
    // reference implementation: pick the preset from the requested colour
    // temperature, then apply exact brightness/temperature values.
    const rawColortemp = colortemp !== undefined ? colortemp : (this.state.colortemp || 0);
    if (!this.state.lightState) {
      await this._send(rawColortemp > 127 ? CMD.LIGHT_ON_AMBI : CMD.LIGHT_ON_WHITE, 0);
    }
    if (brightness !== undefined && brightness !== this.state.brightness) {
      await this._send(CMD.LIGHT_BRIGHTNESS, 1, Math.max(1, Math.min(255, Math.round(brightness))));
    }
    if (colortemp !== undefined && colortemp !== this.state.colortemp) {
      await this._send(CMD.LIGHT_COLORTEMP, 1, Math.max(0, Math.min(255, Math.round(colortemp))));
    }
    await this._send(CMD.STATUS, 0);
  }

  async setRecirculate(on) {
    await this._send(CMD.FAN_RECIRCULATE, 1, on ? 1 : 0);
    await this._send(CMD.STATUS_402, 0);
  }

  async resetGrease() {
    // The hood sends no ACK for this command.
    await this._send(CMD.RESET_GREASE, 0, { expectResponse: false });
  }

  async pressPower() {
    await this._send(CMD.POWER, 0);
    await this._send(CMD.STATUS, 0);
  }

  // ---------------------------------------------------------------------
  // Command queue
  // ---------------------------------------------------------------------

  _send(cmdId, ...args) {
    let opts = {};
    if (args.length && typeof args[args.length - 1] === 'object') {
      opts = args.pop();
    }
    const run = this._queue.then(() => this._doSend(cmdId, args, opts));
    // Keep the chain alive after failures; the caller still sees the error.
    this._queue = run.catch(() => {});
    return run;
  }

  async _doSend(cmdId, args, { expectResponse = true } = {}) {
    if (this._destroyed) throw new Error('Hood connection destroyed');
    await this._ensureConnected();

    const frame = args.length ? `[${cmdId};${args.join(';')}]` : `[${cmdId}]`;

    try {
      const response = new Promise((resolve, reject) => {
        if (!expectResponse) return resolve(null);
        this._pendingCmd = cmdId;
        this._pendingResolve = resolve;
        this._pendingTimer = setTimeout(() => {
          this._clearPending();
          reject(new Error(`Command ${frame} timed out`));
        }, REQUEST_TIMEOUT_MS);
      });

      await this._rxCharacteristic.write(Buffer.from(frame, 'ascii'));
      await response;
      await delay(WRITE_GAP_MS);
    } catch (err) {
      this._clearPending();
      // A failed write almost always means the link is gone — reconnect lazily.
      if (!String(err).includes('timed out')) this._handleDisconnect(err);
      throw err;
    }
  }

  _clearPending() {
    if (this._pendingTimer) clearTimeout(this._pendingTimer);
    this._pendingCmd = null;
    this._pendingResolve = null;
    this._pendingTimer = null;
  }

  // ---------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------

  async _ensureConnected() {
    if (this.connected) return;
    if (!this._connecting) {
      this._connecting = this._connect().finally(() => { this._connecting = null; });
    }
    await this._connecting;
  }

  async _connect() {
    this.log(`Connecting to Novy hood ${this._address || this._uuid}`);
    this._connected = false;

    const advertisement = await this._homey.ble.find(this._uuid);
    const peripheral = await advertisement.connect();

    try {
      // The hood drops the link when GATT traffic starts immediately.
      await delay(CONNECT_SETTLE_MS);
      await peripheral.discoverAllServicesAndCharacteristics();
      const service = await peripheral.getService(UART_SERVICE);
      const tx = await service.getCharacteristic(UART_TX);
      this._rxCharacteristic = await service.getCharacteristic(UART_RX);
      // Subscribe before any command: frames sent without an active
      // subscription are silently dropped by the hood.
      await tx.subscribeToNotifications(data => this._onNotification(data));
    } catch (err) {
      try { await peripheral.disconnect(); } catch (e) { /* already gone */ }
      throw err;
    }

    this._peripheral = peripheral;
    this._connected = true;
    this._reconnectAttempt = 0;
    this.log('Connected');
    this.emit('available', true);
  }

  async _disconnect() {
    this._connected = false;
    this._clearPending();
    const peripheral = this._peripheral;
    this._peripheral = null;
    this._rxCharacteristic = null;
    if (peripheral) {
      try { await peripheral.disconnect(); } catch (err) { /* already gone */ }
    }
  }

  _handleDisconnect(err) {
    if (!this._connected) return;
    this.error(`Connection lost: ${err}`);
    this._connected = false;
    this._peripheral = null;
    this._rxCharacteristic = null;
    this._clearPending();
    this.emit('available', false);
  }

  // ---------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------

  _schedulePoll(delayMs) {
    if (this._destroyed) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => {
      this._poll().catch(err => this.error(`Poll failed: ${err}`));
    }, delayMs);
  }

  async _poll() {
    if (this._destroyed) return;
    try {
      if (this._pollCount % EXTENDED_POLL_EVERY === 0) {
        await this._send(CMD.STATUS_402, 0);
        await this._send(CMD.STATUS_403, 0);
        await this._send(CMD.STATUS_404, 0);
      }
      await this._send(CMD.STATUS, 0);
      this._pollCount += 1;
      this._schedulePoll(POLL_INTERVAL_MS);
    } catch (err) {
      // Back off: 5s, 7.5s, 11s ... capped at ~60s.
      this._reconnectAttempt = Math.min(this._reconnectAttempt + 1, 6);
      const backoff = Math.min(RECONNECT_BASE_MS * (1.5 ** this._reconnectAttempt), 60000);
      this.error(`Poll/connect failed (${err}); retrying in ${Math.round(backoff / 1000)}s`);
      this._schedulePoll(backoff);
    }
  }

  // ---------------------------------------------------------------------
  // Notifications & packet parsing
  // ---------------------------------------------------------------------

  _onNotification(data) {
    const pendingCmd = this._pendingCmd;
    const resolve = this._pendingResolve;
    this._clearPending();

    try {
      // ACK frames arrive as ASCII "[...]"; status packets are binary.
      if (data.length >= 2 && data[0] === 0x5B && data[data.length - 1] === 0x5D) {
        // ACK for a control command — nothing to parse.
      } else if (pendingCmd === CMD.STATUS) {
        this._applyState(parse400(data));
      } else if (pendingCmd === CMD.STATUS_402) {
        this._applyState(parse402(data));
      } else if (pendingCmd === CMD.STATUS_403) {
        this._applyState(parse403(data));
      } else if (pendingCmd === CMD.STATUS_404) {
        this._applyState(parse404(data));
      } else if (data.length === 16) {
        // The hood delivers some notifications twice; an unsolicited 16-byte
        // packet is simply the main status — parse it as a free update.
        this._applyState(parse400(data));
      } else {
        // Unsolicited 20-byte packets are ambiguous (402 vs 404) — ignore.
      }
    } catch (err) {
      this.error(`Failed to parse notification: ${err}`);
    }

    if (resolve) resolve(data);
  }

  _applyState(update) {
    if (!update) return;
    Object.assign(this.state, update);
    this.emit('state', this.state);
  }
}

// ---------------------------------------------------------------------
// Packet parsers — layouts documented in PROTOCOL.md. Multi-byte counters
// are big-endian values inside an otherwise little-endian struct, so we
// read them big-endian directly.
// ---------------------------------------------------------------------

function parse400(buf) {
  if (buf.length !== 16) throw new Error(`Packet400: expected 16 bytes, got ${buf.length}`);
  const flags1 = buf.readUInt8(0);
  const fanSpeed = buf.readUInt8(1);
  const flags2 = buf.readUInt8(2);
  const lightMode = buf.readUInt8(5);
  const brightness = buf.readUInt8(6);
  const colortemp = buf.readUInt8(7);
  const timerActive = (flags1 & 0x02) !== 0;
  return {
    fanState: fanSpeed > 0,
    fanSpeed,
    greaseDirty: (flags2 & 0x01) !== 0,
    lightMode,
    lightState: brightness > 0,
    brightness,
    colortemp,
    boost: timerActive && fanSpeed > 75,
    stopping: timerActive && fanSpeed <= 75,
    timerSeconds: timerActive ? buf.readUInt16BE(8) : 0,
  };
}

function parse402(buf) {
  if (buf.length !== 20) throw new Error(`Packet402: expected 20 bytes, got ${buf.length}`);
  return {
    recirculate: (buf.readUInt8(2) & 0x01) !== 0,
    greaseMinutes: Math.floor(buf.readUInt32BE(4) / 60),
    firmwareVersion: `${buf.readUInt8(8)}.${buf.readUInt8(9)}.${buf.readUInt8(10)}`,
  };
}

function parse403(buf) {
  if (buf.length < 20) throw new Error(`Packet403: expected >=20 bytes, got ${buf.length}`);
  return {
    switchOffFanSpeed: buf.readUInt8(0),
    fanOperatingMinutes: Math.floor(buf.readUInt32BE(10) / 60),
  };
}

function parse404(buf) {
  if (buf.length < 17) throw new Error(`Packet404: expected >=17 bytes, got ${buf.length}`);
  // Packed layout IIIBIBH — the LED timer is the uint32 at offset 13.
  return {
    ledOperatingMinutes: Math.floor(buf.readUInt32BE(13) / 60),
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { NovyHood, CMD, UART_SERVICE, UART_RX, UART_TX };

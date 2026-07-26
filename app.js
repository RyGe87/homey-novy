'use strict';

const Homey = require('homey');
const { NovyHood } = require('./lib/NovyHood');

// InTouch frame = address bits + button code (see PROTOCOL.md / README).
const HOB_ADDRESS = '0101010101';
// Homey's own address, used when the hood is paired to Homey instead of the
// hob/remote. Any 10-bit pattern works — the hood learns it during pairing.
const HOMEY_ADDRESS = '1001101001';
const INTOUCH_TX_UNITS = {
  light: '11010001',
  onoff: '11010011',
  increase: '01',
  decrease: '10',
};

/**
 * The fan device and the light device are two Homey devices backed by the
 * same physical hood, which only accepts a single BLE connection. This app
 * therefore keeps one shared NovyHood instance per peripheral, handed out
 * by reference count.
 */
class NovyApp extends Homey.App {

  async onInit() {
    this._hoods = new Map(); // peripheral uuid -> { hood, refs }

    this.homey.flow.getActionCard('press_power')
      .registerRunListener(async ({ device }) => { await device.hood.pressPower(); });
    this.homey.flow.getActionCard('start_boost')
      .registerRunListener(async ({ device }) => { await device.hood.boost(); });
    this.homey.flow.getActionCard('start_run_out')
      .registerRunListener(async ({ device }) => { await device.hood.runOut(); });
    this.homey.flow.getConditionCard('grease_dirty')
      .registerRunListener(async ({ device }) => Boolean(device.hood.state.greaseDirty));

    this.homey.flow.getActionCard('intouch_send')
      .registerRunListener(async ({ button, code }) => {
        const address = code === 'homey' ? HOMEY_ADDRESS : HOB_ADDRESS;
        await this._sendInTouch(address + INTOUCH_TX_UNITS[button]);
      });

    await this._startInTouchReceiver();

    this.log('Novy BLE app started');
  }

  /** Gap-filler bridge: the hood misses a large share of the hob's RF
   *  frames. After a hob button press, wait briefly, re-read the hood state
   *  over BLE, and only when the hood clearly did NOT act on the press,
   *  perform the equivalent command. This keeps native behaviour when the
   *  RF does arrive and rules out double execution by construction. */
  _bridgeInTouch(card, address) {
    if (address !== HOB_ADDRESS) return;
    // The hood acts on RF it hears virtually instantly, so 1s is enough to
    // tell "heard it" from "missed it" while keeping the fill-in snappy.
    const BRIDGE_CHECK_MS = 1000;
    const SPEED_STEP = 25;

    for (const { hood } of this._hoods.values()) {
      const snap = {
        light: Boolean(hood.state.lightState),
        fan: Boolean(hood.state.fanState),
        speed: hood.state.fanSpeed || 0,
      };
      setTimeout(async () => {
        try {
          await hood.refreshStatus();
          const s = hood.state;
          let action = 'hood handled it natively';
          switch (card) {
            case 'intouch_light':
              if (Boolean(s.lightState) === snap.light) {
                action = 'filling gap: toggle light';
                await hood.setLight(!snap.light);
              }
              break;
            case 'intouch_onoff':
              if (hood.skipRunOut && (snap.fan || snap.light)) {
                // Off-intent with "direct off" enabled: direct off is
                // idempotent, so skip the heard-it check entirely.
                action = 'direct off (skip run-out)';
                await hood.turnAllOff();
              } else if (Boolean(s.fanState) === snap.fan && Boolean(s.lightState) === snap.light) {
                action = 'filling gap: power toggle';
                await hood.pressPower();
              }
              break;
            case 'intouch_increase':
              if ((s.fanSpeed || 0) === snap.speed) {
                action = 'filling gap: speed up';
                await hood.setFanSpeed(Math.min(100, snap.speed + SPEED_STEP));
              }
              break;
            case 'intouch_decrease':
              if ((s.fanSpeed || 0) === snap.speed) {
                const target = snap.speed - SPEED_STEP;
                action = 'filling gap: speed down';
                if (target <= 0) await hood.setFanState(false);
                else await hood.setFanSpeed(target);
              }
              break;
            default:
              return;
          }
          this.log(`InTouch bridge (${card}): ${action}`);
        } catch (err) {
          this.error(`InTouch bridge failed: ${err}`);
        }
      }, BRIDGE_CHECK_MS);
    }
  }

  /** Transmit an InTouch frame, acting as a (replacement) remote control.
   *  During the hood's 3-minute learning mode (after a power-cycle) the hood
   *  adopts the address of the first InTouch frame it hears. */
  async _sendInTouch(bits) {
    if (!this._intouchSignal) throw new Error('433 MHz signal unavailable');
    const payload = bits.split('').map(Number);
    // Ignore our own transmission if the receiver picks it up.
    this._txQuietUntil = Date.now() + 2000;
    // A real remote sends a burst of ~20 repeats; send a few bursts for
    // reliability at range.
    for (let i = 0; i < 3; i += 1) {
      await this._intouchSignal.tx(payload);
    }
    this.log(`InTouch TX: ${bits}`);
  }

  /** Listen for Novy InTouch 433 MHz frames (hob buttons / remote control) and
   *  turn them into flow triggers. Frame layout, decoded by the community
   *  Intouch apps: 10 address bits + a 2-bit or 8-bit button code. */
  async _startInTouchReceiver() {
    // A button press transmits the frame ~20 times; collapse the burst.
    const DEBOUNCE_MS = 750;

    // RX often loses the first bit(s) of a frame to start-of-frame detection,
    // so classify on the button-code SUFFIX and treat the (variable-length)
    // remainder as the address. Long 8-bit codes first — the light code also
    // happens to end in '01'.
    const classify = code => {
      if (code.length >= 14) {
        if (code.endsWith('11010011')) return { card: 'intouch_onoff', unitLength: 8 };
        if (code.endsWith('11010001')) return { card: 'intouch_light', unitLength: 8 };
        // Salvage frames with leading garbage but an intact tail: the last two
        // address bits + full button code form a distinctive 10-bit signature.
        if (code.includes('0111010011')) return { card: 'intouch_onoff', unitLength: 8 };
        if (code.includes('0111010001')) return { card: 'intouch_light', unitLength: 8 };
        return null;
      }
      // Short frames: the remainder must be a clean alternating address, so a
      // heavily truncated 8-bit code can't masquerade as a 2-bit one.
      if (!/^(01)+$/.test(code.slice(0, -2))) return null;
      if (code.endsWith('01')) return { card: 'intouch_increase', unitLength: 2 };
      if (code.endsWith('10')) return { card: 'intouch_decrease', unitLength: 2 };
      return null;
    };

    try {
      this._intouchSignal = this.homey.rf.getSignal433('intouch');
      await this._intouchSignal.enableRX();
    } catch (err) {
      this.error(`InTouch 433 MHz receiver unavailable: ${err}`);
      return;
    }

    // One press = a burst of ~20 repeats, arriving as a mix of complete and
    // mangled frames — debounce per button, not per exact code. Unrecognised
    // frames are held back briefly: they are usually mangled repeats of a
    // press that decodes fine a moment before or after.
    const UNKNOWN_HOLD_MS = 600;
    const lastFired = {};
    let lastClassifiedAt = 0;
    let unknownTimer = null;
    this._intouchSignal.on('payload', payload => {
      try {
        if (this._txQuietUntil && Date.now() < this._txQuietUntil) return;
        const code = Array.from(payload).join('');
        const result = classify(code);
        // Corrupted repeats show up as mostly-zero frames; real InTouch
        // addresses are alternating (0101...). Log-only, no trigger spam.
        if (!result && !code.startsWith('0101')) {
          this.log(`InTouch RX noise: code=${code}`);
          return;
        }
        const now = Date.now();

        if (result) {
          lastClassifiedAt = now;
          if (unknownTimer) {
            clearTimeout(unknownTimer);
            unknownTimer = null;
          }
          if (lastFired[result.card] && now - lastFired[result.card] < DEBOUNCE_MS) return;
          lastFired[result.card] = now;
          const address = code.slice(0, code.length - result.unitLength);
          this.log(`InTouch RX: code=${code} (address=${address}) -> ${result.card}`);
          this.homey.flow.getTriggerCard(result.card).trigger({ address }).catch(this.error);
          this._bridgeInTouch(result.card, address);
          return;
        }

        if (unknownTimer) clearTimeout(unknownTimer);
        unknownTimer = setTimeout(() => {
          unknownTimer = null;
          const fireAt = Date.now();
          if (fireAt - lastClassifiedAt < 2 * DEBOUNCE_MS) return;
          if (lastFired.intouch_unknown && fireAt - lastFired.intouch_unknown < DEBOUNCE_MS) return;
          lastFired.intouch_unknown = fireAt;
          this.log(`InTouch RX: unknown code=${code}`);
          this.homey.flow.getTriggerCard('intouch_unknown').trigger({ code }).catch(this.error);
        }, UNKNOWN_HOLD_MS);
      } catch (err) {
        this.error(`InTouch RX handling failed: ${err}`);
      }
    });
    this.log('InTouch 433 MHz receiver enabled');
  }

  getHood({ uuid, address, localName }) {
    let entry = this._hoods.get(uuid);
    if (!entry) {
      const hood = new NovyHood({
        homey: this.homey,
        uuid,
        address,
        localName,
        log: (...args) => this.log(`[${address || uuid}]`, ...args),
        error: (...args) => this.error(`[${address || uuid}]`, ...args),
      });
      hood.start();
      entry = { hood, refs: 0 };
      this._hoods.set(uuid, entry);
    }
    entry.refs += 1;
    return entry.hood;
  }

  /** Hoods the app is already connected to. A connected hood stops
   *  advertising, so pairing must be able to offer these as well. */
  knownHoods() {
    return [...this._hoods.entries()].map(([uuid, entry]) => ({
      uuid,
      address: entry.hood.address,
      localName: entry.hood.localName,
    }));
  }

  async releaseHood(uuid) {
    const entry = this._hoods.get(uuid);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      this._hoods.delete(uuid);
      await entry.hood.destroy();
    }
  }
}

module.exports = NovyApp;

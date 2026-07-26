'use strict';

const Homey = require('homey');
const { NovyHood } = require('./lib/NovyHood');

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

    await this._startInTouchReceiver();

    this.log('Novy BLE app started');
  }

  /** Listen for Novy InTouch 433 MHz frames (hob buttons / remote control) and
   *  turn them into flow triggers. Frame layout, decoded by the community
   *  Intouch apps: 10 address bits + a 2-bit or 8-bit button code. */
  async _startInTouchReceiver() {
    // A button press transmits the frame ~20 times; collapse the burst.
    const DEBOUNCE_MS = 750;
    const UNIT_TO_CARD = {
      '11010001': 'intouch_light',
      '11010011': 'intouch_onoff',
      '01': 'intouch_increase',
      '10': 'intouch_decrease',
    };

    try {
      this._intouchSignal = this.homey.rf.getSignal433('intouch');
      await this._intouchSignal.enableRX();
    } catch (err) {
      this.error(`InTouch 433 MHz receiver unavailable: ${err}`);
      return;
    }

    let lastCode = null;
    let lastAt = 0;
    this._intouchSignal.on('payload', payload => {
      try {
        const code = Array.from(payload).join('');
        const now = Date.now();
        if (code === lastCode && now - lastAt < DEBOUNCE_MS) {
          lastAt = now;
          return;
        }
        lastCode = code;
        lastAt = now;

        const address = code.slice(0, 10);
        const unit = code.slice(10);
        const card = UNIT_TO_CARD[unit];
        this.log(`InTouch RX: code=${code} (address=${address}, unit=${unit}) -> ${card || 'unknown'}`);
        if (card) {
          this.homey.flow.getTriggerCard(card).trigger({ address }).catch(this.error);
        } else {
          this.homey.flow.getTriggerCard('intouch_unknown').trigger({ code }).catch(this.error);
        }
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

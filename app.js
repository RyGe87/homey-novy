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
    this.log('Novy BLE app started');
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

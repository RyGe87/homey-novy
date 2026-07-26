'use strict';

const Homey = require('homey');
const { UART_SERVICE } = require('./NovyHood');

/** Shared pairing logic: find hoods advertising the Nordic UART Service or a
 *  Novy-like name. Falls back to every named BLE device so hoods that
 *  advertise an unexpected name (e.g. some Novy Cloud units) can still be
 *  picked manually. */
class NovyDriver extends Homey.Driver {

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();

    const isNovy = adv => {
      const name = (adv.localName || '').toLowerCase();
      const uuids = (adv.serviceUuids || []).map(u => String(u).toLowerCase());
      // The Novy Cloud advertises the truncated short name "Clou".
      return name.startsWith('pureline')
        || name.startsWith('clou')
        || name.includes('novy')
        || uuids.includes(UART_SERVICE);
    };

    const matches = advertisements.filter(isNovy);
    const candidates = matches.length
      ? matches
      : advertisements.filter(adv => adv.localName);

    const results = candidates.map(adv => ({
      name: adv.localName || `Novy hood (${adv.address})`,
      data: { id: adv.uuid },
      store: {
        address: adv.address,
        localName: adv.localName || '',
      },
    }));

    // A hood the app is already connected to no longer advertises — offer it
    // from the app's own connection registry so the second device (fan or
    // light) can still be paired.
    const known = typeof this.homey.app.knownHoods === 'function'
      ? this.homey.app.knownHoods()
      : [];
    for (const hood of known) {
      if (!results.some(r => r.data.id === hood.uuid)) {
        results.push({
          name: hood.localName || `Novy hood (${hood.address})`,
          data: { id: hood.uuid },
          store: {
            address: hood.address,
            localName: hood.localName || '',
          },
        });
      }
    }

    return results;
  }
}

module.exports = NovyDriver;

'use strict';

const Homey = require('homey');

class HoodLightDevice extends Homey.Device {

  async onInit() {
    // Devices paired before v0.3.0 lack the operating-hours sensor.
    if (!this.hasCapability('measure_led_hours')) {
      await this.addCapability('measure_led_hours').catch(this.error);
    }

    const { id } = this.getData();
    const { address, localName } = this.getStore();
    this.hood = this.homey.app.getHood({ uuid: id, address, localName });
    this.hood.lightWarmFull = Boolean(this.getSetting('light_warm_full'));
    this._lastWarmFullEnforce = 0;
    this._lastLightState = undefined;

    this._onState = state => this._syncState(state);
    this._onAvailable = available => {
      if (available) this.setAvailable().catch(this.error);
      else this.setUnavailable(this.homey.__('unavailable')).catch(this.error);
    };
    this.hood.on('state', this._onState);
    this.hood.on('available', this._onAvailable);
    if (!this.hood.connected) {
      this.setUnavailable(this.homey.__('unavailable')).catch(this.error);
    }

    // One listener for all light capabilities so a single "warm white at 40%"
    // action becomes one command sequence instead of three racing ones.
    this.registerMultipleCapabilityListener(
      ['onoff', 'dim', 'light_temperature'],
      async values => {
        const on = values.onoff !== undefined
          ? values.onoff
          : (values.dim !== undefined ? values.dim > 0 : true);

        if (!on) {
          await this.hood.setLight(false);
          return;
        }

        const opts = {};
        if (values.dim !== undefined) opts.brightness = values.dim * 255;
        if (values.light_temperature !== undefined) {
          // Homey: 0 = coolest, 1 = warmest. Hood raw: 0 = 6500K, 255 = 2700K.
          opts.colortemp = values.light_temperature * 255;
        }
        // Plain "on" with the house rule active: warmest colour, full power.
        if (this.hood.lightWarmFull && opts.brightness === undefined && opts.colortemp === undefined) {
          await this.hood.setLightWarmFull();
          return;
        }
        await this.hood.setLight(true, opts);
      },
      500,
    );
  }

  _syncState(state) {
    const set = (cap, value) => {
      if (value !== undefined && this.hasCapability(cap)) {
        this.setCapabilityValue(cap, value).catch(this.error);
      }
    };
    // "Licht altijd warm op vol vermogen": correct a native light-on that
    // restored something else, unless an explicit choice was just made.
    if (this.hood.lightWarmFull && this._lastLightState === false && state.lightState
      && ((state.brightness || 0) < 250 || (state.colortemp || 0) < 250)
      && Date.now() - this.hood.lastExplicitLightAt > 8000
      && Date.now() - this._lastWarmFullEnforce > 10000) {
      this._lastWarmFullEnforce = Date.now();
      this.log('Light restored differently — enforcing warm/full (setting)');
      this.hood.setLightWarmFull().catch(this.error);
    }
    if (state.lightState !== undefined) this._lastLightState = state.lightState;

    set('onoff', state.lightState);
    if (state.brightness !== undefined && state.brightness > 0) {
      set('dim', state.brightness / 255);
    }
    if (state.colortemp !== undefined) {
      set('light_temperature', state.colortemp / 255);
    }
    if (state.ledOperatingMinutes !== undefined) {
      set('measure_led_hours', Math.round(state.ledOperatingMinutes / 60));
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('light_warm_full')) {
      this.hood.lightWarmFull = Boolean(newSettings.light_warm_full);
    }
  }

  async onDeleted() {
    if (this.hood) {
      this.hood.removeListener('state', this._onState);
      this.hood.removeListener('available', this._onAvailable);
      await this.homey.app.releaseHood(this.getData().id);
    }
  }
}

module.exports = HoodLightDevice;

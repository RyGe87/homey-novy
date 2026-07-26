'use strict';

const Homey = require('homey');

class HoodFanDevice extends Homey.Device {

  async onInit() {
    // Devices paired before v0.3.0 lack the operating-hours sensor.
    if (!this.hasCapability('measure_fan_hours')) {
      await this.addCapability('measure_fan_hours').catch(this.error);
    }

    const { id } = this.getData();
    const { address, localName } = this.getStore();
    this.hood = this.homey.app.getHood({ uuid: id, address, localName });
    this.hood.skipRunOut = Boolean(this.getSetting('skip_run_out'));
    this.hood.startMinimum = Boolean(this.getSetting('start_minimum'));
    this._lastRunOutCancel = 0;
    this._lastMinimumEnforce = 0;
    this._lastFanState = undefined;

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

    this.registerCapabilityListener('onoff', async value => {
      await this.hood.setFanState(value);
    });

    this.registerCapabilityListener('dim', async value => {
      if (value <= 0) await this.hood.setFanState(false);
      else await this.hood.setFanSpeed(value * 100);
    });

    this.registerCapabilityListener('recirculation', async value => {
      await this.hood.setRecirculate(value);
    });

    this.registerCapabilityListener('button.reset_grease', async () => {
      await this.hood.resetGrease();
    });
  }

  _syncState(state) {
    const set = (cap, value) => {
      if (value !== undefined && this.hasCapability(cap)) {
        this.setCapabilityValue(cap, value).catch(this.error);
      }
    };
    if (state.greaseDirty === true && this._lastGreaseDirty === false) {
      this.homey.flow.getDeviceTriggerCard('grease_dirty_true')
        .trigger(this)
        .catch(this.error);
    }
    if (state.greaseDirty !== undefined) this._lastGreaseDirty = state.greaseDirty;

    // "Direct uitschakelen": cut the hood's native 30-minute run-out short,
    // whichever path started it (hob button, power command, boost expiry).
    if (this.hood.skipRunOut && state.stopping && state.fanState
      && Date.now() - this._lastRunOutCancel > 15000) {
      this._lastRunOutCancel = Date.now();
      this.log('Run-out detected — turning hood off immediately (setting)');
      this.hood.turnAllOff().catch(this.error);
    }
    // "Start altijd op laagste stand": the hood natively restores its
    // last-used speed on power-on — knock it down unless the turn-on came
    // from an explicit speed command.
    if (this.hood.startMinimum && this._lastFanState === false && state.fanState
      && (state.fanSpeed || 0) > 25 && !state.boost
      && Date.now() - this.hood.lastExplicitFanAt > 8000
      && Date.now() - this._lastMinimumEnforce > 10000) {
      this._lastMinimumEnforce = Date.now();
      this.log('Fan restored at higher speed — enforcing minimum (setting)');
      this.hood.setFanSpeed(25).catch(this.error);
    }
    if (state.fanState !== undefined) this._lastFanState = state.fanState;

    set('onoff', state.fanState);
    if (state.fanSpeed !== undefined && state.fanSpeed > 0) {
      set('dim', state.fanSpeed / 100);
    }
    set('recirculation', state.recirculate);
    set('alarm_grease', state.greaseDirty);
    if (state.fanOperatingMinutes !== undefined) {
      set('measure_fan_hours', Math.round(state.fanOperatingMinutes / 60));
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('skip_run_out')) {
      this.hood.skipRunOut = Boolean(newSettings.skip_run_out);
    }
    if (changedKeys.includes('start_minimum')) {
      this.hood.startMinimum = Boolean(newSettings.start_minimum);
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

module.exports = HoodFanDevice;

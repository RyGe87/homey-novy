# Novy BLE for Homey

Control your **Novy Cloud** or **Novy Pureline Pro** extractor hood from a
[Homey Pro](https://homey.app), directly over Bluetooth Low Energy — fully
local, no cloud, no extra hardware.

Tested on a Novy Cloud (firmware 2.0.3) with a Homey Pro (Early 2023).

## Features

The hood appears as two Homey devices sharing a single BLE connection:

**Fan**
- On/off and fan speed (0–100 %)
- Recirculation mode toggle
- Grease filter alarm, with a maintenance action to reset the counter after
  cleaning the filters
- Fan operating-hours sensor (with insights)
- Flow cards: power button, boost, run-out mode, grease filter trigger

**Light**
- On/off and brightness
- Colour temperature from cool white (6500 K) to warm amber (2700 K)
- LED operating-hours sensor (with insights)

State is polled every 5 seconds, so changes made with the physical remote show
up in Homey as well.

**InTouch receiver + gap-filler bridge**: the app listens for Novy InTouch
433 MHz frames (the hood-control buttons on a Novy hob, or the remote) and
fires flow triggers for the light, on/off, speed up and speed down buttons.
On top of that it automatically bridges missed presses: when the hood did
not act on a hob button (Novy's RF link is notoriously lossy), the app
detects this over BLE within ~2 seconds and performs the command itself —
without ever double-executing presses the hood did hear. A flow action can
also transmit InTouch frames, so Homey can stand in for a lost remote.

## Installation (development)

```bash
npm install --global homey
homey login
homey app install
```

Then add the devices in the Homey app: *Devices → Add → Novy BLE*. The hood
advertises a shortened name (a Novy Cloud shows up as **"Clou"**).

## Good to know

- The hood accepts **one** BLE client at a time: while Homey is connected, the
  official Novy smartphone app cannot connect, and vice versa.
- The protocol is documented in [PROTOCOL.md](PROTOCOL.md): ASCII command
  frames over the Nordic UART Service, answered by ACKs or binary status
  packets.

## Credits

The BLE protocol was reverse-engineered by **Bert Wynants** for his Home
Assistant integration [hass-purelinepro](https://github.com/bwynants/hass-purelinepro)
and ESPHome component [purelinepro](https://github.com/bwynants/purelinepro)
(both MIT). This app is an independent port of that protocol to the Homey
platform. Novy is a trademark of Novy NV; this project is not affiliated with
or endorsed by Novy.

## License

[MIT](LICENSE)

# Novy BLE-protocol (Pureline Pro / Cloud)

Gedestilleerd uit de MIT-gelicentieerde referentie-implementaties van Bert Wynants:
[bwynants/hass-purelinepro](https://github.com/bwynants/hass-purelinepro) (Python/Home Assistant)
en [bwynants/purelinepro](https://github.com/bwynants/purelinepro) (C++/ESPHome).
De HA-integratie is expliciet ook op Novy Cloud-modellen getest.

## Transport

De dampkap spreekt de **Nordic UART Service (NUS)** — geen pairing of bonding nodig,
gewoon verbinden en op notificaties abonneren.

| Rol | UUID | Homey-notatie (zonder streepjes) |
|---|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | `6e400001b5a3f393e0a9e50e24dcca9e` |
| RX — schrijven (client → kap) | `6e400002-…` | `6e400002b5a3f393e0a9e50e24dcca9e` |
| TX — notify (kap → client) | `6e400003-…` | `6e400003b5a3f393e0a9e50e24dcca9e` |

Discovery: de Pureline Pro adverteert een naam die met `Pureline` begint; andere
modellen (waaronder mogelijk de Cloud) kunnen een andere naam voeren. Filter dus
ruim en laat de gebruiker kiezen.

## Commandoformaat (client → kap)

ASCII-frames op de RX-characteristic, zonder response-flag:

```
[cmd]            bv. [10;0]     — zonder extra argument
[cmd;a1;a2]      bv. [28;1;60]  — met argumenten
```

De kap beantwoordt **elk** commando met precies één notificatie: een ASCII-ACK
(`[1;1;1]`-achtig) voor stuurcommando's, of een binair statuspakket voor
statuscommando's. **Verstuur nooit een volgend commando vóór de ACK binnen is**
(serialiseer alle writes) en houd ± 200 ms tussenruimte — te snel schrijven laat
de verbinding vallen. Time-out in de referentie: 8 s.

| Cmd | Betekenis | Frame |
|---|---|---|
| 10 | Power-toets (toggle kap) | `[10;0]` |
| 15 | Licht aan, ambi-preset | `[15;0]` |
| 16 | Licht aan, wit-preset | `[16;0]` |
| 21 | Helderheid 0-255 | `[21;1;<b>]` |
| 22 | Kleurtemperatuur raw 0-255 (0 = 6500 K koel, 255 = 2700 K warm) | `[22;1;<ct>]` |
| 23 | Vetfilter-teller resetten (geen ACK verwacht) | `[23;0]` |
| 25 | Recirculatie aan/uit | `[25;1;<0/1>]` |
| 28 | Ventilatorsnelheid 0-100 % | `[28;1;<pct>]` |
| 29 | Ventilator aan/uit | `[29;1;<0/1>]` |
| 36 | Licht uit | `[36;0]` |
| 41 | Ventilator naar standaardstand | `[41;0]` |
| 42 | Licht naar standaard (arg = huidige lightmode) | `[42;1;<mode>]` |
| 400 | Hoofdstatus opvragen → Packet400 | `[400;0]` |
| 402 | Extra status (recirculatie/vetfilter/firmware) → Packet402 | `[402;0]` |
| 403 | Extra status (defaults/branduren motor) → Packet403 | `[403;0]` |
| 404 | Extra status (branduren led) → Packet404 | `[404;0]` |

Na elk stuurcommando stuurt de referentie meteen `[400;0]` (of `[402;0]` bij
recirculatie) om de state te verversen. Pollen: elke 3 s een 400, elke ~30 s ook
402/403/404. De pakketten 402 en 404 zijn allebei 20 bytes — je moet dus
bijhouden welk statuscommando in-flight is om de respons te kunnen duiden.

## Statuspakketten (kap → client, little-endian structs)

### Packet400 — hoofdstatus, 16 bytes, layout `BBBBBBBBHHHH`

| Veld | Betekenis |
|---|---|
| flags1 | bit0 = motor bekrachtigd, bit1 = boost/uitlooptimer actief, bit2 = stopsequentie |
| fanspeed | 0-100 % |
| flags2 | bit0 = vetfilter vuil |
| (2 bytes onbekend) | |
| lightmode | 0 = uit, 1 = wit, 2 = ambi |
| brightness | 0-255 |
| colortemp | 0-255 raw |
| countdown | uint16, **byte-geswapt** (big-endian waarde in little-endian veld), seconden; alleen geldig als flags1-bit1 gezet is |
| (3×uint16 onbekend) | |

Afleidingen uit de referentie: `boost` = timer actief én fanspeed > 75;
`stopping` = timer actief maar geen boost; licht aan = brightness > 0.

### Packet402 — 20 bytes, layout `HBBIBBBBII`

flags-bit0 = recirculatie actief; greasetime = uint32 **byte-geswapt**, seconden
(vetfilterteller); daarna firmware major/minor/patch als 3 bytes.

### Packet403 — 20 bytes, layout `BBIIIBBBBBB`

byte0 = uitschakel-ventilatorsnelheid (default 25); fan_timer = derde uint32,
**byte-geswapt**, totale motorseconden; daarna default snelheid/licht-presets.

### Packet404 — 20 bytes, layout `IIIBIBH`

ledtimer = vierde veld (uint32 op offset 13), **byte-geswapt**, totale led-seconden.

## Valkuilen uit de praktijk (referentiecode)

- Wacht na het verbinden ± 0,5 s vóór de eerste GATT-operatie en abonneer éérst
  op TX-notificaties; commando's vóór de subscriptie verdwijnen spilloos.
- Slechts één BLE-client tegelijk: de officiële Novy-app en Homey sluiten elkaar uit.
- Te veel writes kort na elkaar (bv. licht-transities) crashen de verbinding —
  rate-limiten dus.
- Reconnect met backoff (5 s × 1,5ⁿ) na onverwachte disconnects.

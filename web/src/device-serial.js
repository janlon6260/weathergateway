import { validateUsbManifest } from '../../shared/usb-firmware.js';
import { deadline, stopTransport, readFlashSegment, confirmUsbBoot } from './usb-protocol.js';

export function terminalText(text) {
  return String(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export function appendTerminal(previous, text) {
  return (previous + terminalText(text)).slice(-200000).split('\n').slice(-1000).join('\n');
}
export async function prepareUsbBundle(input, stationId, environment, cryptoApi = globalThis.crypto) {
  if (!input || Object.keys(input).sort().join(',') !== 'images,manifest,signature')
    throw new Error('Velg en komplett USB-pakke (.usb-flash.json).');
  const manifest = validateUsbManifest(input.manifest);
  if (manifest.stationId !== stationId || manifest.environment !== environment)
    throw new Error('USB-pakken gjelder en annen stasjon eller et annet miljø.');
  if (
    typeof input.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(input.signature) ||
    !Array.isArray(input.images) ||
    input.images.length !== 4
  )
    throw new Error('USB-pakken er ufullstendig.');
  const segments = [];
  for (let i = 0; i < manifest.segments.length; i++) {
    const part = manifest.segments[i],
      encoded = input.images[i];
    if (typeof encoded !== 'string' || encoded.length > 2200000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error('Ugyldig binærfil i USB-pakken.');
    const data = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const digest = await cryptoApi.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    if (data.length !== part.size || hex !== part.sha256)
      throw new Error('Kontrollsummen i USB-pakken stemmer ikke.');
    if ((part.name === 'app' || part.name === 'bootloader') && data[0] !== 0xe9)
      throw new Error('Ugyldig ESP32-bilde.');
    segments.push({ data, address: part.address });
  }
  return { manifest, signature: input.signature, segments };
}

// One owner per port: USB reading and flashing can never run concurrently.
export class DeviceSerial {
  constructor({
    serial = globalThis.navigator?.serial,
    output = () => {},
    state = () => {},
    error = () => {},
    loadFlasher = () => import('esptool-js'),
    confirmBoot = confirmUsbBoot,
  } = {}) {
    Object.assign(this, { serial, output, state, error, loadFlasher, confirmBoot });
    this.mode = 'disconnected';
  }
  setMode(mode) {
    this.mode = mode;
    this.state(mode);
  }
  async select() {
    if (!this.serial) throw new Error('USB krever Chrome eller Edge og HTTPS (eller localhost).');
    if (this.mode !== 'disconnected') throw new Error('Koble fra USB-loggen før flashing.');
    this.setMode('connecting');
    try {
      this.port = await this.serial.requestPort();
      return this.port;
    } catch (error) {
      this.setMode('disconnected');
      throw error;
    }
  }
  async readLogs(baudRate = 115200) {
    const port = await this.select();
    try {
      await port.open({ baudRate, bufferSize: 4096, flowControl: 'none' });
      // Release CP2102/CH340 auto-reset lines while observing an already running ESP32.
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      this.reader = port.readable.getReader();
      this.setMode('reading');
      const decoder = new TextDecoder();
      this.reading = (async () => {
        try {
          while (this.mode === 'reading') {
            const { value, done } = await this.reader.read();
            if (done) break;
            this.output(decoder.decode(value, { stream: true }));
          }
          this.output(decoder.decode());
        } catch (error) {
          if (this.mode === 'reading') this.error(new Error(`USB-loggen ble avbrutt: ${error.message}`));
        } finally {
          this.reader.releaseLock();
          this.reader = null;
          try {
            await port.close();
          } catch {
            /* Cable may already be detached. */
          }
          this.port = null;
          this.setMode('disconnected');
        }
      })();
    } catch (error) {
      try {
        await port.close();
      } catch {
        /* Port may not have opened. */
      }
      this.port = null;
      this.setMode('disconnected');
      throw error;
    }
  }
  async disconnect() {
    if (this.mode === 'flashing') throw new Error('Vent til flashingen er fullført.');
    if (this.reader) {
      this.setMode('disconnecting');
      await this.reader.cancel();
      await this.reading;
    }
  }
  async flash(
    bundle,
    { authorize, progress = () => {}, phase = () => {}, baudrate = 460800, idleMs = 6000 } = {},
  ) {
    const port = await this.select();
    let transport;
    try {
      this.setMode('flashing');
      await deadline(authorize, 15000, 'Gatewayen svarte ikke på flashgodkjenningen');
      const { ESPLoader, Transport } = await deadline(
        () => this.loadFlasher(),
        15000,
        'Flash-verktøyet kunne ikke lastes',
      );
      const connect = async () => {
        transport = new Transport(port, false);
        const loader = new ESPLoader({
          transport,
          baudrate,
          debugLogging: false,
          terminal: {
            clean: () => {},
            write: (s) => this.output(s),
            writeLine: (s) => this.output(`${s}\n`),
          },
        });
        await deadline(() => loader.detectChip(), 20000, 'ESP32 svarte ikke under tilkobling');
        if (loader.chip?.CHIP_NAME !== 'ESP32')
          throw new Error('Pakken krever ESP-WROOM-32 (klassisk ESP32).');
        // ESP32 lacks GET_SECURITY_INFO. Read-only eFuse checks follow Espressif esptool/targets/esp32.py.
        const crypt =
          ((await deadline(() => loader.readReg(0x3ff5a000), 5000, 'eFuse-kontrollen svarte ikke')) >>> 20) &
          0x7f;
        const secureBoot =
          (await deadline(() => loader.readReg(0x3ff5a018), 5000, 'Secure Boot-kontrollen svarte ikke')) &
          0x30;
        if (crypt || secureBoot)
          throw new Error(
            'Enheten er maskinvaresikret eller har sikkerhets-eFuses satt. Bruk signert OTA/ESP-IDF for denne enheten.',
          );
        await deadline(() => loader.runStub(), 20000, 'Flash-stubben svarte ikke');
        if (!loader.IS_STUB) throw new Error('Flash-verktøyet kunne ikke starte RAM-stubben.');
        if (loader.romBaudrate !== baudrate)
          await deadline(() => loader.changeBaud(), 10000, 'Bytte av USB-hastighet svarte ikke');
        if (
          (await deadline(() => loader.detectFlashSize(), 10000, 'Flash-størrelsen kunne ikke leses')) !==
          '4MB'
        )
          throw new Error('USB-pakken krever en ESP32 med 4 MB flash.');
        return loader;
      };
      phase('Kobler til ESP32');
      let loader = await connect();
      this.output('Sletter flash og skriver den signerte stasjonspakken …\n');
      phase('Sletter og skriver firmware');
      await deadline(
        () =>
          loader.writeFlash({
            fileArray: bundle.segments,
            flashSize: 'keep',
            flashMode: 'keep',
            flashFreq: 'keep',
            eraseAll: true,
            compress: true,
            reportProgress: (index, written, total) =>
              progress(Math.floor(((index + written / total) / 4) * 75)),
          }),
        180000,
        'Skrivingen svarte ikke innen tre minutter. Koble til på nytt og flash pakken igjen.',
      );
      let verified = false;
      for (let attempt = 0; attempt < 2 && !verified; attempt++) {
        try {
          phase(
            attempt ? 'Kontrollerer på nytt etter gjenoppkobling' : 'Leser tilbake og verifiserer SHA-256',
          );
          const total = bundle.segments.reduce((sum, s) => sum + s.data.length, 0);
          let done = 0;
          for (let i = 0; i < bundle.segments.length; i++) {
            const segment = bundle.segments[i];
            const bytes = await deadline(
              () =>
                readFlashSegment(
                  loader,
                  transport,
                  segment.address,
                  segment.data.length,
                  (count) => progress(75 + Math.floor(((done + count) / total) * 19)),
                  idleMs,
                ),
              Math.max(20000, ((segment.data.length * 8) / baudrate) * 3000 + 10000),
              'Tilbakeavlesingen tok for lang tid',
            );
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const hex = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
            if (hex !== bundle.manifest.segments[i].sha256)
              throw new Error('Verifisering etter skriving feilet. Enheten forblir i bootloader.');
            done += segment.data.length;
          }
          verified = true;
        } catch (error) {
          if (attempt || /Verifisering|Ugyldig flashpakke/.test(error.message)) throw error;
          phase('USB svarte ikke. Kobler til på nytt uten å skrive firmware igjen.');
          await stopTransport(transport, port);
          loader = await connect();
        }
      }
      progress(95);
      phase('Starter ESP32 og venter på oppstartskvittering');
      await deadline(() => loader.after('hard_reset'), 5000, 'Kunne ikke starte ESP32 etter verifisering');
      await stopTransport(transport, port);
      transport = null;
      this.output('Alle fire flashsegmenter er lest tilbake og SHA-256-verifisert. ESP32 starter.\n');
      const bootConfirmed = await deadline(
        () => this.confirmBoot(port, bundle.manifest, this.output),
        26000,
        'Oppstartskontrollen svarte ikke',
      );
      if (bootConfirmed) {
        progress(100);
        phase('Ferdig – firmware og oppstart er bekreftet');
      } else {
        phase('Firmware er verifisert. Oppstart ble ikke bekreftet – åpne USB-loggen.');
        this.output('Oppstartskvittering mangler. Ingen automatisk ny flashing eller sletting utføres.\n');
      }
      return { verified: true, bootConfirmed };
    } finally {
      if (transport) await stopTransport(transport, port);
      this.port = null;
      this.setMode('disconnected');
    }
  }
}

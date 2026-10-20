import { validateUsbManifest } from '../../shared/usb-firmware.js';

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
  } = {}) {
    Object.assign(this, { serial, output, state, error, loadFlasher });
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
  async flash(bundle, { authorize, progress = () => {}, baudrate = 460800 } = {}) {
    const port = await this.select();
    let transport;
    try {
      this.setMode('flashing');
      await authorize(); // Fresh AD session, role, signature and credential check immediately before device writes.
      const { ESPLoader, Transport } = await this.loadFlasher();
      transport = new Transport(port, false);
      const loader = new ESPLoader({
        transport,
        baudrate,
        debugLogging: false,
        terminal: { clean: () => {}, write: (s) => this.output(s), writeLine: (s) => this.output(`${s}\n`) },
      });
      await loader.detectChip();
      if (loader.chip?.CHIP_NAME !== 'ESP32') throw new Error('Pakken krever ESP-WROOM-32 (klassisk ESP32).');
      // ESP32 lacks GET_SECURITY_INFO. Read-only eFuse checks follow Espressif esptool/targets/esp32.py.
      const crypt = ((await loader.readReg(0x3ff5a000)) >>> 20) & 0x7f;
      const secureBoot = (await loader.readReg(0x3ff5a018)) & 0x30;
      if (crypt || secureBoot)
        throw new Error(
          'Enheten er maskinvaresikret eller har sikkerhets-eFuses satt. Bruk signert OTA/ESP-IDF for denne enheten.',
        );
      await loader.runStub();
      if (!loader.IS_STUB) throw new Error('Flash-verktøyet kunne ikke starte RAM-stubben.');
      if (loader.romBaudrate !== baudrate) await loader.changeBaud();
      if ((await loader.detectFlashSize()) !== '4MB')
        throw new Error('USB-pakken krever en ESP32 med 4 MB flash.');
      this.output('Sletter flash og skriver den signerte stasjonspakken …\n');
      await loader.writeFlash({
        fileArray: bundle.segments,
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: true,
        compress: true,
        reportProgress: (index, written, total) =>
          progress(Math.floor(((index + written / total) / 8) * 100)),
      });
      for (let i = 0; i < bundle.segments.length; i++) {
        const segment = bundle.segments[i];
        const bytes = await loader.readFlash(segment.address, segment.data.length);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hex = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
        if (hex !== bundle.manifest.segments[i].sha256)
          throw new Error('Verifisering etter skriving feilet. Enheten forblir i bootloader.');
        progress(Math.floor(((4 + i + 1) / 8) * 100));
      }
      await loader.after('hard_reset');
      this.output('Alle fire flashsegmenter er lest tilbake og SHA-256-verifisert. ESP32 starter.\n');
    } finally {
      if (transport) {
        try {
          await transport.disconnect();
        } catch {
          /* Device disconnected. */
        }
      }
      this.port = null;
      this.setMode('disconnected');
    }
  }
}

// esptool stub READ_FLASH ends with a separate 16-byte digest frame. Consume it
// before sending another command. The signed SHA-256 is the authoritative check.
export async function deadline(operation, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          error.code = 'USB_TIMEOUT';
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function stopTransport(transport, port) {
  try {
    await deadline(() => transport?.reader?.cancel(), 1500, 'USB-leseren svarer ikke');
  } catch {}
  try {
    await deadline(() => transport?.disconnect(), 2500, 'USB-porten svarer ikke');
  } catch {}
  try {
    if (port?.readable && !port.readable.locked)
      await deadline(() => port.close(), 1500, 'USB-porten svarer ikke');
  } catch {}
}
export async function readFlashSegment(loader, transport, address, size, progress = () => {}, idleMs = 6000) {
  const request = new Uint8Array(16),
    view = new DataView(request.buffer);
  [address, size, 4096, 64].forEach((value, index) => view.setUint32(index * 4, value, true));
  const result = await deadline(
    () => loader.checkCommand('read flash', loader.ESP_READ_FLASH, request),
    idleMs,
    'ESP32 svarte ikke på lesekommandoen',
  );
  if (result !== 0) throw new Error('ESP32 avviste tilbakeavlesing');
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const packet = await deadline(
      () => transport.read(idleMs),
      idleMs + 500,
      'Tilbakeavlesingen stoppet. Kobler til ESP32 på nytt.',
    );
    if (
      !(packet instanceof Uint8Array) ||
      !packet.length ||
      packet.length > 4096 ||
      offset + packet.length > size
    )
      throw new Error('Ugyldig flashpakke fra ESP32');
    bytes.set(packet, offset);
    offset += packet.length;
    const ack = new Uint8Array(4);
    new DataView(ack.buffer).setUint32(0, offset, true);
    await deadline(() => transport.write(ack), idleMs, 'ESP32 kvitterer ikke for tilbakeavlesingen');
    progress(offset, size);
  }
  const digest = await deadline(
    () => transport.read(idleMs),
    idleMs + 500,
    'Mangler avsluttende kvittering fra flash-stubben',
  );
  if (!(digest instanceof Uint8Array) || digest.length !== 16)
    throw new Error('Ugyldig sluttkvittering fra flash-stubben');
  return bytes;
}
export async function confirmUsbBoot(port, manifest, output, timeoutMs = 20000) {
  const challenge = crypto.randomUUID().replaceAll('-', '');
  let reader,
    writer,
    text = '',
    timer,
    requestTimer;
  try {
    await deadline(
      () => port.open({ baudRate: 115200, bufferSize: 8192, flowControl: 'none' }),
      4000,
      'Kunne ikke åpne USB for oppstartskontroll',
    );
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    const query = new TextEncoder().encode(`WG_BOOT_QUERY ${challenge}\n`);
    let writing = false;
    const ask = async () => {
      if (writing) return;
      writing = true;
      try {
        await writer.write(query);
      } catch {
      } finally {
        writing = false;
      }
    };
    void ask();
    requestTimer = setInterval(() => void ask(), 1500);
    const decoder = new TextDecoder();
    return await Promise.race([
      (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return false;
          const chunk = decoder.decode(value, { stream: true });
          output(chunk);
          text = (text + chunk).slice(-16000);
          let end;
          while ((end = text.indexOf('\n')) >= 0) {
            const line = text.slice(0, end);
            text = text.slice(end + 1);
            const start = line.indexOf('WG_BOOT_READY ');
            if (start < 0) continue;
            try {
              const receipt = JSON.parse(line.slice(start + 14));
              if (
                receipt.challenge === challenge &&
                receipt.stationId === manifest.stationId &&
                receipt.configurationHash === manifest.configurationHash &&
                receipt.firmwareVersion === manifest.version &&
                receipt.status === 'ready'
              )
                return true;
            } catch {}
          }
        }
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    clearInterval(requestTimer);
    try {
      await deadline(() => reader?.cancel(), 1000, 'USB svarer ikke');
    } catch {}
    try {
      reader?.releaseLock();
    } catch {}
    try {
      await deadline(() => writer?.abort(), 1000, 'USB svarer ikke');
      writer?.releaseLock();
    } catch {}
    try {
      await deadline(() => port.close(), 2000, 'USB svarer ikke');
    } catch {}
  }
}

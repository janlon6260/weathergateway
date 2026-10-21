import test from 'node:test';
import assert from 'node:assert/strict';
import { readFlashSegment, confirmUsbBoot, deadline } from '../web/src/usb-protocol.js';
test('READ_FLASH consumes the stub digest, acknowledges byte offsets and supports the next segment without stale packets', async () => {
  let packets = [],
    acks = [];
  const transport = {
    read: async () => packets.shift(),
    write: async (v) => acks.push(new DataView(v.buffer).getUint32(0, true)),
  };
  const bytes = Uint8Array.from({ length: 9000 }, (_, i) => i % 251),
    loader = {
      ESP_READ_FLASH: 0xd2,
      checkCommand: async (_name, command, request) => {
        assert.equal(packets.length, 0, 'Previous trailing digest must be consumed');
        assert.equal(command, 0xd2);
        assert.equal(new DataView(request.buffer).getUint32(12, true), 64);
        packets = [
          bytes.subarray(0, 4096),
          bytes.subarray(4096, 8192),
          bytes.subarray(8192),
          new Uint8Array(16),
        ];
        return 0;
      },
    };
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await readFlashSegment(loader, transport, 0x20000, bytes.length), bytes);
  assert.deepEqual(acks, [4096, 8192, 9000, 4096, 8192, 9000]);
  assert.equal(packets.length, 0);
});
test('silent USB transfers and missing digest have a bounded failure instead of indefinite progress', async () => {
  const loader = { ESP_READ_FLASH: 0xd2, checkCommand: async () => 0 };
  await assert.rejects(
    readFlashSegment(
      loader,
      { read: () => new Promise(() => {}), write: async () => {} },
      0,
      1,
      () => {},
      10,
    ),
    /stoppet/,
  );
  await assert.rejects(
    deadline(() => new Promise(() => {}), 10, 'timeout'),
    /timeout/,
  );
});
test('USB completion requires a matching challenge, station, configuration and firmware; closes the port on success and timeout', async () => {
  const manifest = { stationId: 'test-station', configurationHash: 'hash', version: '2.3.0' };
  for (const correct of [true, false]) {
    let stream,
      closed = false;
    const port = {
      readable: null,
      writable: null,
      open: async () => {
        port.readable = new ReadableStream({
          start(c) {
            stream = c;
          },
        });
        port.writable = new WritableStream({
          write(data) {
            const challenge = new TextDecoder().decode(data).trim().split(' ')[1];
            const response = new TextEncoder().encode(
              'I boot log\nWG_BOOT_READY ' +
                JSON.stringify({
                  ...manifest,
                  firmwareVersion: manifest.version,
                  status: 'ready',
                  challenge: correct ? challenge : 'wrong',
                }) +
                '\n',
            );
            stream.enqueue(response.subarray(0, 31));
            stream.enqueue(response.subarray(31));
          },
        });
      },
      setSignals: async () => {},
      close: async () => {
        closed = true;
      },
    };
    assert.equal(await confirmUsbBoot(port, manifest, () => {}, 50), correct);
    assert.equal(closed, true);
  }
});

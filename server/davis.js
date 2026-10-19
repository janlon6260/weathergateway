// Davis Vantage Serial Communication Reference 2.6.1, sections X and XII.
// Raw frames remain attached to observations for reproducible future decoding.
export function crcCcitt(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function decodeLoop(packet, rainMmPerClick) {
  if (
    !Buffer.isBuffer(packet) ||
    packet.length !== 99 ||
    packet.subarray(0, 3).toString('ascii') !== 'LOO' ||
    ![0, 1].includes(packet[4]) ||
    packet[95] !== 10 ||
    packet[96] !== 13 ||
    crcCcitt(packet) !== 0
  )
    throw new Error('Ugyldig Davis LOOP-pakke eller CRC');
  if (!Number.isFinite(rainMmPerClick) || rainMmPerClick <= 0 || rainMmPerClick > 10)
    throw new Error('Ugyldig regnkalibrering');
  const bounded = (v, min, max) => (Number.isFinite(v) && v >= min && v <= max ? v : null);
  const u16 = (offset) => packet.readUInt16LE(offset);
  const temperature = (offset) =>
    [0x7fff, 0x8000].includes(u16(offset))
      ? null
      : bounded(
          (packet.readInt16LE(offset) / 10 - 32) / 1.8,
          offset === 9 ? -40 : -90,
          offset === 9 ? 85 : 65,
        );
  const humidity = (offset) => bounded(packet[offset], 0, 100);
  const clicks = (offset, max = 5000) =>
    u16(offset) === 0xffff ? null : bounded(u16(offset) * rainMmPerClick, 0, max);
  const type = packet[4],
    direction = u16(16);
  const measurements = {
    temperatureC: temperature(12),
    indoorTemperatureC: temperature(9),
    humidityPct: humidity(33),
    indoorHumidityPct: humidity(11),
    pressureHpa: bounded((u16(7) / 1000) * 33.8638866667, 800, 1150),
    stationPressureHpa: type === 1 ? bounded((u16(67) / 1000) * 33.8638866667, 200, 1150) : null,
    windSpeedMs: packet[14] === 255 ? null : packet[14] * 0.44704,
    windMeanMs:
      type === 1
        ? u16(18) >= 0x7fff
          ? null
          : bounded((u16(18) / 10) * 0.44704, 0, 120)
        : packet[15] === 255
          ? null
          : packet[15] * 0.44704,
    windGustMs: type === 1 && u16(22) < 0x7fff ? bounded((u16(22) / 10) * 0.44704, 0, 150) : null,
    windDirectionDeg: direction >= 1 && direction <= 360 ? direction % 360 : null,
    rainTodayMm: clicks(50),
    rainRateMmH: clicks(41),
    solarWm2: bounded(u16(44), 0, 2000),
    ...(type === 1
      ? { rainLastHourMm: clicks(54), rainLast24HoursMm: clicks(58, 10000), rainLast15MinutesMm: clicks(52) }
      : {}),
  };
  return {
    measurements,
    sensorContact: measurements.temperatureC !== null && measurements.humidityPct !== null,
    rawFields: {
      packetType: type,
      rainTodayClicks: measurements.rainTodayMm === null ? null : u16(50),
      uv: packet[43],
      transmitterBattery: type === 0 ? packet[86] : null,
      pressureReduction: type === 1 ? packet[60] : null,
    },
  };
}

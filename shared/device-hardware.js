export function deviceProfile(current, kind) {
  const base = {
    stationId: current.stationId,
    mqttHost: current.mqttHost,
    mqttPort: current.mqttPort,
    sampleSeconds: current.sampleSeconds ?? 2,
  };
  if (kind === 'davis-iss-rfm69')
    return {
      ...base,
      interface: kind,
      radioBand: 'EU868',
      transmitterId: 1,
      spiSck: 18,
      spiMiso: 19,
      spiMosi: 23,
      radioCs: 27,
      radioReset: 14,
      radioDio0: 26,
      radioRssiThresholdDbm: -85,
    };
  if (kind === 'davis-iss-rs485')
    return { ...base, interface: kind, uartRx: 16, uartBaud: '4800', rs485De: 25, rs485Re: 26 };
  return { ...base, uartRx: 16, uartTx: 17, uartBaud: '19200' };
}
export function deviceInterfaceName(configuration) {
  return configuration.interface === 'davis-iss-rfm69'
    ? 'RFM69HCW · 868 MHz'
    : configuration.interface === 'davis-iss-rs485'
      ? 'MAX3485 · Kablet ISS'
      : 'Davis WeatherLink seriell';
}

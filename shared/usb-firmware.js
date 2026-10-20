// Browser-safe, deterministic signed representation. Segment order is significant.
export function usbManifestText(m) {
  return [
    m.format,
    m.stationId,
    m.environment,
    m.certificateId,
    m.configurationHash,
    m.version,
    m.chip,
    m.flashSize,
    m.securityProfile,
    ...m.segments.map((s) => `${s.name}:${s.address}:${s.size}:${s.sha256}`),
    '',
  ].join('\n');
}
export const usbLayout = [
  { name: 'bootloader', address: 0x1000, maximum: 0x7000 },
  { name: 'partition-table', address: 0x8000, maximum: 0x1000 },
  { name: 'otadata', address: 0xf000, maximum: 0x2000 },
  { name: 'app', address: 0x20000, maximum: 0x180000 },
];
export function validateUsbManifest(m) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const digest = /^[0-9a-f]{64}$/;
  if (
    !m ||
    Object.keys(m).sort().join(',') !==
      'certificateId,chip,configurationHash,environment,flashSize,format,securityProfile,segments,stationId,version' ||
    m.format !== 'wg-usb-flash-1' ||
    !uuid.test(m.stationId) ||
    !uuid.test(m.certificateId) ||
    !['production', 'development', 'test'].includes(m.environment) ||
    !digest.test(m.configurationHash) ||
    typeof m.version !== 'string' ||
    !/^[a-zA-Z0-9._+-]{1,64}$/.test(m.version) ||
    m.chip !== 'esp32' ||
    m.flashSize !== 4194304 ||
    m.securityProfile !== 'standard' ||
    !Array.isArray(m.segments) ||
    m.segments.length !== usbLayout.length
  )
    throw new Error('Ugyldig USB-manifest eller sikkerhetsprofil');
  m.segments.forEach((s, i) => {
    const expected = usbLayout[i];
    if (
      !s ||
      Object.keys(s).sort().join(',') !== 'address,name,sha256,size' ||
      s.name !== expected.name ||
      s.address !== expected.address ||
      !Number.isInteger(s.size) ||
      s.size < 1 ||
      s.size > expected.maximum ||
      !digest.test(s.sha256)
    )
      throw new Error('USB-pakken har ugyldig flashsegment');
  });
  return m;
}

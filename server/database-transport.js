import { lookup } from 'node:dns';
import { connect, isIP } from 'node:net';
import { privateNetworks } from './auth.js';
import { Rejected } from './store.js';

export const privateDatabaseAddress = privateNetworks([
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
]);

// Validate the addresses used by this very socket, not a separate DNS probe.
// Node can request either one address or all addresses for family selection.
export function privateDatabaseLookup(hostname, options, callback, resolver = lookup) {
  resolver(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
    if (!addresses.length || addresses.some((entry) => !privateDatabaseAddress(entry)))
      return callback(
        Object.assign(new Error('LAN-databasemålet må ha privat IP-adresse'), {
          code: 'DB_LAN_ADDRESS_NOT_PRIVATE',
        }),
      );
    callback(null, address, family);
  });
}

export function lanTransport(target, allowedEndpoints = []) {
  const endpoint = `${target.host.toLowerCase()}:${target.port}`;
  if (!allowedEndpoints.some((value) => value.toLowerCase() === endpoint))
    throw new Rejected('LAN-endepunktet må være tillatt i WG_DB_LAN_ENDPOINTS', 409);
  if (isIP(target.host) && !privateDatabaseAddress(target.host))
    throw new Rejected('Lokalnett krever en privat IP-adresse eller et privat DNS-mål', 409);
  // Connect directly on the private network. This mode requires neither TLS
  // nor a VPN and does not add encryption to the MySQL connection.
  return { stream: () => connect({ host: target.host, port: target.port, lookup: privateDatabaseLookup }) };
}

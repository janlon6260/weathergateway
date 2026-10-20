import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Portainer stacks have independent literal mounts, ports and networks', () => {
  const prod = JSON.parse(readFileSync('deploy/compose.production.json', 'utf8')),
    dev = JSON.parse(readFileSync('deploy/compose.development.json', 'utf8'));
  for (const [stack, environment] of [
    [prod, 'production'],
    [dev, 'development'],
  ]) {
    assert.equal(stack.services.control.environment.WG_ENVIRONMENT, environment);
    assert.ok(stack.services.control.volumes.every((v) => v.source.includes(`/${environment}`)));
    assert.equal(stack.services.public.volumes[0].read_only, true);
    assert.ok(stack.services.public.volumes[0].source.endsWith(`/${environment}/public`));
    for (const service of Object.values(stack.services)) assert.equal(service.user, '70001:70007');
    assert.deepEqual(stack.services.control.networks, ['control']);
    assert.deepEqual(stack.services.public.networks, ['public']);
    assert.equal(JSON.stringify(stack.services.public).includes('ldap-password'), false);
    assert.equal(Object.hasOwn(stack.services.public.environment, 'WG_LDAP_PASSWORD'), false);
    assert.equal(Object.hasOwn(stack.services.worker.environment, 'WG_LDAP_PASSWORD'), false);
    assert.equal(
      Object.keys(stack.services.public.environment).some((key) => key.startsWith('WG_DB_')),
      false,
    );
    assert.equal(
      stack.services.public.volumes.some((volume) => volume.target.includes('db-ca')),
      false,
    );
    assert.equal(JSON.stringify(stack.services.worker).includes('client-ca.key'), false);
    assert.equal(JSON.stringify(stack).includes('/var/run/docker.sock'), false);
    assert.equal(stack.services.prepare.user, '70001:70007');
    assert.equal(stack.services.prepare.network_mode, 'none');
    assert.equal(stack.services['firmware-builder'].network_mode, 'none');
    assert.equal(stack.services['firmware-builder'].volumes.length, 2);
    assert.equal(
      stack.services['firmware-builder'].volumes.some((v) => v.source.includes('/secrets/')),
      false,
    );
    assert.ok(stack.services.control.volumes.every((v) => !/\.(pem|key)$/.test(v.source)));
    assert.equal(stack.services.control.depends_on.prepare.condition, 'service_completed_successfully');
    assert.equal(stack.services.worker.depends_on.broker.condition, 'service_started');
    assert.ok(stack.services.worker.volumes.some((v) => v.source.endsWith('/roles/worker') && v.read_only));
    assert.ok(stack.services.broker.volumes.some((v) => v.source.endsWith('/roles/broker') && v.read_only));
    assert.ok(stack.services.public.volumes.some((v) => v.source.endsWith('/roles/public') && v.read_only));
  }
  assert.notEqual(prod.services.control.ports[0], dev.services.control.ports[0]);
  assert.notEqual(prod.services.broker.ports[0], dev.services.broker.ports[0]);
});

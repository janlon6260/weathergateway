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
    assert.notEqual(stack.services.public.user, stack.services.control.user);
    assert.deepEqual(stack.services.control.networks, ['control']);
    assert.deepEqual(stack.services.public.networks, ['public']);
    assert.equal(JSON.stringify(stack.services.public).includes('ldap-password'), false);
    assert.equal(Object.hasOwn(stack.services.public.environment, 'WG_LDAP_PASSWORD'), false);
    assert.equal(Object.hasOwn(stack.services.worker.environment, 'WG_LDAP_PASSWORD'), false);
    assert.equal(JSON.stringify(stack.services.worker).includes('client-ca.key'), false);
    assert.equal(JSON.stringify(stack).includes('/var/run/docker.sock'), false);
  }
  assert.notEqual(prod.services.control.ports[0], dev.services.control.ports[0]);
  assert.notEqual(prod.services.broker.ports[0], dev.services.broker.ports[0]);
});

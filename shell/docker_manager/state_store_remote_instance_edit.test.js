const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a0-launcher-certificate-trust-'));
const electronPath = require.resolve('electron');
const previousElectronModule = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => testRoot },
    safeStorage: null
  }
};
const stateStorePath = require.resolve('./state_store');
delete require.cache[stateStorePath];
const stateStore = require('./state_store');

after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete require.cache[stateStorePath];
  if (previousElectronModule) require.cache[electronPath] = previousElectronModule;
  else delete require.cache[electronPath];
});

async function saved(id) {
  return (await stateStore.readRemoteInstances()).find((item) => item.id === id);
}

test('certificate trust is stored only when it is exactly true', async () => {
  const trusted = await stateStore.writeRemoteInstance({
    url: 'https://trusted.example.com:5443/',
    allowUntrustedCertificate: true
  });
  assert.equal((await saved(trusted.id)).allowUntrustedCertificate, true);

  for (const value of [false, 'true', 1, null]) {
    const remote = await stateStore.writeRemoteInstance({
      url: `https://value-${String(value)}.example.com/`,
      allowUntrustedCertificate: value
    });
    assert.equal(Object.hasOwn(await saved(remote.id), 'allowUntrustedCertificate'), false);
  }
});

test('certificate trust survives edits that do not mention it, and can be turned off', async () => {
  const remote = await stateStore.writeRemoteInstance({
    name: 'Lab',
    url: 'https://lab.example.com:5443/',
    allowUntrustedCertificate: true
  });

  await stateStore.writeRemoteInstance({ id: remote.id, name: 'Lab renamed', url: remote.url });
  await stateStore.writeRemoteInstance({ id: remote.id, url: remote.url, color: '#336699' });
  const edited = await saved(remote.id);
  assert.equal(edited.name, 'Lab renamed');
  assert.equal(edited.allowUntrustedCertificate, true);

  await stateStore.writeRemoteInstance({ id: remote.id, url: remote.url, allowUntrustedCertificate: false });
  assert.equal(Object.hasOwn(await saved(remote.id), 'allowUntrustedCertificate'), false);
});

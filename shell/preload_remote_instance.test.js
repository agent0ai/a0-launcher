const assert = require('node:assert/strict');
const { after, test } = require('node:test');

const exposed = {};
const invocations = [];
const electronPath = require.resolve('electron');
const previousElectronModule = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (channel, body) => {
        invocations.push({ channel, body });
        return null;
      },
      on: () => {},
      removeListener: () => {},
      removeAllListeners: () => {},
      send: () => {}
    }
  }
};
const preloadPath = require.resolve('./preload');
delete require.cache[preloadPath];
require('./preload');

after(() => {
  delete require.cache[preloadPath];
  if (previousElectronModule) require.cache[electronPath] = previousElectronModule;
  else delete require.cache[electronPath];
});

// An absent field must stay absent: the shell applies every field it receives,
// so an empty name or URL would overwrite the saved one.
test('updateRemoteInstance forwards only the fields it was given', async () => {
  const api = exposed.dockerManagerAPI;
  invocations.length = 0;
  await api.updateRemoteInstance('remote_1', { allowUntrustedCertificate: true });
  await api.updateRemoteInstance('remote_1', {
    name: 'Lab',
    url: 'https://a0.example.com/',
    allowUntrustedCertificate: false
  });
  await api.updateRemoteInstance('remote_1', { name: 42, url: null, allowUntrustedCertificate: 'yes' });

  assert.ok(invocations.every(({ channel }) => channel === 'docker-manager:updateRemoteInstance'));
  assert.deepEqual(invocations.map(({ body }) => body), [
    { id: 'remote_1', allowUntrustedCertificate: true },
    { id: 'remote_1', name: 'Lab', url: 'https://a0.example.com/', allowUntrustedCertificate: false },
    { id: 'remote_1' }
  ]);
});

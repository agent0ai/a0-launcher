import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The renderer module touches the DOM globals when it loads.
globalThis.document = {
  body: { dataset: {} },
  addEventListener: () => {},
  createElement: () => ({ style: { setProperty: () => {} }, appendChild: (c) => c, setAttribute: () => {} }),
  getElementById: () => null
};
globalThis.window = {
  __dmLastState: null,
  addEventListener: () => {},
  dockerManagerActions: {}
};

const { certificateTrustForUrl } = await import('./remote-instance-dialog.js');

test('certificate trust is only sent for an https URL', () => {
  assert.equal(certificateTrustForUrl('https://a0.example.com:5443/', true), true);
  assert.equal(certificateTrustForUrl('https://a0.example.com:5443/', false), false);
  assert.equal(certificateTrustForUrl('http://a0.example.com/', true), false);
  assert.equal(certificateTrustForUrl('a0.example.com', true), false);
  assert.equal(certificateTrustForUrl('', true), false);
  assert.equal(certificateTrustForUrl(undefined, undefined), false);
});

// The dialog reaches the shell through window.dockerManagerActions, which is an
// explicit list in docker_manager.js over the preload bridge. An action missing
// from either list turns the button into a silent no-op.
test('every action the certificate trust flow calls is wired through preload and dockerManagerActions', async () => {
  const preload = await readFile(new URL('../../../shell/preload.js', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../../docker_manager.js', import.meta.url), 'utf8');
  const actions = manager.slice(manager.indexOf('window.dockerManagerActions = {'));
  const actionList = actions.slice(0, actions.indexOf('\n};'));
  for (const name of ['certificateTrustRestartRequired', 'restartLauncher']) {
    assert.match(preload, new RegExp(`\\b${name}:`), `${name} missing from preload`);
    assert.match(actionList, new RegExp(`\\b${name}\\b`), `${name} missing from dockerManagerActions`);
  }
});

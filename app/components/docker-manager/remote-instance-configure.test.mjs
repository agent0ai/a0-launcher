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

const {
  loginFieldHtml,
  remoteCredentialEditAction,
  remoteHostAccessEditPayload
} = await import('./remote-instance-dialog.js');

test('saved credentials are kept unless the user picks change or remove', () => {
  assert.deepEqual(remoteCredentialEditAction({ saved: true }), { ok: true, action: 'keep' });
  assert.deepEqual(remoteCredentialEditAction({ saved: true, mode: 'keep', username: '', password: '' }), {
    ok: true,
    action: 'keep'
  });
  assert.deepEqual(remoteCredentialEditAction({ saved: true, mode: 'unknown' }), { ok: true, action: 'keep' });
  assert.deepEqual(remoteCredentialEditAction({ saved: true, mode: 'remove' }), { ok: true, action: 'clear' });
});

test('changing saved credentials needs both username and password', () => {
  assert.deepEqual(remoteCredentialEditAction({ saved: true, mode: 'change', username: 'dev', password: 'new' }), {
    ok: true,
    action: 'save',
    credentials: { username: 'dev', password: 'new' }
  });
  assert.equal(remoteCredentialEditAction({ saved: true, mode: 'change', username: 'dev', password: '' }).ok, false);
  assert.equal(remoteCredentialEditAction({ saved: true, mode: 'change', username: '', password: 'new' }).ok, false);
});

test('without saved credentials Configure behaves like the add form', () => {
  assert.deepEqual(remoteCredentialEditAction({ saved: false, remember: false }), { ok: true, action: 'none' });
  assert.deepEqual(remoteCredentialEditAction({ saved: false, remember: true, username: 'dev', password: 'pw' }), {
    ok: true,
    action: 'save',
    credentials: { username: 'dev', password: 'pw' }
  });
  assert.equal(remoteCredentialEditAction({ saved: false, remember: true, username: 'dev', password: '' }).ok, false);
});

test('saved credentials render as a saved state, not as empty inputs', () => {
  const html = loginFieldHtml({ saved: true, username: 'gf' });
  assert.match(html, /Credentials saved/);
  assert.match(html, /Username: <b>gf<\/b>/);
  assert.match(html, /data-credentials-mode="change"/);
  assert.match(html, /data-credentials-mode="remove"/);
  // the inputs exist for Change, but start hidden
  assert.match(html, /<div data-credentials-view="change" hidden>/);
  assert.doesNotMatch(html, /remoteRememberCredentials/);
});

test('the saved username is escaped', () => {
  const html = loginFieldHtml({ saved: true, username: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('with nothing saved the Login block is the plain add form', () => {
  const html = loginFieldHtml(null);
  assert.match(html, /id="remoteAuthLogin"/);
  assert.match(html, /id="remoteRememberCredentials"/);
  assert.doesNotMatch(html, /Credentials saved/);
});

test('Configure sends Host access only when it changed, and keeps hidden fields', () => {
  const current = {
    configured: true,
    masterEnabled: false,
    folder: '/work',
    scopes: { files: true, file_write: true, code_execution: true, browser: false, computer_use: false },
    browserSelection: 'profile-1'
  };
  const sameScopesOtherOrder = { computer_use: false, browser: false, code_execution: true, file_write: true, files: true };

  assert.deepEqual(remoteHostAccessEditPayload(current, { connect: true, folder: '/work', scopes: sameScopesOtherOrder }), {
    ok: true,
    payload: null
  });

  const moved = remoteHostAccessEditPayload(current, { connect: true, folder: '/other', scopes: current.scopes });
  assert.equal(moved.payload.folder, '/other');
  assert.equal(moved.payload.masterEnabled, false);
  assert.equal(moved.payload.browserSelection, 'profile-1');

  const off = remoteHostAccessEditPayload(current, { connect: false, folder: '/work', scopes: current.scopes });
  assert.equal(off.payload.configured, false);
  assert.equal(off.payload.folder, '');

  assert.equal(remoteHostAccessEditPayload({}, { connect: true, folder: '', scopes: {} }).ok, false);
  assert.deepEqual(remoteHostAccessEditPayload({}, { connect: false, folder: '', scopes: {} }), { ok: true, payload: null });
});

// The dialog reaches the shell through window.dockerManagerActions, which is an
// explicit list in docker_manager.js over the preload bridge. An action missing
// from either list turns the button into a silent no-op.
test('every action Configure calls is wired through preload and dockerManagerActions', async () => {
  const preload = await readFile(new URL('../../../shell/preload.js', import.meta.url), 'utf8');
  const manager = await readFile(new URL('../../docker_manager.js', import.meta.url), 'utf8');
  const actions = manager.slice(manager.indexOf('window.dockerManagerActions = {'));
  const actionList = actions.slice(0, actions.indexOf('\n};'));
  for (const name of [
    'updateRemoteInstance',
    'setRemoteInstanceCredentials',
    'clearRemoteInstanceCredentials',
    'setInstanceHostAccess'
  ]) {
    assert.match(preload, new RegExp(`\\b${name}:`), `${name} missing from preload`);
    assert.match(actionList, new RegExp(`\\b${name}\\b`), `${name} missing from dockerManagerActions`);
  }
});

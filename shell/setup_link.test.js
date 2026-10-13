const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isSetupLink, setupLinkFromArguments } = require('./setup_link');

test('setup link is a fixed navigation intent with no payload', () => {
  for (const value of ['a0-launcher://setup', 'a0-launcher://setup/']) assert.equal(isSetupLink(value), true);
  for (const value of [null, {}, 'https://setup', 'a0-launcher://setup?code=ABCD',
    'a0-launcher://setup#token', 'a0-launcher://user:pass@setup', 'a0-launcher://setup/../',
    'a0-launcher://setup/permissions', 'a0-launcher://setup:123', 'a0-launcher://setup\n']) {
    assert.equal(isSetupLink(value), false);
  }
  assert.equal(setupLinkFromArguments(['launcher', '--flag', 'a0-launcher://setup']), true);
  assert.equal(setupLinkFromArguments(['launcher', '--url=a0-launcher://setup']), false);
});

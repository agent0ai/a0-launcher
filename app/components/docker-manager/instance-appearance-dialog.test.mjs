import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const {
  INSTANCE_ICON_OPTIONS,
  instanceColorTone,
  normalizedInstanceColorId,
  instanceIconName,
  normalizedInstanceIconId
} = await import('./card-visuals.js');

test('custom colours accept only RGB hex and produce matching accent tones', () => {
  assert.equal(normalizedInstanceColorId(' #A1B2C3 '), '#a1b2c3');
  assert.deepEqual(instanceColorTone('#A1B2C3'), { fg: '#a1b2c3', bg: '#a1b2c324', border: '#a1b2c33d' });
  for (const value of ['#fff', '#12345678', '#zzzzzz', 'url(file:///tmp/image)', 'rgb(1,2,3)']) {
    assert.equal(normalizedInstanceColorId(value), '');
    assert.equal(instanceColorTone(value), null);
  }
});

test('Instance appearance defaults to Favicon alongside 14 bounded custom icons', () => {
  assert.equal(INSTANCE_ICON_OPTIONS.length, 15);
  assert.equal(new Set(INSTANCE_ICON_OPTIONS.map(({ id }) => id)).size, 15);
  assert.deepEqual(INSTANCE_ICON_OPTIONS[0], { id: '', label: 'Favicon' });
  assert.equal(normalizedInstanceIconId('language'), 'language');
  assert.equal(normalizedInstanceIconId('auto_awesome'), 'auto_awesome');
  assert.equal(normalizedInstanceIconId('favorite'), 'favorite');
  assert.equal(normalizedInstanceIconId('data:image/png;base64,iVBORw0KGgo='), 'custom');
  assert.equal(normalizedInstanceIconId('data:text/html;base64,YQ=='), '');
  assert.equal(normalizedInstanceIconId(' terminal '), 'terminal');
  assert.equal(normalizedInstanceIconId('not-an-icon'), '');
  assert.equal(instanceIconName('not-an-icon'), 'language');
});

test('attached and detached tabs share Colour/Icon selection and label collapse', async () => {
  const [tabs, detached, css] = await Promise.all([
    readFile(new URL('./instance-tabs/instance-tabs.js', import.meta.url), 'utf8'),
    readFile(new URL('./instance-tabs/detached.js', import.meta.url), 'utf8'),
    readFile(new URL('../../docker_manager.css', import.meta.url), 'utf8')
  ]);
  assert.match(tabs, /openInstanceAppearanceDialog/);
  assert.match(detached, /openInstanceAppearanceDialog/);
  assert.match(tabs, /label_off/);
  assert.match(css, /names-collapsed \.dm-instance-home-tab \.dm-instance-tab-title/);
});

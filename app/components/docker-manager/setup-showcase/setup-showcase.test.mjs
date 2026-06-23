import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { SETUP_SHOWCASE_SLIDES } from './setup-showcase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '../../../');

test('setup showcase slides use renderer-visible image assets', () => {
  for (const slide of SETUP_SHOWCASE_SLIDES) {
    assert.equal(slide.mediaType, 'image', `${slide.id} should render as an image in the install modal`);
    assert.ok(fs.existsSync(path.join(appRoot, slide.media)), `${slide.id} media asset should exist`);
  }
});

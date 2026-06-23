const assert = require('node:assert/strict');
const { test } = require('node:test');

const dockerManager = require('./index');

const { shouldKeepCreatedManagedInstanceOnError } = dockerManager._test;

test('managed instance run keeps started containers when UI readiness is slow', () => {
  const error = new Error('Agent Zero UI is not reachable yet after starting the instance.');
  error.code = 'UI_NOT_READY';

  assert.equal(
    shouldKeepCreatedManagedInstanceOnError(error, { containerId: 'abc123' }),
    true
  );
  assert.equal(
    shouldKeepCreatedManagedInstanceOnError(error, null),
    false
  );

  const createError = new Error('Failed to create container');
  createError.code = 'CREATE_FAILED';
  assert.equal(
    shouldKeepCreatedManagedInstanceOnError(createError, { containerId: 'abc123' }),
    false
  );
});

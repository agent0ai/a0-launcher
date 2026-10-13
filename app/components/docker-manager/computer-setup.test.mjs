import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupChoices,localSetupSteps,verificationMessage,waitForRestartedHost} from './computer-setup.js';

test('automatic checks wait for the replacement connection, not a stale ready state', async () => {
  const events = new EventTarget();
  const wait = waitForRestartedHost(events, 'chosen', true);
  let ready = false;
  wait.promise.then(() => { ready = true; });
  const send = connected => events.dispatchEvent(new CustomEvent('dm:state', {detail:{instanceTabs:{tabs:[{id:'chosen',hostAccess:{connected}}]}}}));
  send(true);
  await Promise.resolve();
  assert.equal(ready, false);
  send(false);
  send(true);
  await wait.promise;
  assert.equal(ready, true);
});

test('closing setup or a timed-out connection cancels automatic checks', async () => {
  const events = new EventTarget();
  const wait = waitForRestartedHost(events, 'chosen', false);
  wait.cancel();
  await assert.rejects(wait.promise, /cancelled/);
  await assert.rejects(waitForRestartedHost(events, 'chosen', false, 1).promise, /longer than expected/);
});

test('test receipts require confirmed input and capture evidence for the requested capability',()=> {
  const result={accepted:true,result:{capability:'browser',verified:true,evidence:['test_page_input','fresh_capture']}};
  assert.match(verificationMessage(result,'browser'), /typing and capture checked/);
  for (const invalid of [false,{accepted:true},{...result,result:{...result.result,verified:false}},
    {...result,result:{...result.result,capability:'computer_use'}},
    {...result,result:{...result.result,evidence:['fresh_capture']}}]) {
    assert.throws(()=>verificationMessage(invalid,'browser'));
  }
});

test('new guided setup does not inherit file or command defaults',()=> {
  const choices=setupChoices({configured:false,scopes:{files:true,file_write:true,code_execution:true}});
  assert.deepEqual(choices,{browser:false,computer_use:false,files:false,file_write:false,code_execution:false});
});
test('existing permissions are preserved independently',()=> {
  assert.deepEqual(setupChoices({configured:true,scopes:{files:true,file_write:false,browser:true}}),
    {browser:true,computer_use:false,files:true,file_write:false,code_execution:false});
});
test('saved access never masquerades as runtime readiness',()=> {
  const steps=localSetupSteps({hostAccess:{connected:true,config:{configured:true,masterEnabled:false,scopes:{browser:true}},gateway:{status:{browser:{status:'ready'}}}}});
  assert.equal(steps[1].state,'action_on_computer');
  assert.equal(steps[1].action,'choose_access');
});

test('verified steps survive local updates only with fresh evidence and allowed access', () => {
  const receipt = {capability:'browser', verified:true, checked_at:Date.now()/1000, evidence:['test_page_input','fresh_capture']};
  const tab = {hostAccess:{connected:true,config:{configured:true,scopes:{browser:true}},gateway:{status:{browser:{status:'active'},setup_verifications:{browser:receipt}}}}};
  assert.equal(localSetupSteps(tab)[1].reason, 'verified');
  receipt.checked_at -= 301;
  assert.notEqual(localSetupSteps(tab)[1].reason, 'verified');
  receipt.checked_at = Date.now()/1000;
  tab.hostAccess.config.scopes.browser = false;
  assert.notEqual(localSetupSteps(tab)[1].reason, 'verified');
});

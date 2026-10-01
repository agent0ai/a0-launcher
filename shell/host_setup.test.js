const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestHostSetup } = require('./host_setup');
const identity = 'a'.repeat(32);

test('remote instance base paths are preserved',async()=> {
  const urls=[];
  await requestHostSetup({origin:'https://a0.example/team/',action:'status',fetch:async url=> {
    urls.push(url);return new Response(JSON.stringify(urls.length === 1 ? {ok:true,token:'fixture'}:{version:1,server_id:identity}));
  }});
  assert.equal(urls[0],'https://a0.example/team/api/csrf_token');
  assert.equal(urls[1],'https://a0.example/team/api/plugins/_a0_connector/v1/host_setup');
});

test('setup uses the selected origin, CSRF and no redirects or retries', async () => {
  const calls = [];
  const result = await requestHostSetup({ origin:'https://a0.example', action:'status', fetch:async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify(calls.length === 1 ? {ok:true,token:'test-csrf'} : {version:1,server_id:identity,steps:[]}));
  }});
  assert.equal(result.server_id,identity);
  assert.equal(calls[1].options.headers['X-CSRF-Token'],'test-csrf');
  assert.equal(calls[1].options.redirect,'manual');
  assert.equal(calls[1].url,'https://a0.example/api/plugins/_a0_connector/v1/host_setup');
});

test('untrusted origins and actions never issue a request', async () => {
  for (const input of [{origin:'http://remote.example',action:'status'}, {origin:'https://a0.example',action:'run'}, {origin:'https://user:pass@a0.example',action:'status'}]) {
    await assert.rejects(requestHostSetup({...input,fetch:()=>assert.fail('sent')}));
  }
});

test('session change prevents the second request', async () => {
  let calls=0;
  await assert.rejects(requestHostSetup({origin:'https://a0.example',action:'status',current:()=>false,fetch:async()=>{
    calls++;return new Response(JSON.stringify({ok:true,token:'test'}));
  }}));
  assert.equal(calls,1);
});

test('redirect and oversized replies fail closed', async () => {
  for (const response of [new Response('',{status:302}),new Response('x'.repeat(65537))]) {
    let calls=0;
    await assert.rejects(requestHostSetup({origin:'https://a0.example',action:'status',fetch:async()=>{ calls++;return response; }}));
    assert.equal(calls,1);
  }
});

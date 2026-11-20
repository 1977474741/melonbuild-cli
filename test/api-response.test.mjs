import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi} from '../src/api.mjs';
const origin='https://www.melonbuild.com';
test('proxy error pages preserve HTTP failure instead of reporting invalid JSON',async()=>{
  for(const status of [502,503,504,403]) {
    const api=createApi(origin,{fetchImpl:async()=>new Response('<html>Bad Gateway</html>',{status,headers:{'content-type':'text/html'}})});
    await assert.rejects(api('/api/cli/v1/conversions',{}),e=>e.code===(status>=500?'SERVICE_UNAVAILABLE':'HTTP_ERROR')&&e.status===status&&e.message.includes(String(status))&&!e.message.includes('<html>'));
  }
});
test('a broken response stream is a network error, and invalid successful JSON stays invalid',async()=>{
  const api=createApi(origin,{fetchImpl:async()=>new Response(new ReadableStream({start(c){c.error(new Error('terminated'));}}))});
  await assert.rejects(api('/api/cli/v1/account'),e=>e.code==='NETWORK_ERROR');
  const invalid=createApi(origin,{fetchImpl:async()=>new Response('not JSON')});
  await assert.rejects(invalid('/api/cli/v1/account'),e=>e.code==='INVALID_RESPONSE'&&e.status===200);
});

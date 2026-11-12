import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localizeImages,imageLinks,assetUrl} from '../src/assets.mjs';
import {saveCredential,loadCredential,atomicWrite} from '../src/storage.mjs';
import {createApi} from '../src/api.mjs';
const url='https://s3-alpha.figma.com/image.svg?Expires=9999999999&Signature=abc';
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
function ast(){return {name:url,fileKey:'Abc123',nodes:[{tag:'img',src:url},{t:'T0',args:{p:url}},{tag:'TEXT',text:url}],templates:{T0:{params:{p:url},body:{tag:'img',src:{$param:'p'}}}},globalStyles:{fill_a:{backgroundImage:'url('+url+')'}}};}
test('local downloader finds node, CSS and template links; deduplicates, rewrites and resumes without API or auth',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-assets-'));let calls=0;
  const fetchImpl=async(input,options)=>{calls++;assert.equal(String(input),url);assert.equal(options.headers,undefined);return new Response(svg,{headers:{'content-type':'image/svg+xml'}});};
  try {
    assert.deepEqual(imageLinks(ast()),[url]);
    const options={imageDir:join(directory,'images'),output:join(directory,'ast.json'),fetchImpl};
    const first=await localizeImages(ast(),options);assert.equal(calls,1);assert.equal(first.failed.length,0);
    const local=first.ast.nodes[0].src;assert.match(local,/^\.\/images\/[a-f0-9]{64}\.svg$/);
    assert.equal(first.ast.templates.T0.params.p,local);assert.equal(first.ast.nodes[1].args.p,local);
    assert.equal(first.ast.nodes[2].text,url);assert.equal(first.ast.name,url);assert.ok(first.ast.globalStyles.fill_a.backgroundImage.includes(local));
    assert.equal(await readFile(join(directory,local),'utf8'),svg);
    const resumed=await localizeImages(ast(),{...options,fetchImpl:async()=>{throw new Error('No network expected');}});
    assert.equal(resumed.downloaded,1);assert.equal(resumed.failed.length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('download failure retains original links and a retry manifest; later run fetches only missing assets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-assets-failure-'));const other='https://s3-alpha.figma.com/other.png';
  const document={...ast(),nodes:[{tag:'img',src:url},{tag:'img',src:other}]};let good=0,bad=0;
  try {
    const first=await localizeImages(document,{imageDir:directory,fetchImpl:async input=>{
      if(String(input)===other){bad++;return new Response('',{status:403});}good++;return new Response(svg,{headers:{'content-type':'image/svg+xml'}});
    }});
    assert.equal(first.failed.length,1);assert.equal(first.failed[0].code,'IMAGE_URL_EXPIRED');assert.equal(first.ast.nodes[1].src,other);assert.equal(good,1);assert.equal(bad,1);
    const retry=await localizeImages(document,{imageDir:directory,fetchImpl:async input=>{assert.equal(String(input),other);return new Response('PNG fixture',{headers:{'content-type':'image/png'}});}});
    assert.equal(retry.failed.length,0);assert.equal(retry.downloaded,2);
    assert.equal(JSON.parse(await readFile(first.manifestPath,'utf8')).failed.length,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('images reject untrusted hosts, unsafe redirects, oversized content and HTML error bodies',async()=>{
  for(const value of ['http://s3-alpha.figma.com/a','https://localhost/a','https://s3-alpha.figma.com.evil.test/a','https://u:p@s3-alpha.figma.com/a','https://s3-alpha.figma.com:444/a'])assert.throws(()=>assetUrl(value));
  for(const response of [()=>new Response('',{status:302,headers:{location:'https://127.0.0.1/private'}}),()=>new Response('too large',{headers:{'content-type':'image/png'}}),()=>new Response('<html>bad</html>',{headers:{'content-type':'text/html'}})]) {
    const directory=await mkdtemp(join(tmpdir(),'melonbuild-assets-guard-'));
    try{const result=await localizeImages(ast(),{imageDir:directory,maxImageBytes:3,fetchImpl:async()=>response()});assert.equal(result.downloaded,0);assert.equal(result.failed.length,1);}finally{await rm(directory,{recursive:true,force:true});}
  }
});
test('local credential storage is private and atomic; user files and symlinks are protected',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-credentials-'));
  try {
    const credential={origin:'https://www.melonbuild.com',token:'secret'};await saveCredential(directory,credential);assert.deepEqual(await loadCredential(directory),credential);
    if(process.platform!=='win32')assert.equal((await stat(join(directory,'credential.json'))).mode&0o777,0o600);
    const file=join(directory,'existing');await writeFile(file,'user data');await assert.rejects(atomicWrite(file,'replace'));assert.equal(await readFile(file,'utf8'),'user data');
    await symlink(file,join(directory,'link'));await assert.rejects(atomicWrite(join(directory,'link'),'replace',{overwrite:true}));
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('API binds platform bearer token only to its own request and preserves quota/Retry-After errors',async()=>{
  const api=createApi('https://www.melonbuild.com',{token:'platform-token',fetchImpl:async(input,init)=>{
    assert.equal(new URL(input).origin,'https://www.melonbuild.com');assert.equal(init.headers.authorization,'Bearer platform-token');
    return Response.json({requestId:'r',error:{code:'FREE_QUOTA_EXHAUSTED',message:'No trial'}},{status:403,headers:{'Retry-After':'172800'}});
  }});
  await assert.rejects(api('/api/cli/v1/conversions',{}),e=>e.code==='FREE_QUOTA_EXHAUSTED'&&e.retryAfter===172800&&e.subscriptionUrl.endsWith('/subscribe'));
});

test('nested template image parameters propagate without rewriting an unrelated text parameter',async()=>{
 const document={name:'Nested',nodes:[{t:'Outer',args:{picture:url,copy:url}}],templates:{
  Inner:{params:{image:url},body:{tag:'img',src:{$param:'image'}}},
  Outer:{params:{picture:url,copy:url},body:{tag:'FRAME',children:[{t:'Inner',args:{image:{$param:'picture'}}},{tag:'TEXT',text:{$param:'copy'}}]}},
 }};
 const {replaceLinks}=await import('../src/assets.mjs');assert.deepEqual(imageLinks(document),[url]);
 const local=replaceLinks(document,new Map([[url,'./images/icon.svg']]));
 assert.equal(local.templates.Outer.params.picture,'./images/icon.svg');assert.equal(local.templates.Outer.params.copy,url);
 assert.equal(local.nodes[0].args.picture,'./images/icon.svg');assert.equal(local.nodes[0].args.copy,url);
});

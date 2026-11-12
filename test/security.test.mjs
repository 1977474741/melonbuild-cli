import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,chmod,rm,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveCredential,loadCredential} from '../src/storage.mjs';
import {createApi} from '../src/api.mjs';
const value={origin:'https://www.melonbuild.com',token:'mb_cli_'+'a'.repeat(43),expiresAt:'2099-01-01T00:00:00.000Z'};
test('credential reads reject a publicly readable file or writable directory before using its token',{skip:process.platform==='win32'?'Unix permission bits do not apply on Windows':false},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild-security-permissions-'));
 try {
  await saveCredential(directory,value);assert.deepEqual(await loadCredential(directory),value);
  await chmod(join(directory,'credential.json'),0o644);
  await assert.rejects(loadCredential(directory),e=>e.code==='INSECURE_CREDENTIAL_STORAGE');
  await chmod(join(directory,'credential.json'),0o600);await chmod(directory,0o755);
  await assert.rejects(loadCredential(directory),e=>e.code==='INSECURE_CREDENTIAL_STORAGE');
  await chmod(directory,0o700);assert.deepEqual(await loadCredential(directory),value);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('credential reads and writes reject a symbolic file link when supported',async t=>{
 const root=await mkdtemp(join(tmpdir(),'melonbuild-security-file-link-'));
 try {
  await saveCredential(root,value);await rename(join(root,'credential.json'),join(root,'real.json'));
  try{await symlink(join(root,'real.json'),join(root,'credential.json'),'file');}
  catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file symlinks require Developer Mode or elevated rights');return;}throw error;}
  await assert.rejects(loadCredential(root),e=>e.code==='INSECURE_CREDENTIAL_STORAGE');
  await assert.rejects(saveCredential(root,value));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('credential reads and saves reject config directory links or Windows junctions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'melonbuild-security-directory-link-')),directory=join(root,'actual');
 try {
  await saveCredential(directory,value);
  await symlink(directory,join(root,'linked-config'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(loadCredential(join(root,'linked-config')),e=>e.code==='INSECURE_CREDENTIAL_STORAGE');
  await assert.rejects(saveCredential(join(root,'linked-config'),value),e=>e.code==='INSECURE_CREDENTIAL_STORAGE');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('platform token cannot be forwarded to an absolute foreign URL, protocol-relative host, HTTP endpoint or URL credentials',async()=>{
 let calls=0;
 const api=createApi(value.origin,{token:value.token,fetchImpl:async()=>{calls++;return Response.json({ok:true});}});
 for(const path of ['https://attacker.example/api/cli/v1/account','//attacker.example/api/cli/v1/account','http://www.melonbuild.com/api/cli/v1/account','https://u:p@www.melonbuild.com/api/cli/v1/account'])
  await assert.rejects(api(path),e=>e.code==='API_ORIGIN_MISMATCH');
 assert.equal(calls,0);assert.deepEqual(await api('/api/cli/v1/account'),{ok:true});assert.equal(calls,1);
});

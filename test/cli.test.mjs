import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),cli=fileURLToPath(new URL('../dist/cli.mjs',import.meta.url)),fixture=new URL('./fixture-preload.mjs',import.meta.url).href;
const token='mb_cli_'+'a'.repeat(43);
async function run(directory,args,env={}){return exec(process.execPath,['--import',fixture,cli,...args],{env:{...process.env,MELONBUILD_CONFIG_DIR:directory,CLI_TEST_LOG:join(directory,'calls.log'),...env}});}
test('built CLI keeps stdout compact JSON, supports local-only retries and fails preflight before chargeable API',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild CLI 中文路径-'));
 try {
  await writeFile(join(directory,'credential.json'),JSON.stringify({origin:'https://www.melonbuild.com',token,expiresAt:new Date(Date.now()+86400000).toISOString()}),{mode:0o600});
  const who=await run(directory,['whoami','--json']);assert.equal(JSON.parse(who.stdout).actor.displayName,'Fixture User');
  const result=await run(directory,['node-ast','https://www.figma.com/design/Abc123?node-id=1-2']);assert.ok(JSON.parse(result.stdout).nodes);assert.ok(!result.stdout.includes('\n'));assert.match(result.stderr,/剩余/);
  const output=join(directory,'ast.json'),images=join(directory,'images');
  await run(directory,['node-ast','Abc123','1:2','--output',output,'--image-dir',images]);
  assert.match(JSON.parse(await readFile(output,'utf8')).nodes[0].src,/^\.\/images\//);
  const remote=output+'.remote.json';assert.match(JSON.parse(await readFile(remote,'utf8')).nodes[0].src,/^https:/);
  const before=await readFile(join(directory,'calls.log'),'utf8');
  await assert.rejects(run(directory,['node-ast','Abc123','1:2','--output',output]));assert.equal(await readFile(join(directory,'calls.log'),'utf8'),before);
  await rm(join(directory,'credential.json'));
  await run(directory,['download-images',remote,'--image-dir',images,'--output',join(directory,'retried.json')]);
  assert.equal(await readFile(join(directory,'calls.log'),'utf8'),before);
  await assert.rejects(run(directory,['node-ast','Abc123','1:2','--format','xml']),e=>/固定输出紧凑 JSON/.test(e.stderr));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('built CLI browser login stores platform token and logout revokes it; quota returns exit code 3',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild-cli-login-'));
 try {
  const login=await run(directory,['login','--no-browser']);assert.match(login.stderr,/ABCD123456/);assert.equal(login.stdout,'');
  assert.equal(JSON.parse(await readFile(join(directory,'credential.json'),'utf8')).token,token);
  await assert.rejects(run(directory,['node-ast','Abc123','1:2','--json'],{CLI_TEST_QUOTA:'1'}),e=>e.code===3&&JSON.parse(e.stderr.trim().split('\n').at(-1)).error.subscriptionUrl==='https://www.melonbuild.com/subscribe');
  await run(directory,['logout']);await assert.rejects(access(join(directory,'credential.json')));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('CLI distinguishes the 100 KB trial from 30 KB access after trial and still accepts a successful AST at zero',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild-cli-trial-'));
 try {
  await writeFile(join(directory,'credential.json'),JSON.stringify({origin:'https://www.melonbuild.com',token,expiresAt:new Date(Date.now()+86400000).toISOString()}),{mode:0o600});
  const trial=await run(directory,['whoami']);assert.match(trial.stdout,/100 KB/);assert.doesNotMatch(trial.stdout,/试用已用完/);
  const after=await run(directory,['whoami'],{CLI_TEST_AFTER_TRIAL:'1'});assert.match(after.stdout,/试用已用完.*30 KB/);assert.doesNotMatch(after.stdout,/100 KB/);
  const ast=await run(directory,['node-ast','Abc123','1:2'],{CLI_TEST_AFTER_TRIAL:'1'});assert.ok(JSON.parse(ast.stdout).nodes);assert.match(ast.stderr,/后续仍可免费获取不超过 30 KB/);
  const help=await run(directory,['--help']);assert.match(help.stdout,/每次完整 AST 最多 100 KB/);assert.match(help.stdout,/10 次用完后.*30 KB/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('logout --all requests account-scoped revocation and does not claim success for an expired login',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild-cli-revoke-all-'));
 try {
  await writeFile(join(directory,'credential.json'),JSON.stringify({origin:'https://www.melonbuild.com',token,expiresAt:new Date(Date.now()+86400000).toISOString()}),{mode:0o600});
  const result=await run(directory,['logout','--all']);assert.match(result.stderr,/全部 CLI 登录凭据已撤销/);await assert.rejects(access(join(directory,'credential.json')));
  await assert.rejects(run(directory,['logout','--all']),e=>e.code===2&&/需要先运行/.test(e.stderr));
 }finally{await rm(directory,{recursive:true,force:true});}
});

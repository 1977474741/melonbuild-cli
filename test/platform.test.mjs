import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,cp,symlink,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomicWrite,configDirectory} from '../src/storage.mjs';
const exec=promisify(execFile);
test('source can build and run from a repository path containing spaces and Chinese characters',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'MelonBuild 构建 空格-')),root=fileURLToPath(new URL('../',import.meta.url));
 try {
  await cp(join(root,'src'),join(directory,'src'),{recursive:true});
  await cp(join(root,'scripts'),join(directory,'scripts'),{recursive:true});
  await cp(join(root,'package.json'),join(directory,'package.json'));
  await symlink(join(root,'node_modules'),join(directory,'node_modules'),process.platform==='win32'?'junction':'dir');
  await exec(process.execPath,[join(directory,'scripts','build.mjs')],{cwd:directory});
  const result=await exec(process.execPath,[join(directory,'dist','cli.mjs'),'--version'],{cwd:directory});
  assert.match(result.stdout,/^0\.1\.0\s*$/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('exclusive output falls back when the filesystem rejects hard links and still protects an existing file',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'MelonBuild 文件-'));
 const unsupported=async()=>{throw Object.assign(new Error('No hard links'),{code:'ENOTSUP'});};
 try {
  const output=join(directory,'输出 文件.json');await atomicWrite(output,'{"ok":true}',{linkFile:unsupported});
  assert.equal(await readFile(output,'utf8'),'{"ok":true}');
  const raced=join(directory,'用户 文件.json');
  await assert.rejects(atomicWrite(raced,'overwrite',{linkFile:async()=>{await writeFile(raced,'user content');await unsupported();}}),e=>e.code==='EEXIST');
  assert.equal(await readFile(raced,'utf8'),'user content');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('native platform configuration paths and an explicit Unicode override resolve correctly',()=>{
 const base=resolve(tmpdir(),'用户 配置');
 assert.equal(configDirectory({MELONBUILD_CONFIG_DIR:base}),base);
 if(process.platform==='win32')assert.equal(configDirectory({LOCALAPPDATA:base}),join(base,'melonbuild'));
 else assert.equal(configDirectory({XDG_CONFIG_HOME:base}),join(base,'melonbuild'));
});

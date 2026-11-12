import {mkdir,writeFile,readFile,rename,rm,lstat,chmod,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {CliError} from './api.mjs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export function configDirectory(env=process.env) {
  if(env.MELONBUILD_CONFIG_DIR)return resolve(env.MELONBUILD_CONFIG_DIR);
  if(process.platform==='win32')return join(env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'melonbuild');
  return join(env.XDG_CONFIG_HOME||join(homedir(),'.config'),'melonbuild');
}
export async function atomicWrite(file,data,{overwrite=false,privateFile=false}={}) {
  await mkdir(dirname(file),{recursive:true,...(privateFile?{mode:0o700}:{})});
  const existing=await lstat(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(existing?.isSymbolicLink()||existing&&!existing.isFile())throw new Error('拒绝写入非普通文件：'+file);
  if(existing&&!overwrite)throw new Error('文件已存在，请使用 --overwrite 或更换输出位置：'+file);
  const temporary=file+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temporary,data,{flag:'wx',mode:privateFile?0o600:0o644});
    if(overwrite)await rename(temporary,file);
    else {
      // Exclusive creation also protects a file created after the preflight check.
      const {link}=await import('node:fs/promises');
      await link(temporary,file);
    }
  }finally{await rm(temporary,{force:true}).catch(()=>{});}
}
function insecureCredential() {
  return new CliError('INSECURE_CREDENTIAL_STORAGE','登录配置必须由当前用户拥有，目录权限应为 0700、凭据文件权限应为 0600，且不能使用符号链接。请修复权限；如怀疑泄漏，重新登录后运行 melonbuild logout --all。');
}
function ownedByCurrentUser(details) {
  return process.platform==='win32'||typeof process.getuid!=='function'||details.uid===process.getuid();
}
async function checkDirectory(directory,strict=true) {
  const details=await lstat(directory);
  if(details.isSymbolicLink()||!details.isDirectory()||!ownedByCurrentUser(details))throw insecureCredential();
  if(strict&&process.platform!=='win32'&&(details.mode&0o077)!==0)throw insecureCredential();
}
export async function loadCredential(directory) {
  let handle;
  try {
    await checkDirectory(directory);
    const file=join(directory,'credential.json'),entry=await lstat(file);
    if(entry.isSymbolicLink())throw insecureCredential();
    handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    const details=await handle.stat();
    if(!details.isFile()||!ownedByCurrentUser(details)||details.size>16384||
       process.platform!=='win32'&&(details.mode&0o077)!==0)throw insecureCredential();
    return JSON.parse(await handle.readFile('utf8'));
  }catch(e){
    if(e.code==='ENOENT')return null;
    if(e instanceof CliError)throw e;
    if(e.code==='ELOOP')throw insecureCredential();
    throw new Error('登录配置无法读取，请运行 melonbuild login。');
  }finally{await handle?.close();}
}
export async function saveCredential(directory,credential) {
  await mkdir(directory,{recursive:true,mode:0o700});
  await checkDirectory(directory,false);
  if(process.platform!=='win32')await chmod(directory,0o700);
  await atomicWrite(join(directory,'credential.json'),JSON.stringify(credential)+'\n',{overwrite:true,privateFile:true});
}
export async function clearCredential(directory){await rm(join(directory,'credential.json'),{force:true});}
export async function preflight(file,overwrite=false) {
  const existing=await lstat(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(existing&&(!overwrite||!existing.isFile()||existing.isSymbolicLink()))throw new Error('输出文件已存在或不可写：'+file+'。覆盖普通文件请使用 --overwrite。');
  await mkdir(dirname(file),{recursive:true});
  const probe=join(dirname(file),'.melonbuild-write-'+randomUUID());
  try{await writeFile(probe,'',{flag:'wx',mode:0o600});}finally{await rm(probe,{force:true});}
}

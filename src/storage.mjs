import {mkdir,writeFile,readFile,rename,rm,lstat,chmod} from 'node:fs/promises';
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
export async function loadCredential(directory) {
  try {return JSON.parse(await readFile(join(directory,'credential.json'),'utf8'));}
  catch(e){if(e.code==='ENOENT')return null;throw new Error('登录配置无法读取，请运行 melonbuild login。');}
}
export async function saveCredential(directory,credential) {
  await mkdir(directory,{recursive:true,mode:0o700});
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

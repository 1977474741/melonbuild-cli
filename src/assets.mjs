import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rm,lstat} from 'node:fs/promises';
import {resolve,relative,dirname,join,sep} from 'node:path';
import {atomicWrite} from './storage.mjs';
import {CliError,readBounded} from './api.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function assetUrl(value) {
  let url;try{url=new URL(value);}catch{throw new CliError('INVALID_IMAGE_URL','AST 图片链接无效。');}
  const host=url.hostname;
  const allowed=host==='figma.com'||host.endsWith('.figma.com')||host.endsWith('.figmausercontent.com')||
    /^figma-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/.test(host);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed)
    throw new CliError('UNSUPPORTED_IMAGE_HOST','仅支持 HTTPS 的 Figma 图片地址：'+host);
  return url;
}
// Track image parameters through nested templates, so a text parameter containing a URL
// is never downloaded or changed merely because an image uses the same URL.
function mapImages(ast,mapSource) {
  const parameters=new Map(Object.keys(ast.templates??{}).map(name=>[name,new Set()]));
  function imageParams(value,out) {
    if(value&&typeof value==='object') {
      if(typeof value.$param==='string')out.add(value.$param);
      else if(Array.isArray(value))value.forEach(v=>imageParams(v,out));
    }
  }
  function discover(value,out) {
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(v=>discover(v,out));return;}
    for(const [key,v] of Object.entries(value)) {
      if(key==='src'||key==='backgroundImage')imageParams(v,out);
      if(key==='args'&&value.t)for(const name of parameters.get(value.t)??[])imageParams(v?.[name],out);
      if(!['text','name','label'].includes(key))discover(v,out);
    }
  }
  let changed=true;
  while(changed) {
    changed=false;
    for(const [name,template] of Object.entries(ast.templates??{})) {
      const marked=parameters.get(name),before=marked.size;discover(template.body,marked);if(marked.size!==before)changed=true;
    }
  }
  function source(value) {
    if(typeof value!=='string')return value;
    if(/^https?:\/\//.test(value))return mapSource(value);
    return css(value);
  }
  function css(value) {
    return value.replace(/url\(\s*['"]?(https?:\/\/[^\s)'"<>]+)['"]?\s*\)/g,(whole,url)=>{
      const replaced=mapSource(url);return replaced===url?whole:'url('+JSON.stringify(replaced)+')';
    });
  }
  function walk(value,key='') {
    if(['text','name','label','fileKey'].includes(key))return value;
    if(typeof value==='string')return key==='src'?source(value):css(value);
    if(Array.isArray(value))return value.map(v=>walk(v,key));
    if(!value||typeof value!=='object')return value;
    const result={};
    for(const [k,v] of Object.entries(value)) {
      if(k==='args'&&value.t&&v&&typeof v==='object') {
        const names=parameters.get(value.t)??new Set();
        result[k]=Object.fromEntries(Object.entries(v).map(([n,item])=>[n,names.has(n)?source(item):walk(item,n)]));
      }else result[k]=walk(v,k);
    }
    return result;
  }
  const result=walk(ast);
  for(const [name,template] of Object.entries(ast.templates??{})) {
    for(const field of ['params'])if(template[field])for(const key of parameters.get(name)??[])
      if(Object.hasOwn(template[field],key))result.templates[name][field][key]=source(template[field][key]);
    for(const [variant,values] of Object.entries(template.variants??{}))for(const key of parameters.get(name)??[])
      if(Object.hasOwn(values,key))result.templates[name].variants[variant][key]=source(values[key]);
  }
  return result;
}
export function imageLinks(ast) {
  const links=new Set();mapImages(ast,url=>{assetUrl(url);links.add(url);return url;});return [...links];
}
export function replaceLinks(ast,replacements) {
  return mapImages(ast,url=>replacements.get(url)??url);
}
const extensions={'image/svg+xml':'svg','image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/bmp':'bmp','image/x-icon':'ico','application/pdf':'pdf'};
async function download(url,{fetchImpl,signal,maxImageBytes}) {
  let current=assetUrl(url);
  for(let redirects=0;redirects<=5;redirects++) {
    const response=await fetchImpl(current,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel();
      const location=response.headers.get('location');if(!location)throw new CliError('IMAGE_REDIRECT','图片重定向缺少目标地址。');
      current=assetUrl(new URL(location,current).href);continue;
    }
    if(!response.ok){await response.body?.cancel();throw new CliError(response.status===403?'IMAGE_URL_EXPIRED':'IMAGE_DOWNLOAD_FAILED','图片下载失败，HTTP '+response.status,{status:response.status});}
    const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const extension=extensions[type];
    if(!extension){await response.body?.cancel();throw new CliError('INVALID_IMAGE_TYPE','图片返回了不支持的文件类型。');}
    const data=await readBounded(response,maxImageBytes);
    if(!data.length)throw new CliError('EMPTY_IMAGE','图片内容为空。');
    return {data,extension};
  }
  throw new CliError('IMAGE_REDIRECT','图片重定向次数过多。');
}
export async function localizeImages(ast,{imageDir,output,manifestPath,fetchImpl=fetch,signal,onProgress=()=>{},maxImageBytes=64*1024*1024,maxTotalBytes=512*1024*1024}) {
  const directory=resolve(imageDir),base=output?dirname(resolve(output)):process.cwd();
  await mkdir(directory,{recursive:true});
  manifestPath??=join(directory,'.melonbuild-assets.json');
  let previous={};try{previous=JSON.parse(await readFile(manifestPath,'utf8')).assets??{};}catch{}
  const urls=imageLinks(ast),assets={},failed=[],replacements=new Map();let cursor=0,totalBytes=0;
  const worker=async()=>{
    while(cursor<urls.length) {
      if(signal?.aborted)throw new CliError('CANCELED','图片下载已取消。');
      const url=urls[cursor++],id=digest(url);
      try {
        let file,checksum,bytes,restored=false;
        const cached=previous[id];
        if(cached&&cached.file?.startsWith(id+'.')&&/^[a-f0-9]{64}\.(svg|png|jpg|gif|webp|avif|bmp|ico|pdf)$/.test(cached.file)) {
          file=join(directory,cached.file);
          const stat=await lstat(file).catch(()=>null);
          if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size<=maxImageBytes) {
            const data=await readFile(file);
            if(digest(data)===cached.sha256){checksum=cached.sha256;bytes=data.length;restored=true;}
          }
        }
        if(!restored) {
          let result;
          for(let attempt=0;attempt<3;attempt++) {
            try{result=await download(url,{fetchImpl,signal,maxImageBytes});break;}
            catch(e){if(signal?.aborted||e instanceof CliError&&!(e.status>=500)||attempt===2)throw e;}
          }
          bytes=result.data.length;checksum=digest(result.data);file=join(directory,id+'.'+result.extension);
          if(totalBytes+bytes>maxTotalBytes)throw new CliError('IMAGE_TOTAL_TOO_LARGE','图片总体积超过本次下载上限。');
          const existing=await lstat(file).catch(()=>null);
          if(existing) {
            if(!existing.isFile()||existing.isSymbolicLink()||existing.size>maxImageBytes||digest(await readFile(file))!==checksum)
              throw new CliError('IMAGE_FILE_CONFLICT','图片文件已存在且内容不一致：'+file);
          }else await atomicWrite(file,result.data);
        }
        totalBytes+=bytes;
        if(totalBytes>maxTotalBytes)throw new CliError('IMAGE_TOTAL_TOO_LARGE','图片总体积超过本次下载上限。');
        const filename=file.split(sep).pop();
        assets[id]={url,file:filename,sha256:checksum,bytes};
        const local=relative(base,file).split(sep).join('/');
        replacements.set(url,local.startsWith('.')?local:'./'+local);
        onProgress({ok:true,restored,file,total:urls.length});
      }catch(e){if(signal?.aborted)throw new CliError('CANCELED','图片下载已取消。');failed.push({url,code:e.code||'IMAGE_DOWNLOAD_FAILED',message:e instanceof CliError?e.message:'图片下载失败，请检查网络后重试。'});onProgress({ok:false,total:urls.length});}
    }
  };
  try{const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,urls.length)},worker));const rejected=outcomes.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;}
  finally{await atomicWrite(manifestPath,JSON.stringify({version:1,assets:{...previous,...assets},failed},null,2)+'\n',{overwrite:true,privateFile:true});}
  return {ast:replaceLinks(ast,replacements),total:urls.length,downloaded:replacements.size,failed,manifestPath};
}

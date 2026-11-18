import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rm,lstat} from 'node:fs/promises';
import {resolve,relative,dirname,join,sep} from 'node:path';
import {atomicWrite} from './storage.mjs';
import {CliError,readBounded} from './api.mjs';
import {createPngOptimizer} from './png.mjs';
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
const mediaTypes=Object.fromEntries(Object.entries(extensions).map(([type,extension])=>[extension,type]));
// Figma's SVG export sometimes leaves a <g> unclosed; browsers then refuse to draw the whole image.
// Close what is still open right before the tag that ends it, so the drawing order is unchanged.
export function repairSvg(text) {
  const open=[];let out='',last=0,changed=false;
  for(const m of text.matchAll(/<(\/?)([a-zA-Z][\w:.-]*)(?:\s[^>]*?)?(\/?)>/g)) {
    if(m[3])continue;
    if(!m[1]){open.push(m[2]);continue;}
    if(!open.includes(m[2]))continue;
    let close='';while(open.length&&open.at(-1)!==m[2]){close+='</'+open.pop()+'>';changed=true;}
    open.pop();out+=text.slice(last,m.index)+close;last=m.index;
  }
  return changed?out+text.slice(last):text;
}
// Readable, stable file names: the Figma layer that shows the image, plus part of the URL digest.
const GENERIC=/^(Frame|Group|Rectangle|Vector|Ellipse|Line|Union|Subtract|image|Mask group|形状|形状结合|蒙版|编组|路径|矩形|椭圆)[\s\d]*$/i;
export function slugName(name) {
  const parts=String(name??'').split('/').map(part=>part.trim()).filter(Boolean);
  for(const part of [parts.at(-1),...parts.slice(0,-1).reverse()]) {
    const clean=(part??'').toLowerCase().replace(/\b(frame|group|vector|rectangle|union|subtract|mask|layer)\b/g,' ').replace(/\b\d+\b/g,' ');
    const ascii=clean.replace(/[^a-z0-9]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(ascii.length>=2)return ascii.slice(0,40);
    const cjk=clean.replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^[-\d]+|-+$/g,'');if(/[\u4e00-\u9fff]/.test(cjk))return cjk.slice(0,24);
  }
  return 'image';
}
export function imageNames(ast) {
  const names=new Map(),templates=ast.templates??{},styles=ast.globalStyles??{};
  const label=chain=>{for(let i=chain.length-1;i>=0&&i>=chain.length-6;i--){const n=chain[i]?.name;if(typeof n==='string'&&n&&!GENERIC.test(n))return n;}return chain.at(-1)?.name;};
  const note=(value,name)=>{if(typeof value==='string'&&/^https?:\/\//.test(value)&&name&&!names.has(value))names.set(value,name);};
  const paramNames={},styleOwner={};
  (function bodies(){for(const [t,def] of Object.entries(templates))(function walk(node,chain){
    if(!node||typeof node!=='object')return;const next=[...chain,node];
    for(const [k,v] of Object.entries(node))if(v&&typeof v==='object'&&typeof v.$param==='string'&&(k==='src'||k==='fills'||k==='maskFills'))(paramNames[t]??={})[v.$param]=label(next);
    (node.children??[]).forEach(c=>walk(c,next));
  })(def.body,[]);})();
  const visit=(node,chain)=>{
    if(!node||typeof node!=='object')return;const next=[...chain,node];
    if(typeof node.t==='string'){const pn=paramNames[node.t]??{},t=templates[node.t]??{};
      for(const src of [node.args??{},t.params??{},...Object.values(t.variants??{})])for(const [k,v] of Object.entries(src)){
        if(pn[k]){note(v,pn[k]);if(typeof v==='string'&&v in styles)styleOwner[v]??=pn[k];}}
      (node.children??[]).forEach(c=>visit(c,next));return;}
    note(node.src,label(next));
    for(const k of ['fills','maskFills'])if(typeof node[k]==='string')styleOwner[node[k]]??=label(next)+(k==='maskFills'?' mask':'');
    (node.children??[]).forEach(c=>visit(c,next));
  };
  (ast.nodes??[]).forEach(n=>visit(n,[]));for(const def of Object.values(templates))visit(def.body,[]);
  for(const [key,value] of Object.entries(styles))for(const m of JSON.stringify(value).matchAll(/url\(\\?"?(https?:\/\/[^)"\\]+)/g))note(m[1],styleOwner[key]??'image');
  return names;
}
function fileName(name,id,extension) {
  const slug=slugName(name),photo=extension!=='svg';
  const base=photo||/icon|logo/.test(slug)?slug:'icon-'+slug;
  return base+'-'+id.slice(0,8)+'.'+extension;
}
function resourceInfo(data,extension) {
  // Inspect locally without copying the SVG (and its encoded pixels) into the AST or manifest.
  return {mediaType:mediaTypes[extension],...(extension==='svg'?{
    containsEmbeddedImages:/\b(?:xlink:)?href\s*=\s*["']\s*data:image\//i.test(data.toString('utf8')),
  }:{})};
}
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
  const png=createPngOptimizer(),urls=imageLinks(ast),names=imageNames(ast),assets={},failed=[],replacements=new Map(),written=new Set();let cursor=0,totalBytes=0;
  const worker=async()=>{
    while(cursor<urls.length) {
      if(signal?.aborted)throw new CliError('CANCELED','图片下载已取消。');
      const url=urls[cursor++],id=digest(url);
      try {
        let file,checksum,bytes,info,restored=false;
        const cached=previous[id];
        if(cached&&/^[^/\\]{1,120}\.(svg|png|jpg|gif|webp|avif|bmp|ico|pdf)$/.test(cached.file??'')&&!cached.file.startsWith('.')) {
          file=join(directory,cached.file);
          const stat=await lstat(file).catch(()=>null);
          if(stat?.isFile()&&!stat.isSymbolicLink()&&stat.size<=maxImageBytes) {
            const data=await readFile(file);
            if(digest(data)===cached.sha256){checksum=cached.sha256;bytes=data.length;info=resourceInfo(data,cached.file.split('.').pop());restored=true;}
          }
        }
        if(!restored) {
          let result;
          for(let attempt=0;attempt<3;attempt++) {
            try{result=await download(url,{fetchImpl,signal,maxImageBytes});break;}
            catch(e){if(signal?.aborted||e instanceof CliError&&!(e.status>=500)||attempt===2)throw e;}
          }
          if(result.extension==='svg') {
            const text=result.data.toString('utf8'),fixed=repairSvg(text);
            if(fixed!==text){result.data=Buffer.from(fixed,'utf8');result.repaired=true;}
          }
          // PNG 做无损压缩：格式不变、逐像素一致
          if(result.extension==='png')result.data=await png.optimize(result.data);
          bytes=result.data.length;checksum=digest(result.data);
          file=join(directory,fileName(names.get(url),id,result.extension));
          info={...resourceInfo(result.data,result.extension),...(result.repaired?{repairedSvg:true}:{})};
          if(totalBytes+bytes>maxTotalBytes)throw new CliError('IMAGE_TOTAL_TOO_LARGE','图片总体积超过本次下载上限。');
          const existing=await lstat(file).catch(()=>null);
          if(existing) {
            if(!existing.isFile()||existing.isSymbolicLink()||existing.size>maxImageBytes||digest(await readFile(file))!==checksum)
              throw new CliError('IMAGE_FILE_CONFLICT','图片文件已存在且内容不一致：'+file);
          }else {await atomicWrite(file,result.data);written.add(file);}
        }
        totalBytes+=bytes;
        if(totalBytes>maxTotalBytes)throw new CliError('IMAGE_TOTAL_TOO_LARGE','图片总体积超过本次下载上限。');
        const filename=file.split(sep).pop();
        assets[id]={url,file:filename,sha256:checksum,bytes,...info};
        const local=relative(base,file).split(sep).join('/');
        replacements.set(url,local.startsWith('.')?local:'./'+local);
        onProgress({ok:true,restored,file,total:urls.length});
      }catch(e){if(signal?.aborted)throw new CliError('CANCELED','图片下载已取消。');failed.push({url,code:e.code||'IMAGE_DOWNLOAD_FAILED',message:e instanceof CliError?e.message:'图片下载失败，请检查网络后重试。'});onProgress({ok:false,total:urls.length});}
    }
  };
  try{
    const outcomes=await Promise.allSettled(Array.from({length:Math.min(4,urls.length)},worker));const rejected=outcomes.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
    // 内容完全相同的图片（不同节点导出了同一张图）只留一份：按链接顺序取第一个，删掉本次多写的副本
    const keep=new Map();
    for(const url of urls) {
      const id=digest(url),entry=assets[id];if(!entry)continue;
      const first=keep.get(entry.sha256);
      if(!first){keep.set(entry.sha256,{file:entry.file,local:replacements.get(url)});continue;}
      if(first.file===entry.file)continue;
      const duplicate=join(directory,entry.file);
      if(written.has(duplicate))await rm(duplicate,{force:true});
      assets[id]={...entry,file:first.file};replacements.set(url,first.local);
    }
  }
  finally{await png.close();await atomicWrite(manifestPath,JSON.stringify({version:1,assets:{...previous,...assets},failed},null,2)+'\n',{overwrite:true,privateFile:true});}
  return {ast:replaceLinks(ast,replacements),total:urls.length,downloaded:replacements.size,failed,manifestPath,assets};
}

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
    const local=first.ast.nodes[0].src;assert.match(local,/^\.\/images\/icon-image-[a-f0-9]{8}\.svg$/);
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
test('embedded SVG pixels stay in the asset; compact metadata is available before reading it, including on resume',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-embedded-svg-'));
  const encoded='AAAA'.repeat(256*1024);
  const mixed='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,'+encoded+'"/></svg>';
  const document=ast(),original=JSON.stringify(document);
  try {
    const options={imageDir:join(directory,'images'),output:join(directory,'ast.json'),fetchImpl:async()=>new Response(mixed,{headers:{'content-type':'image/svg+xml'}})};
    const result=await localizeImages(document,options);
    assert.equal(result.failed.length,0);assert.equal(JSON.stringify(document),original);
    const entry=Object.values(result.assets)[0];
    assert.equal(entry.mediaType,'image/svg+xml');assert.equal(entry.bytes,Buffer.byteLength(mixed));assert.equal(entry.containsEmbeddedImages,true);
    assert.equal(await readFile(join(directory,'images',entry.file),'utf8'),mixed);
    assert.ok(JSON.stringify(result.ast).length<2000);assert.ok(!JSON.stringify(result.ast).includes('data:image'));
    const manifest=JSON.parse(await readFile(result.manifestPath,'utf8'));
    assert.ok(JSON.stringify(manifest).length<2000);assert.ok(!JSON.stringify(manifest).includes(encoded));
    // Existing manifests without resource metadata are upgraded from the verified local bytes.
    for(const value of Object.values(manifest.assets)){delete value.mediaType;delete value.containsEmbeddedImages;}
    await writeFile(result.manifestPath,JSON.stringify(manifest));
    const resumed=await localizeImages(document,{...options,fetchImpl:async()=>{throw new Error('No network expected');}});
    assert.equal(resumed.failed.length,0);assert.equal(Object.values(resumed.assets)[0].containsEmbeddedImages,true);
    assert.equal(Object.values(JSON.parse(await readFile(result.manifestPath,'utf8')).assets)[0].mediaType,'image/svg+xml');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('resource metadata distinguishes vector-only SVGs, href embedded images and raster assets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-resource-types-'));
  const cases=[
    ['vector',svg,'image/svg+xml',false],
    ['embedded','<svg><image href = \'data:image/jpeg;base64,AAAA\'/></svg>','image/svg+xml',true],
    ['raster','PNG fixture','image/png',undefined],
  ];
  const document={nodes:cases.map(([name])=>({tag:'img',src:'https://s3-alpha.figma.com/'+name})),templates:{}};
  try {
    const result=await localizeImages(document,{imageDir:directory,fetchImpl:async input=>{
      const entry=cases.find(([name])=>String(input).endsWith('/'+name));
      return new Response(entry[1],{headers:{'content-type':entry[2]}});
    }});
    assert.equal(result.failed.length,0);
    for(const [name,body,type,embedded] of cases){
      const entry=Object.values(result.assets).find(asset=>asset.url.endsWith('/'+name));
      assert.equal(entry.mediaType,type);assert.equal(entry.bytes,Buffer.byteLength(body));assert.equal(entry.containsEmbeddedImages,embedded);
    }
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

test('files are named after their Figma layers, identical images are stored once, broken SVG tags are closed',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'melonbuild-names-'));
 const a='https://s3-alpha.figma.com/a',b='https://s3-alpha.figma.com/b',photo='https://s3-alpha.figma.com/photo',broken='https://s3-alpha.figma.com/broken';
 const brokenSvg='<svg xmlns="http://www.w3.org/2000/svg"><mask id="m"><rect width="1" height="1"/></mask><g mask="url(#m)"><rect width="1" height="1"/><defs><linearGradient id="g"/></defs></svg>';
 const document={nodes:[{tag:'FRAME',name:'Toolbar',children:[
   {tag:'IMAGE-SVG',name:'Vector',src:a},          // 自动名：向上取祖先的名字
   {tag:'IMAGE-SVG',name:'1-Close 关闭 X',src:b},
   {tag:'IMAGE-SVG',name:'活动封面',src:photo},
   {tag:'IMAGE-SVG',name:'Rectangle 53',src:broken},
 ]}],templates:{}};
 const bodies={[a]:svg,[b]:svg,[photo]:'PNG fixture',[broken]:brokenSvg};
 const types={[photo]:'image/png'};
 try {
  const result=await localizeImages(document,{imageDir:join(directory,'images'),output:join(directory,'ast.json'),
    fetchImpl:async input=>new Response(bodies[String(input)],{headers:{'content-type':types[String(input)]??'image/svg+xml'}})});
  const [toolbar,close,cover,fixed]=result.ast.nodes[0].children.map(child=>child.src);
  assert.match(toolbar,/\/icon-toolbar-[a-f0-9]{8}\.svg$/);
  assert.equal(close,toolbar,'内容完全相同的两张图共用一个文件');
  assert.match(cover,/\/活动封面-[a-f0-9]{8}\.png$/);
  assert.match(fixed,/\/icon-toolbar-[a-f0-9]{8}\.svg$/);
  const repaired=await readFile(join(directory,fixed),'utf8');
  assert.match(repaired,/<\/g><\/svg>$/);
  assert.equal(Object.values(result.assets).find(entry=>entry.url===broken).repairedSvg,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('PNG 下载后做无损压缩：格式不变、体积变小；不是合法 PNG 时原样保存',async()=>{
  const {deflateSync,crc32}=await import('node:zlib');
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body));return Buffer.concat([len,body,crc]);};
  const w=64,h=64,raw=Buffer.alloc((w*4+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=y*(w*4+1)+1+x*4;raw[o]=x*4;raw[o+1]=y*4;raw[o+2]=128;raw[o+3]=255;}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:0})),chunk('IEND',Buffer.alloc(0))]);
  const photo='https://s3-alpha.figma.com/photo.png';
  const directory=await mkdtemp(join(tmpdir(),'melonbuild-png-'));
  try {
    const result=await localizeImages({nodes:[{tag:'img',src:photo}]},{imageDir:directory,fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
    const entry=Object.values(result.assets)[0],saved=await readFile(join(directory,entry.file));
    assert.match(entry.file,/\.png$/);
    assert.ok(saved.subarray(0,8).equals(png.subarray(0,8)));
    assert.ok(saved.length<png.length/2,`压缩后 ${saved.length} 字节，原图 ${png.length}`);
    assert.equal(entry.bytes,saved.length);
  }finally{await rm(directory,{recursive:true,force:true});}
});

#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {CliError,createApi,apiOrigin,DEFAULT_ORIGIN} from './api.mjs';
import {configDirectory,loadCredential,saveCredential,clearCredential,atomicWrite,preflight} from './storage.mjs';
import {localizeImages,imageLinks} from './assets.mjs';
const version=typeof MELONBUILD_VERSION==='undefined'?'0.1.0-dev':MELONBUILD_VERSION;
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
let machine=false;
const help=`MelonBuild CLI ${version}

用法：
  melonbuild login [--no-browser]
  melonbuild whoami [--json]
  melonbuild logout [--all]
  melonbuild node-ast <Figma链接> --output ast.json --image-dir ./public/images
  melonbuild node-ast <fileKey> <nodeId> [选项]
  melonbuild node-summary <Figma链接> --output summary.json
  melonbuild download-images <ast.remote.json> --image-dir ./images --output ast.json

选项：
  -o, --output <file>          保存结果；省略时正文写 stdout
  --format json               固定保存紧凑 JSON（可省略）
  --image-dir <directory>     在本机下载 AST 引用的图片并改写路径
  --image-local-path <dir>    --image-dir 的别名
  --image-source remote|local 未指定目录时默认保留远端链接
  --reuse exact|none|params|slots|components
  --reuse-meta --with-ids --no-styles
  --force-refresh            重新生成；试用期间成功后扣一次
  --overwrite                允许覆盖指定输出文件
  --json                     账号信息/错误使用 JSON
  --no-browser               登录时手动打开授权链接
  --version, --help

免费试用：与网站共用累计 10 次，每次完整 AST 最多 100 KB。
10 次用完后，仍可免费获取不超过 30 KB 的完整 AST（紧凑 JSON，含图片链接）。
图片二进制由本机下载，不计入 AST 大小。
有效服务端结果缓存命中不扣次数；补下载图片不调用 AST 接口。
订阅：${DEFAULT_ORIGIN}/subscribe
`;
function openBrowser(url) {
  const command=process.platform==='darwin'?['open',[url]]:process.platform==='win32'?['rundll32.exe',['url.dll,FileProtocolHandler',url]]:['xdg-open',[url]];
  const child=spawn(command[0],command[1],{stdio:'ignore',detached:true});
  child.on('error',()=>console.error('无法自动打开浏览器，请手动打开上方链接。'));child.unref();
}
function target(positionals) {
  if(positionals.length===1&&positionals[0].startsWith('https://')) {
    const url=new URL(positionals[0]);
    if(url.protocol!=='https:'||!['www.figma.com','figma.com'].includes(url.hostname)||url.port||url.username||url.password||
      !/^\/(design|file|proto)\/[a-zA-Z0-9]{5,128}(\/[^/]*)?\/?$/.test(url.pathname)||url.searchParams.getAll('node-id').length!==1||!/^\d{1,20}[:-]\d{1,20}$/.test(url.searchParams.get('node-id')||''))
      throw new CliError('INVALID_URL','请提供包含单个 node-id 的 Figma 设计链接；该目标可包含多个页面。');
    return url.href;
  }
  if(positionals.length===2&&/^[a-zA-Z0-9]{5,128}$/.test(positionals[0])&&/^\d{1,20}[:-]\d{1,20}$/.test(positionals[1]))
    return 'https://www.figma.com/design/'+positionals[0]+'?node-id='+positionals[1].replace(':','-');
  throw new CliError('INVALID_TARGET','请提供 Figma 链接，或 fileKey 和 nodeId。');
}
function validateAst(ast) {
  if(!ast||typeof ast!=='object'||!Array.isArray(ast.nodes)||!ast.templates||typeof ast.templates!=='object'||Array.isArray(ast.templates))
    throw new CliError('INVALID_AST','需要完整的 MelonBuild JSON AST（包含 nodes 和 templates）。');
  return ast;
}
async function main() {
  const {values:flags,positionals}=parseArgs({allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},json:{type:'boolean'},output:{type:'string',short:'o'},format:{type:'string'},
    'image-dir':{type:'string'},'image-local-path':{type:'string'},'image-source':{type:'string'},reuse:{type:'string'},'reuse-meta':{type:'boolean'},
    'with-ids':{type:'boolean'},'no-styles':{type:'boolean'},'force-refresh':{type:'boolean'},overwrite:{type:'boolean'},'no-browser':{type:'boolean'},all:{type:'boolean'},dev:{type:'boolean'},
  }});
  machine=!!flags.json;
  if(flags.version){console.log(version);return;}
  const command=positionals.shift();if(flags.help||!command){console.log(help);return;}
  if(!['login','logout','whoami','status','node-ast','node-summary','download-images'].includes(command))throw new CliError('UNKNOWN_COMMAND','未知命令：'+command+'。使用 --help 查看帮助。');
  if(flags.all&&command!=='logout')throw new CliError('INVALID_OPTIONS','--all 仅用于 logout。');
  const output=flags.output?resolve(flags.output):undefined,format=flags.format??'json';
  const imageDir=flags['image-dir']??flags['image-local-path'];
  if(flags['image-dir']&&flags['image-local-path']&&resolve(flags['image-dir'])!==resolve(flags['image-local-path']))throw new CliError('INVALID_OPTIONS','图片目录参数不一致。');
  if(format!=='json')throw new CliError('INVALID_FORMAT','对外 CLI 固定输出紧凑 JSON。');
  if(command==='node-summary'&&(format!=='json'||imageDir))throw new CliError('INVALID_OPTIONS','摘要输出 JSON，图片请通过 node-ast 获取。');
  if(flags.reuse&&!['none','exact','params','slots','components'].includes(flags.reuse))throw new CliError('INVALID_REUSE','不支持该复用模式。');
  if(flags['image-source']&&!['remote','local'].includes(flags['image-source']))throw new CliError('INVALID_OPTIONS','--image-source 支持 remote 或 local。');
  if(flags['image-source']==='local'&&!imageDir)throw new CliError('IMAGE_DIR_REQUIRED','本地图片需要指定 --image-dir。');
  if(flags['image-source']==='remote'&&imageDir)throw new CliError('INVALID_OPTIONS','已指定下载目录，请移除 --image-source remote。');
  if(['node-ast','node-summary','download-images'].includes(command)&&output)await preflight(output,flags.overwrite);
  const directory=flags.dev?join(configDirectory(),'dev'):configDirectory();
  if(command==='download-images') {
    if(positionals.length!==1||!imageDir)throw new CliError('INVALID_OPTIONS','用法：download-images <ast.remote.json> --image-dir <目录> [--output <文件>]。');
    const source=resolve(positionals[0]);
    if(source===output)throw new CliError('INVALID_OPTIONS','请使用不同的输出路径，保留远端 JSON 供后续重试。');
    const ast=validateAst(JSON.parse(await readFile(source,'utf8')));
    await writeAst(ast,{output,format,imageDir,overwrite:flags.overwrite,source});return;
  }
  const saved=command==='login'?null:await loadCredential(directory),origin=apiOrigin(process.env.MELONBUILD_API_URL??saved?.origin??DEFAULT_ORIGIN);
  if(command==='login') {
    if(positionals.length)throw new CliError('INVALID_OPTIONS','login 不接受位置参数。');
    const api=createApi(origin,{signal:controller.signal});
    const codeVerifier=randomBytes(32).toString('base64url'),codeChallenge=createHash('sha256').update(codeVerifier).digest('base64url');
    const pending=await api('/api/cli/auth/start',{codeChallenge},{timeoutMs:30000});
    const verification=new URL(pending.verificationUri);
    if(verification.origin!==origin||verification.pathname!=='/api/cli/authorize'||!/^[A-F0-9]{10}$/.test(pending.userCode)||!/^[A-Za-z0-9_-]{43}$/.test(pending.deviceCode))throw new CliError('INVALID_RESPONSE','服务返回的登录信息无效。');
    verification.hash=new URLSearchParams({code:pending.userCode,...(flags.dev?{clientMode:'dev'}:{})}).toString();
    console.error('请打开：'+verification.href+'\n终端登录码：'+pending.userCode+'\n核对浏览器登录码后确认。');
    if(!flags['no-browser'])openBrowser(verification.href);
    const deadline=Date.now()+Math.min(600,Number(pending.expiresIn)||600)*1000;let interval=5;
    while(Date.now()<deadline) {
      await delay(interval*1000,undefined,{signal:controller.signal});
      let result;
      try{result=await api('/api/cli/auth/token',{deviceCode:pending.deviceCode,codeVerifier},{timeoutMs:30000});}
      catch(e){if(e.code==='NETWORK_ERROR'){console.error('连接中断，继续等待登录结果……');continue;}throw e;}
      if(result.status==='pending'||result.status==='slow_down'){interval=Math.max(5,Math.min(30,Number(result.interval)||5));continue;}
      if(result.status!=='approved'||!/^mb_cli_[A-Za-z0-9_-]{43}$/.test(result.token))throw new CliError('INVALID_RESPONSE','登录结果无效。');
      await saveCredential(directory,{origin,token:result.token,expiresAt:result.expiresAt});
      console.error('登录成功。运行 melonbuild whoami 查看账号和剩余次数。');return;
    }
    throw new CliError('CLI_LOGIN_EXPIRED','登录等待已超时，请重新运行 melonbuild login。');
  }
  if(saved&&saved.origin!==origin)throw new CliError('API_ORIGIN_MISMATCH','当前登录属于其他服务地址，请先使用新地址运行 melonbuild login。');
  if(command==='logout'&&!saved){if(flags.all)throw new CliError('CLI_LOGIN_REQUIRED','撤销全部 CLI 凭据需要先运行 melonbuild login。');console.error('当前未登录。');return;}
  if(command!=='logout'&&(!saved||!/^mb_cli_[A-Za-z0-9_-]{43}$/.test(saved.token)||!Number.isFinite(Date.parse(saved.expiresAt))||Date.parse(saved.expiresAt)<=Date.now()))throw new CliError('CLI_LOGIN_REQUIRED','请先运行 melonbuild login。');
  const api=createApi(origin,{token:saved.token,signal:controller.signal});
  if(command==='logout') {
    try{await api('/api/cli/v1/logout',flags.all?{all:true}:{});}catch(e){if(flags.all||e.code!=='CLI_LOGIN_REQUIRED')throw e;}
    await clearCredential(directory);console.error(flags.all?'已退出，当前账号的全部 CLI 登录凭据已撤销。':'已退出，此设备的登录凭据已撤销。');return;
  }
  if(['whoami','status'].includes(command)) {
    const data=await api('/api/cli/v1/account');
    if(machine)console.log(JSON.stringify(data));
    else console.log('账号：'+(data.actor.displayName||data.actor.userId)+'\n权限：'+data.actor.tier+'\n'+(data.freeQuota?'累计免费次数：'+data.freeQuota.remaining+' / '+data.freeQuota.limit+'\n'+(data.freeQuota.remaining>0?'试用期间完整 AST 上限：100 KB':'试用已用完，仍可免费获取不超过 30 KB 的完整 AST'):'会员账号')+'\n订阅：'+data.subscriptionUrl);
    return;
  }
  const url=target(positionals);
  const body={url,outputs:[command==='node-ast'?'ast':'summary'],format:'json',...(flags.dev?{clientMode:'dev'}:{}),...(flags['force-refresh']?{forceRefresh:true}:{})};
  if(command==='node-ast')Object.assign(body,{reuse:flags.reuse??'exact',includeStyles:!flags['no-styles'],reuseMeta:!!flags['reuse-meta'],withIds:!!flags['with-ids']});
  // Check local destinations before requesting a potentially chargeable generation.
  let source;
  if(command==='node-ast'&&imageDir) {
    source=output?output+'.remote.json':join(resolve(imageDir),'melonbuild.remote.json');
    await preflight(source,flags.overwrite);await preflight(join(resolve(imageDir),'.melonbuild-write-check'),true);
  }
  console.error('正在获取'+(command==='node-ast'?' AST':'摘要')+'……');
  const result=await api('/api/cli/v1/conversions',body);
  if(command==='node-ast') {
    if(result.astVersion!=='1')throw new CliError('AST_VERSION_UNSUPPORTED','AST 格式已更新，请升级 melonbuild-cli。');
    const ast=validateAst(JSON.parse(result.ast));
    if(source)await atomicWrite(source,JSON.stringify(ast),{overwrite:!!flags.overwrite,privateFile:true});
    await writeAst(ast,{output,format,imageDir,overwrite:flags.overwrite,source});
  }else {
    if(typeof result.summary!=='string')throw new CliError('INVALID_RESPONSE','服务未返回摘要。');
    await emit(JSON.stringify(JSON.parse(result.summary)),output,flags.overwrite);
  }
  if(result.freeQuota) {
    console.error('累计免费次数剩余：'+result.freeQuota.remaining+' / '+result.freeQuota.limit);
    if(result.freeQuota.remaining===0)console.error('免费试用已用完，后续仍可免费获取不超过 30 KB 的完整 AST。');
  }
  if(result.cache?.hit)console.error('服务端结果缓存命中，本次不扣次数。');
}
async function emit(content,output,overwrite) {
  if(output){await atomicWrite(output,content,{overwrite:!!overwrite});console.error('已保存：'+output);}
  else await new Promise((resolve,reject)=>process.stdout.write(content,e=>e?reject(e):resolve()));
}
async function writeAst(ast,{output,format,imageDir,overwrite,source}) {
  let local;
  if(imageDir) {
    console.error('在本机下载 '+imageLinks(ast).length+' 张去重图片……');
    local=await localizeImages(ast,{imageDir,output,manifestPath:source?source+'.assets.json':undefined,signal:controller.signal,
      onProgress:info=>{if(info.ok)console.error((info.restored?'已复用：':'已下载：')+info.file);}});
    ast=local.ast;
  }
  await emit(JSON.stringify(ast),output,overwrite);
  if(local?.failed.length) {
    console.error('图片下载失败 '+local.failed.length+' 张；失败项保留远端链接。原始 AST：'+source+'\n详情：'+local.manifestPath+'\n使用 download-images 对原始 JSON 补下载，不会重新生成 AST 或扣次数。');
    process.exitCode=4;
  }
}
main().catch(error=>{
  const canceled=controller.signal.aborted;
  const code=canceled?'CANCELED':error.code||'CLI_ERROR',message=canceled?'操作已取消。':error.message;
  const details={code,message,...(error.requestId?{requestId:error.requestId}:{}),...(error.retryAfter?{retryAfter:error.retryAfter}:{}),
    ...(error.limit?{limit:error.limit}:{}),...(error.subscriptionUrl?{subscriptionUrl:error.subscriptionUrl}:['FREE_QUOTA_EXHAUSTED','FREE_AST_TOO_LARGE'].includes(code)?{subscriptionUrl:DEFAULT_ORIGIN+'/subscribe'}:{})};
  if(machine)console.error(JSON.stringify({error:details}));
  else {
    console.error('['+code+'] '+message);
    if(details.subscriptionUrl&&!message.includes(details.subscriptionUrl))console.error('订阅：'+details.subscriptionUrl);
    if(error.retryAfter)console.error('可重试时间：'+new Date(Date.now()+error.retryAfter*1000).toISOString());
    if(error.requestId)console.error('请求编号：'+error.requestId);
  }
  process.exitCode=canceled?130:['CLI_LOGIN_REQUIRED','FIGMA_REAUTH_REQUIRED'].includes(code)?2:['FREE_QUOTA_EXHAUSTED','FREE_AST_TOO_LARGE'].includes(code)?3:1;
});

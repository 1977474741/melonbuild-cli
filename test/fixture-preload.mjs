import {appendFileSync} from 'node:fs';
const remaining=process.env.CLI_TEST_AFTER_TRIAL?0:9;
const token='mb_cli_'+'a'.repeat(43),ast={name:'Fixture',fileKey:'Abc123',nodes:[{tag:'img',src:'https://s3-alpha.figma.com/icon.svg?a=1&b=2'}],templates:{}};
globalThis.fetch=async(input,options)=>{
 const url=new URL(input);if(process.env.CLI_TEST_LOG)appendFileSync(process.env.CLI_TEST_LOG,url.origin+url.pathname+'\n');
 if(url.origin==='https://s3-alpha.figma.com'){if(options.headers?.authorization)throw new Error('Credential leaked to CDN');return new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}});}
 if(url.origin!=='https://www.melonbuild.com')throw new Error('Unexpected host');
 if(url.pathname==='/api/cli/auth/start')return Response.json({deviceCode:'d'.repeat(43),userCode:'ABCD123456',verificationUri:url.origin+'/api/cli/authorize',expiresIn:600,interval:5});
 if(url.pathname==='/api/cli/auth/token')return Response.json({status:'approved',token,expiresAt:new Date(Date.now()+86400000).toISOString()});
 if(options.headers.authorization!=='Bearer '+token)throw new Error('Missing platform credential');
 if(url.pathname.endsWith('/account'))return Response.json({actor:{displayName:'Fixture User',tier:'free'},freeQuota:{remaining,limit:10},freeAstMaxBytes:remaining?100000:30000,afterTrialAstMaxBytes:30000,subscriptionUrl:url.origin+'/subscribe'});
 if(url.pathname.endsWith('/logout')){const body=JSON.parse(options.body);if(body.all!==undefined&&body.all!==true)throw new Error('Invalid revocation request');return Response.json({ok:true});}
 if(url.pathname.endsWith('/conversions')){
  if(process.env.CLI_TEST_QUOTA)return Response.json({error:{code:'FREE_QUOTA_EXHAUSTED',message:'免费次数已用完'}},{status:403});
  const body=JSON.parse(options.body);if(body.format!=='json')throw new Error('Must request compact JSON');
  return Response.json({ast:JSON.stringify(ast),astVersion:'1',astJsonBytes:Buffer.byteLength(JSON.stringify(ast)),summary:'{"nodes":[]}',freeQuota:{remaining:process.env.CLI_TEST_AFTER_TRIAL?0:8,limit:10}});
 }
 throw new Error('Unexpected path '+url.pathname);
};

export const DEFAULT_ORIGIN='https://www.melonbuild.com';
export class CliError extends Error {
  constructor(code,message,details={}){super(message);this.code=code;Object.assign(this,details);}
}
export function apiOrigin(value=DEFAULT_ORIGIN) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw new CliError('INVALID_API_URL','MELONBUILD_API_URL 必须是 HTTPS origin，不含路径或凭据。');
  return url.origin;
}
export async function readBounded(response,maxBytes=40*1024*1024) {
  const chunks=[];let bytes=0;
  if(!response.body)return Buffer.alloc(0);
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new CliError('RESPONSE_TOO_LARGE','响应超过本地读取上限。');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export function createApi(origin,{token,fetchImpl=fetch,signal}={}) {
  origin=apiOrigin(origin);
  return async function api(path,body,{timeoutMs=210000}={}) {
    const url=new URL(path,origin);
    if(url.origin!==origin||url.username||url.password)throw new CliError('API_ORIGIN_MISMATCH','拒绝向其他地址发送平台登录凭据。');
    let response;
    try {response=await fetchImpl(url,{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},
      body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});}
    catch(e){if(signal?.aborted)throw new CliError('CANCELED','操作已取消。');throw new CliError('NETWORK_ERROR','无法连接 MelonBuild，请检查网络后重试。');}
    let data;
    try{data=JSON.parse((await readBounded(response)).toString('utf8'));}catch(e){if(e instanceof CliError)throw e;throw new CliError('INVALID_RESPONSE','服务返回了无法解析的响应。');}
    if(!response.ok) {
      const retryAfter=Number(response.headers.get('retry-after'))||0;
      throw new CliError(data.error?.code||'REQUEST_FAILED',data.error?.message||'请求失败。',
        {requestId:data.requestId,retryAfter,status:response.status,subscriptionUrl:origin+'/subscribe'});
    }
    return data;
  };
}

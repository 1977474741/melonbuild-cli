// 在独立线程里做 PNG 无损优化（oxipng），不阻塞下载。
import {readFileSync,existsSync} from 'node:fs';
import {parentPort} from 'node:worker_threads';
import initCodec,{optimise} from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';
// 打包后 wasm 与本文件同目录；源码运行时从依赖里读
const bundled=new URL('./squoosh_oxipng_bg.wasm',import.meta.url);
const wasm=existsSync(bundled)?bundled:new URL('../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm',import.meta.url);
await initCodec(await WebAssembly.compile(readFileSync(wasm)));
parentPort.on('message',({id,data,level})=>{
  try{
    // interlace=false、optimize_alpha=false：不改动任何像素（包括全透明像素的颜色值）
    const out=optimise(data,level,false,false);
    parentPort.postMessage({id,data:out},[out.buffer]);
  }catch(e){parentPort.postMessage({id,error:String(e?.message??e)});}
});
parentPort.postMessage({ready:true});

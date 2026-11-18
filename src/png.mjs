import {Worker} from 'node:worker_threads';
import {availableParallelism} from 'node:os';

/** oxipng 等级：2 与最高档 6 的压缩比只差约 0.4%，速度快二十多倍 */
const LEVEL=2;

/**
 * PNG 无损压缩池：格式不变、逐像素一致，只去掉编码冗余。
 * 线程按需创建；任何失败（非法 PNG、wasm 加载失败）都返回原图，压缩只是锦上添花。
 */
export function createPngOptimizer({size=Math.min(4,availableParallelism())}={}) {
  const workers=[],idle=[],queue=[],pending=new Map();let seq=0,broken=false;
  const fail=worker=>{
    broken=true;
    for(const [id,job] of pending)if(job.worker===worker){pending.delete(id);job.resolve(job.data);}
    for(const job of queue.splice(0))job.resolve(job.data);
  };
  const spawn=()=>{
    const worker=new Worker(new URL('./png-worker.mjs',import.meta.url));
    worker.unref();
    worker.on('message',m=>{
      if(m.ready){idle.push(worker);pump();return;}
      const job=pending.get(m.id);if(!job)return;pending.delete(m.id);
      const out=m.data&&Buffer.from(m.data.buffer,m.data.byteOffset,m.data.byteLength);
      job.resolve(out&&out.length<job.data.length?out:job.data);
      idle.push(worker);pump();
    });
    worker.on('error',()=>fail(worker));
    workers.push(worker);
  };
  const pump=()=>{
    while(idle.length&&queue.length) {
      const worker=idle.pop(),job=queue.shift(),id=++seq;
      pending.set(id,{...job,worker});
      const copy=new Uint8Array(job.data);
      worker.postMessage({id,data:copy,level:LEVEL},[copy.buffer]);
    }
  };
  return {
    /** 返回优化后的 Buffer；不是 PNG、没变小或出错时返回原 Buffer */
    optimize(data) {
      if(broken||!isPng(data))return Promise.resolve(data);
      return new Promise(resolve=>{
        queue.push({data,resolve});
        if(workers.length<size&&workers.length<queue.length+pending.size)spawn();
        pump();
      });
    },
    async close(){await Promise.all(workers.map(w=>w.terminate()));},
  };
}
const SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const isPng=data=>data.length>8&&data.subarray(0,8).equals(SIGNATURE);

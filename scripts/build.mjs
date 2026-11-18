import {build} from 'esbuild';
import {readFile,mkdir,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
// cli 与 PNG 压缩线程各打一个文件；oxipng 的 wasm 复制到同目录，运行时按相对路径加载
await build({entryPoints:['cli','png-worker'].map(name=>fileURLToPath(new URL(`../src/${name}.mjs`,import.meta.url))),outdir:fileURLToPath(new URL('../dist/',import.meta.url)),outExtension:{'.js':'.mjs'},
  bundle:true,platform:'node',target:'node22.15',format:'esm',minify:false,
  define:{MELONBUILD_VERSION:JSON.stringify(pkg.version)}});
await copyFile(new URL('../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm',import.meta.url),new URL('../dist/squoosh_oxipng_bg.wasm',import.meta.url));

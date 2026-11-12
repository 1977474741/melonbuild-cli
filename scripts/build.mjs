import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
await build({entryPoints:[new URL('../src/cli.mjs',import.meta.url).pathname],outfile:new URL('../dist/cli.mjs',import.meta.url).pathname,
  bundle:true,platform:'node',target:'node22.15',format:'esm',minify:false,
  define:{MELONBUILD_VERSION:JSON.stringify(pkg.version)}});

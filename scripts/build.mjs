import {build} from 'esbuild';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir(new URL('../dist/',import.meta.url),{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('../src/cli.mjs',import.meta.url))],outfile:fileURLToPath(new URL('../dist/cli.mjs',import.meta.url)),
  bundle:true,platform:'node',target:'node22.15',format:'esm',minify:false,
  define:{MELONBUILD_VERSION:JSON.stringify(pkg.version)}});

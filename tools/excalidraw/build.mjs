// Empacota o Excalidraw + React num módulo ES com divisão de código em js/vendor/excalidraw/.
// As fontes vão junto (menos a Xiaolai, só para chinês/japonês, ~13 MB).
import * as esbuild from 'esbuild';
import {cpSync, rmSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'js', 'vendor', 'excalidraw');
const pkg = join(here, 'node_modules', '@excalidraw', 'excalidraw');

rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});

await esbuild.build({
  entryPoints: {board: join(here, 'src', 'board.jsx')},
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'es2020',
  jsx: 'automatic',
  outdir: out,
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  conditions: ['production'],
  define: {'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"'},
  loader: {'.woff2': 'file', '.png': 'file', '.svg': 'file'},
  legalComments: 'none',
  logLevel: 'info',
});

cpSync(join(pkg, 'dist', 'prod', 'fonts'), join(out, 'fonts'), {recursive: true, filter: src => !/[\\/]Xiaolai([\\/]|$)/.test(src)});

// O pacote npm do Excalidraw declara MIT mas não traz o arquivo; o texto abaixo é o do repositório oficial.
const MIT_EXCALIDRAW = `MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
writeFileSync(join(out, 'LICENSE.txt'), [
  'Lousa da sala dev DECET, gerada por tools/excalidraw (npm run build).',
  `Inclui Excalidraw ${version} (MIT, https://github.com/excalidraw/excalidraw), React e React DOM 18.3.1 (MIT) e as dependências deles (licenças MIT, ISC e similares).`,
  '',
  '=== Excalidraw',
  MIT_EXCALIDRAW,
  '=== React',
  readFileSync(join(here, 'node_modules', 'react', 'LICENSE'), 'utf8'),
].join('\n'));
console.log('ok:', out);

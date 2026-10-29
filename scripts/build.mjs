import { build } from 'esbuild';
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(root, 'dist');
const runtimePrefixes = ['vehicles/', 'previews/', 'icons/'];
const runtimeProps = new Set(['props/signal_pole_3light.glb', 'props/street_lamp.glb']);

async function collect(directory, relative = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const key = relative ? `${relative}/${item.name}` : item.name;
    if (item.isDirectory()) files.push(...await collect(path.join(directory, item.name), key));
    else files.push(key);
  }
  return files.sort();
}

// Build output is the only directory this script replaces.
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('构建输出目录不合法。');
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, 'assets'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/main.js'],
  outfile: 'dist/assets/app.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'eof',
});
await writeFile(path.join(dist, 'assets/app.css'), (await readFile(path.join(root, 'src/style.css'), 'utf8')) + '\n' + (await readFile(path.join(root, 'src/sandbox-theme.css'), 'utf8')));

const assetKeys = (await collect(path.join(root, 'assets'))).filter(key => runtimePrefixes.some(prefix => key.startsWith(prefix)) || runtimeProps.has(key));
let assetBytes = 0;
for (const key of assetKeys) {
  const bytes = await readFile(path.join(root, 'assets', key));
  const target = path.join(dist, 'assets', key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  assetBytes += bytes.length;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="description" content="堵车实验室，独立运行的交通沙盒。">
<title>堵车实验室</title>
<link rel="icon" type="image/svg+xml" href="./assets/icons/brand.svg">
<link rel="stylesheet" href="./assets/app.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="./assets/app.js"></script>
</body>
</html>
`;
await writeFile(path.join(dist, 'index.html'), html);
await mkdir(path.join(root, 'licenses'), { recursive: true });
await copyFile(path.join(root, 'node_modules/three/LICENSE'), path.join(root, 'licenses/three-MIT.txt'));
await copyFile(path.join(root, 'node_modules/esbuild/LICENSE.md'), path.join(root, 'licenses/esbuild-MIT.txt'));
await mkdir(path.join(dist, 'licenses'), { recursive: true });
for (const [from, to] of [
  ['LICENSE', 'MIT.txt'],
  ['licenses/three-MIT.txt', 'three-MIT.txt'],
  ['licenses/esbuild-MIT.txt', 'esbuild-MIT.txt'],
  ['assets/licenses/assets-MIT.txt', 'assets-MIT.txt'],
]) await copyFile(path.join(root, from), path.join(dist, 'licenses', to));
console.log(`已构建完整网页目录 dist；${assetKeys.length} 项本地资源；资源合计 ${(assetBytes / 1024 / 1024).toFixed(2)} MiB。`);

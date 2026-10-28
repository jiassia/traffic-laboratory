import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const root = path.resolve(projectRoot, value('--root', 'dist'));
const port = Number(value('--port', process.env.PORT || '4173'));
const host = value('--host', '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1 至 65535 的整数。');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname).replaceAll('\\', '/');
    let file = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return; }
    if ((await stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
        response.writeHead(308, { Location: url.pathname + url.search });
        response.end();
        return;
      }
      file = path.join(file, 'index.html');
    }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('文件不存在。');
  }
});
server.listen(port, host, () => {
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const address = `http://${browserHost}:${port}/`;
  console.log(`堵车实验室：${address}`);
  if (args.includes('--open')) {
    const executable = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const openArgs = process.platform === 'win32' ? ['/c', 'start', '', address] : [address];
    const browser = spawn(executable, openArgs, { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`请在浏览器打开 ${address}`));
  }
});

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.fbx': 'application/octet-stream', '.svg': 'image/svg+xml',
};

// root 아래 파일을 서빙한다. handler 가 true 를 돌려주면 그 요청은 처리된 것으로 본다.
export function serveFile(root, req, res) {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(root, url === '/' ? '/web/index.html' : url));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function startStatic(root, port, handler) {
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      if (handler && await handler(req, res)) return;
      serveFile(root, req, res);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

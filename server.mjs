// 에셋 검색 웹 서버.  node server.mjs  →  http://localhost:8080
//  GET  /api/catalog   웹에서 쓸 에셋 목록
//  GET  /api/status    catalog 버전 + 폴더 감시 상태
//  POST /api/search    { q } 자연어 질문 → Claude 가 검색 조건으로 변환 → 로컬 DB 에서 매칭
//  POST /api/batch     라벨 없는 에셋을 Batch API 로 제출
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { startStatic } from './tools/static.mjs';
import { parseQuery, runQuery } from './web/search.mjs';

const ROOT = import.meta.dirname;
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const PORT = +(process.env.PORT || 8080);
process.loadEnvFile(path.join(ROOT, '.env'));
const client = new Anthropic();

let cache = { mtime: 0, data: null };
function catalog() {
  const m = fs.statSync(CATALOG).mtimeMs;
  if (m !== cache.mtime) cache = { mtime: m, data: JSON.parse(fs.readFileSync(CATALOG, 'utf8')).filter(e => e.thumb) };
  return cache.data;
}

const slim = e => ({
  id: e.id, name: e.name, pack: e.pack, category: e.category, file: e.file,
  sourcePath: e.sourcePath, thumb: e.thumb.card, addedAt: e.addedAt,
  stats: e.stats && { triangles: e.stats.triangles, meshes: e.stats.meshes, skinned: e.stats.skinned, bones: e.stats.bones, animations: e.stats.animations },
  materials: e.materials, labels: e.labels || null,
});

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
});

const STATUS = path.join(ROOT, 'data', 'watch-status.json');
const readStatus = () => { try { return JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return null; } };

async function api(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/catalog') {
    json(res, 200, { version: (catalog(), cache.mtime), items: catalog().map(slim) });
    return true;
  }
  // 화면이 주기적으로 불러서, catalog 가 바뀌었는지 / 폴더 감시가 뭘 하고 있는지 본다
  if (url.pathname === '/api/status') {
    catalog();
    json(res, 200, { version: cache.mtime, watch: readStatus() });
    return true;
  }
  // 대량으로 들어온 새 에셋을 Batch API 로 제출 (결과는 폴더 감시가 받아온다)
  if (url.pathname === '/api/batch' && req.method === 'POST') {
    execFile('node', ['tools/label.mjs', '--batch'], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) return json(res, 500, { error: (stderr || err.message).trim().split('\n').pop() });
      json(res, 200, { message: stdout.trim().split('\n').pop() });
    });
    return true;
  }
  if (url.pathname === '/api/search' && req.method === 'POST') {
    try {
      const { q } = await readBody(req);
      if (!q || !q.trim()) return json(res, 400, { error: '검색어가 비었습니다' }), true;
      const t0 = Date.now();
      const { query, usage, costUSD } = await parseQuery(client, q.trim());
      const { results, relaxed } = runQuery(catalog(), query);
      json(res, 200, { query, relaxed, ms: Date.now() - t0, usage, costUSD, results: results.slice(0, 120).map(r => ({ id: r.e.id, score: r.score, hits: r.hits })) });
    } catch (err) {
      const msg = err instanceof Anthropic.AuthenticationError ? 'API 키 오류 (.env 확인)'
        : err instanceof Anthropic.RateLimitError ? '요청이 너무 많습니다. 잠시 후 다시 시도하세요'
          : err instanceof Anthropic.APIError ? `API 오류 ${err.status}` : String(err.message || err);
      console.error('search error:', msg);
      json(res, 500, { error: msg });
    }
    return true;
  }
  return false;
}

await startStatic(ROOT, PORT, api);
console.log(`에셋 검색: http://localhost:${PORT}`);

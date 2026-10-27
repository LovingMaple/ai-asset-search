// catalog.json 의 FBX 를 헤드리스 브라우저(three.js)로 렌더링해 thumbs/ 에 저장한다.
// usage: node tools/render.mjs [--force] [--limit N]
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startStatic } from './static.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const THUMBS = path.join(ROOT, 'thumbs');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

const args = process.argv.slice(2);
const force = args.includes('--force');
const limit = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : Infinity;

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const server = await startStatic(ROOT, 0);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: BROWSERS.find(p => fs.existsSync(p)),
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('  page error:', e.message));
await page.goto(`http://localhost:${port}/tools/render.html`);
await page.waitForFunction('window.ready === true');

const save = (file, dataUrl) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
};

let done = 0, failed = 0, empty = 0;
for (const entry of catalog) {
  if (done >= limit) break;
  const gridFile = path.join(THUMBS, entry.id + '.grid.jpg');
  if (!force && entry.thumb && fs.existsSync(gridFile)) continue;
  try {
    const res = await Promise.race([
      page.evaluate(e => window.renderAsset(e), entry),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000)),
    ]);
    entry.stats = res.stats;
    if (res.empty) {
      entry.empty = true; empty++;
    } else {
      save(gridFile, res.grid);
      save(path.join(THUMBS, entry.id + '.card.jpg'), res.card);
      entry.thumb = { grid: `thumbs/${entry.id}.grid.jpg`, card: `thumbs/${entry.id}.card.jpg` };
      delete entry.empty;
    }
  } catch (e) {
    failed++;
    entry.renderError = String(e.message || e).slice(0, 200);
    console.error(`  FAIL ${entry.id}: ${entry.renderError}`);
  }
  done++;
  if (done % 25 === 0) {
    console.log(`${done} rendered…`);
    fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 1));
  }
}
fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 1));
console.log(`done ${done}, empty(no mesh) ${empty}, failed ${failed}`);
await browser.close();
server.close();

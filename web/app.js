import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeManager, applyMaterials } from '/web/fbx-materials.js';
import { fieldText } from '/web/search.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EXAMPLES = ['중세풍 붉은 상의', '귀여운 날개 달린 몬스터', 'red medieval top', '리깅된 농장 동물', '서부 술집에 놓을 소품', '폴리곤 300 이하 음식'];

let catalog = [];
let byId = new Map();
let mode = 'ai';
let lastAI = null; // { q, data }

// ---------- 데이터 ----------
let version = 0;
const isNew = e => e.addedAt && Date.now() - new Date(e.addedAt) < 24 * 3600e3;
// 기본 목록: 새로 들어온 에셋이 맨 앞
const allItems = () => [...catalog].sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')).map(e => ({ e }));

async function loadCatalog() {
  const data = await (await fetch('/api/catalog')).json();
  version = data.version;
  catalog = data.items;
  byId = new Map(catalog.map(e => [e.id, e]));
  for (const e of catalog) e._ft = fieldText(e);
  const labeled = catalog.filter(e => e.labels);
  const vague = labeled.filter(e => e.labels.name_matches_image === false).length;
  $('#stat').textContent = `${catalog.length}개 에셋 · 라벨 ${labeled.length}개` +
    (labeled.length ? ` · 파일명만으로는 알 수 없는 에셋 ${Math.round(vague / labeled.length * 100)}%` : '');

  const fill = (sel, first, values) => {
    const cur = $(sel).value;
    $(sel).innerHTML = `<option value="">${first}</option>` + values.map(v => `<option>${esc(v)}</option>`).join('');
    $(sel).value = values.includes(cur) ? cur : '';
  };
  fill('#fType', '전체 분류', [...new Set(labeled.map(e => e.labels.type))].sort());
  fill('#fPack', '전체 팩', [...new Set(catalog.map(e => e.pack))].sort());
}

function refreshView() {
  if (mode === 'name') runName();
  else if (lastAI) showAI();
  else render(allItems());
}

async function init() {
  await loadCatalog();
  $('#examples').innerHTML = EXAMPLES.map(x => `<button type="button">${esc(x)}</button>`).join('');
  refreshView();
  pollStatus();
  setInterval(pollStatus, 4000);
}

// 폴더 감시 상태 + catalog 가 바뀌면 화면 갱신
async function pollStatus() {
  let s;
  try { s = await (await fetch('/api/status')).json(); } catch { return; }
  const w = s.watch;
  const el = $('#watch');
  if (w) {
    const busy = ['scanning', 'rendering', 'labeling', 'batch'].includes(w.state);
    const warn = ['needs_batch', 'capped', 'error'].includes(w.state);
    el.hidden = false;
    el.className = 'watch' + (busy ? ' busy' : '') + (warn ? ' warn' : '');
    el.title = `감시 폴더: ${w.watchDir}\n\n${(w.log || []).join('\n')}`;
    el.innerHTML = `<span class="dot"></span><span class="msg">${esc(w.state === 'idle' ? '폴더 감시 중' : w.message)}</span>` +
      (w.state === 'needs_batch' ? `<button id="batchBtn">Batch로 처리</button>` : '');
  }
  if (s.version !== version) {
    await loadCatalog();
    if (!lastAI || mode === 'name') refreshView(); // AI 결과는 다시 검색해야 반영되므로 그대로 둔다
  }
}

$('#watch').addEventListener('click', async ev => {
  if (ev.target.id !== 'batchBtn') return;
  ev.target.disabled = true;
  ev.target.textContent = '제출 중…';
  const r = await fetch('/api/batch', { method: 'POST' });
  const d = await r.json();
  alert(r.ok ? d.message : `실패: ${d.error}`);
  pollStatus();
});

function filters(list) {
  const t = $('#fType').value, p = $('#fPack').value;
  const st = $('#fStatic').checked, sk = $('#fSkel').checked;
  const kindOk = e => (st === sk) || (sk ? e.stats?.skinned : !e.stats?.skinned); // 둘 다 켜거나 끄면 전체
  return list.filter(({ e }) => (!t || e.labels?.type === t) && (!p || e.pack === p) && kindOk(e));
}

// 기존 방식: 파일명/경로/팩 이름에 글자가 들어있는지
function nameHits(q, withKeywords) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.filter(e => {
    const hay = withKeywords ? e._ft.any + ' ' + e._ft.keywords : `${e.name} ${e.sourcePath} ${e.pack}`.toLowerCase();
    return toks.every(t => hay.includes(t));
  });
}

// ---------- 검색 ----------
function runName() {
  const q = $('#q').value.trim();
  $('#banner').hidden = true;
  const list = q ? nameHits(q, $('#fKw').checked).map(e => ({ e })) : allItems();
  render(list, q ? `"${q}" — 이름 검색 결과 없음` : '');
}

async function runAI(q) {
  if (!q) return;
  const btn = $('#go');
  btn.disabled = true; btn.textContent = '검색 중…';
  try {
    const r = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    lastAI = { q, data };
    showAI();
  } catch (err) {
    $('#banner').hidden = false;
    $('#banner').className = 'banner warn';
    $('#banner').innerHTML = `<div class="sum">검색 실패: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '검색';
  }
}

function showAI() {
  const { q, data } = lastAI;
  const chip = (g, must) => `<span class="chip ${must ? 'must' : ''}"><small>${esc(FIELD_KO[g.field] || g.field)}</small>${esc(g.terms.slice(0, 5).join(' / '))}${g.terms.length > 5 ? ' …' : ''}</span>`;
  const extra = [];
  if (data.query.rigged !== '상관없음') extra.push(`<span class="chip must"><small>메시</small>${data.query.rigged === '예' ? '스켈레탈' : '스태틱'}</span>`);
  if (data.query.max_triangles > 0) extra.push(`<span class="chip must"><small>폴리곤</small>≤ ${data.query.max_triangles}</span>`);
  const nameCount = nameHits(q, false).length;
  $('#banner').hidden = false;
  $('#banner').className = 'banner' + (data.relaxed ? ' warn' : '');
  $('#banner').innerHTML = `
    <div class="sum">${esc(data.query.summary)}</div>
    <div class="chips">${data.query.must.map(g => chip(g, true)).join('')}${extra.join('')}${data.query.should.map(g => chip(g, false)).join('')}</div>
    <div class="compare">AI 검색 <b>${data.results.length}건</b> · 같은 문장으로 파일명 검색했다면 <b>${nameCount}건</b>
      ${data.relaxed ? ' · 모든 조건을 만족하는 에셋이 없어 일부 조건만 맞는 결과를 보여줍니다' : ''}</div>
    <div class="meta">질의 해석 ${(data.ms / 1000).toFixed(1)}초 · 약 $${data.costUSD} · 채운 칸=필수 조건, 빈 칸=있으면 가산</div>`;
  render(data.results.map(r => ({ e: byId.get(r.id), hits: r.hits })).filter(x => x.e), '조건에 맞는 에셋이 없습니다');
}

const FIELD_KO = { type: '분류', keywords: '키워드', colors: '색', materials: '재질', style: '스타일', body_part: '부위', any: '전체' };

// ---------- 그리기 ----------
function render(list, emptyMsg = '') {
  list = filters(list);
  $('#grid').innerHTML = list.slice(0, 300).map(({ e, hits }) => {
    const L = e.labels;
    const hit = new Set((hits || []).map(h => h.toLowerCase()));
    const tags = L ? [L.type, ...L.colors.slice(0, 2), ...L.style.slice(0, 1)] : ['라벨 없음'];
    return `<button class="card" data-id="${esc(e.id)}">
      <img loading="lazy" src="/${esc(e.thumb)}" alt="">
      <div class="body">
        <span class="title">${esc(L ? L.name_ko : e.name)}</span>
        <span class="file">${esc(e.name)}</span>
        <div class="tags">
          ${tags.map(t => `<span class="tag ${[...hit].some(h => String(t).toLowerCase().includes(h)) ? 'hit' : ''}">${esc(t)}</span>`).join('')}
          ${L && L.name_matches_image === false ? '<span class="tag vague">이름 불명확</span>' : ''}
          ${isNew(e) ? '<span class="tag new">NEW</span>' : ''}
        </div>
      </div>
    </button>`;
  }).join('');
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = emptyMsg;
}

// ---------- 상세 + 3D ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('#view'), antialias: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8e8ec);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a95, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1e6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.autoRotate = true;
controls.autoRotateSpeed = 1.5;
controls.addEventListener('start', () => { controls.autoRotate = false; });
const loader = new FBXLoader(makeManager());
let current = null, token = 0, running = false;

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  controls.update();
  sun.position.copy(camera.position).add(new THREE.Vector3(0, camera.position.length() * 0.5, 0));
  renderer.render(scene, camera);
}

async function show3D(e) {
  const my = ++token;
  if (current) { scene.remove(current); current = null; }
  $('#viewMsg').textContent = '3D 불러오는 중…';
  const size = $('#view').clientWidth;
  renderer.setSize(size, size, false);
  try {
    const obj = await loader.loadAsync('/' + e.file);
    await applyMaterials(obj, e);
    if (my !== token) return;
    const box = new THREE.Box3().setFromObject(obj, true);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    obj.position.sub(sphere.center);
    current = obj;
    scene.add(obj);
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.1;
    camera.position.set(dist * 0.55, dist * 0.35, dist * 0.75);
    camera.near = dist / 100; camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.autoRotate = true;
    controls.update();
    $('#viewMsg').textContent = '드래그로 회전 · 휠로 확대';
  } catch (err) {
    $('#viewMsg').textContent = '3D 미리보기 실패: ' + err.message;
  }
}

function openDetail(e) {
  const L = e.labels;
  const s = e.stats || {};
  const kw = arr => `<div class="kw">${(arr || []).map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div>`;
  $('#info').innerHTML = `
    <h2>${esc(L ? L.name_ko : e.name)}</h2>
    <p class="sub">${L ? `${esc(L.type)} › ${esc(L.subtype)}` : '아직 라벨이 없습니다'}</p>
    ${L ? `<p class="desc">${esc(L.description)}</p>` : ''}
    ${L && L.name_matches_image === false ? `<div class="note">파일명 <b>${esc(e.name)}</b> 만으로는 무엇인지 알기 어려운 에셋입니다.</div>` : ''}
    <dl class="kv">
      ${L ? `<dt>색</dt><dd>${kw(L.colors)}</dd><dt>재질</dt><dd>${kw(L.materials)}</dd><dt>스타일</dt><dd>${kw(L.style)}</dd>
      <dt>착용 부위</dt><dd>${esc(L.body_part)}</dd><dt>용도</dt><dd>${kw(L.use_cases)}</dd>
      <dt>키워드</dt><dd>${kw([...L.keywords_ko, ...L.keywords_en])}</dd>` : ''}
      <dt>폴리곤</dt><dd>${(s.triangles ?? '?').toLocaleString()} 삼각형 · 메시 ${s.meshes ?? '?'}개</dd>
      <dt>메시 종류</dt><dd>${s.skinned ? `스켈레탈 메시 (본 ${s.bones}개)` : '스태틱 메시'}${s.animations ? ` · 애니메이션 ${s.animations}개` : ''}</dd>
      ${L ? `<dt>라벨 확신도</dt><dd>${esc(L.confidence)}</dd>` : ''}
    </dl>
    ${src('유니티 프로젝트 경로', e.sourcePath)}`;
  $('#detail').hidden = false;
  running = true;
  loop();
  show3D(e);
}
const src = (label, val) => `<div class="src"><div class="lbl">${esc(label)}<button class="copy" data-copy="${esc(val)}">복사</button></div><code>${esc(val)}</code></div>`;

function closeDetail() {
  $('#detail').hidden = true;
  running = false;
  token++;
  if (current) { scene.remove(current); current = null; }
}

// ---------- 이벤트 ----------
document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('on', x === b));
  document.body.classList.toggle('name-mode', mode === 'name');
  $('#q').placeholder = mode === 'ai' ? '예: 중세풍 붉은 상의, 귀여운 날개 달린 몬스터, red medieval top' : '예: Shield, SM_Wep, Armor body, 방패';
  if (mode === 'name') runName(); else if (lastAI) showAI(); else { $('#banner').hidden = true; refreshView(); }
}));
$('#form').addEventListener('submit', ev => { ev.preventDefault(); mode === 'ai' ? runAI($('#q').value.trim()) : runName(); });
$('#q').addEventListener('input', () => { if (mode === 'name') runName(); });
['#fType', '#fPack', '#fStatic', '#fSkel', '#fKw'].forEach(s => $(s).addEventListener('change', refreshView));
$('#examples').addEventListener('click', ev => {
  if (ev.target.tagName !== 'BUTTON') return;
  $('#q').value = ev.target.textContent;
  if (mode !== 'ai') document.querySelector('[data-mode=ai]').click();
  runAI(ev.target.textContent);
});
$('#grid').addEventListener('click', ev => { const c = ev.target.closest('.card'); if (c) openDetail(byId.get(c.dataset.id)); });
$('#close').addEventListener('click', closeDetail);
$('#detail').addEventListener('click', ev => { if (ev.target.id === 'detail') closeDetail(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeDetail(); });
$('#info').addEventListener('click', async ev => {
  const b = ev.target.closest('.copy');
  if (!b) return;
  await navigator.clipboard.writeText(b.dataset.copy);
  b.textContent = '복사됨'; b.classList.add('done');
  setTimeout(() => { b.textContent = '복사'; b.classList.remove('done'); }, 1200);
});

init();

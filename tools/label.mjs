// 4방향 썸네일 + 메타데이터를 Claude 에 보내 에셋 라벨(JSON)을 받아 catalog.json 에 저장한다.
//
//   node tools/label.mjs --test 10     일반 호출로 N개만 (팩별로 고르게) — 품질/비용 확인용
//   node tools/label.mjs --batch       라벨 없는 나머지 전부를 Batch API 로 제출 (50% 할인)
//   node tools/label.mjs --collect     제출한 배치 결과를 받아 catalog 에 합친다
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const BATCH_STATE = path.join(ROOT, 'data', 'batch.json');
process.loadEnvFile(path.join(ROOT, '.env'));

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4 / 1e6, output: 20 / 1e6 }; // $/token, Batch 는 절반
const client = new Anthropic();

const TYPES = ['캐릭터', '의상/장비', '무기', '소품', '가구', '건물/구조물', '환경/자연', '탈것', '동물', '몬스터/크리처', '음식', '기타'];
const PARTS = ['머리', '상의', '하의', '손', '발', '등/망토', '전신', '해당없음'];
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'subtype', 'name_ko', 'description', 'colors', 'materials', 'style', 'body_part',
    'use_cases', 'keywords_ko', 'keywords_en', 'name_matches_image', 'confidence'],
  properties: {
    type: { type: 'string', enum: TYPES },
    subtype: { type: 'string', description: '구체적 분류. 예: 중세 망토, 롱소드, 나무 술통' },
    name_ko: { type: 'string', description: '기획자가 부를 법한 짧은 한국어 이름' },
    description: { type: 'string', description: '보이는 그대로 1~2문장. 색/재질/형태/특징' },
    colors: strArr('주요 색 1~4개, 한국어 기본 색명(빨간색, 갈색, 회색…), 면적 큰 순'),
    materials: strArr('보이는 재질. 천, 가죽, 금속, 나무, 돌, 플라스틱, 유리, 털, 피부 등'),
    style: strArr('시대/장르/아트스타일. 중세, 판타지, 바이킹, 서부, 현대, SF, 호러, 카툰, 로우폴리 등'),
    body_part: { type: 'string', enum: PARTS, description: '착용 장비/의상일 때 착용 부위. 그 외는 해당없음' },
    use_cases: strArr('게임 기획 관점에서 쓸 만한 용도 1~3개. 예: 마을 배경 소품, 초반 무기, NPC'),
    keywords_ko: strArr('검색용 한국어 동의어/연관어 5~10개'),
    keywords_en: strArr('검색용 영어 키워드 5~10개 (shirt, tunic, top 처럼 동의어 포함)'),
    name_matches_image: { type: 'boolean', description: '파일명만 보고 무엇인지 알 수 있는가. ToyObject_180, Mesh_02 처럼 번호/일반명이면 false' },
    confidence: { type: 'string', enum: ['높음', '중간', '낮음'] },
  },
};

const SYSTEM = `당신은 게임 개발팀의 3D 에셋 라이브러리를 정리하는 아트 에셋 큐레이터입니다.
이미지는 한 개의 3D 모델을 2x2로 렌더링한 것입니다: 왼쪽 위=앞 3/4, 오른쪽 위=뒤 3/4, 왼쪽 아래=측면, 오른쪽 아래=위에서 내려다본 모습.
배경(연회색)과 조명은 렌더링 환경이니 라벨에 넣지 마세요.

목적: 기획자가 3D 프로그램 없이 "중세풍 붉은 상의" 같은 자연어로 에셋을 찾을 수 있게, 검색에 쓰일 라벨을 만듭니다.
- 이미지에서 보이는 것을 우선하세요. 파일명/경로는 참고용이며 틀리거나 대충 지어졌을 수 있습니다.
- 색은 실제 보이는 색을 쓰세요. 텍스처가 빠져 단색/흰색으로 보이면 그렇게 쓰고 confidence 를 낮추세요.
- 캐릭터가 T포즈인 것은 리깅된 모델의 기본 자세이니 특징으로 쓰지 마세요.
- 모든 값은 한국어로(keywords_en 만 영어) 간결하게 작성하세요.`;

function userText(e) {
  const s = e.stats || {};
  return [
    `파일명: ${e.name}`,
    `팩: ${e.pack}`,
    `원본 경로: ${e.sourcePath}`,
    `폴리곤(삼각형): ${s.triangles}, 메시 수: ${s.meshes}`,
    `리깅: ${s.skinned ? `예 (본 ${s.bones}개)` : '아니오'}, 애니메이션 클립: ${s.animations || 0}`,
    `비율(가로/세로/깊이, 최대=1): ${s.proportions ? `${s.proportions.w}/${s.proportions.h}/${s.proportions.d}` : '?'}`,
    `머티리얼 이름: ${(s.materialNames || []).join(', ') || '없음'}`,
  ].join('\n');
}

function params(e) {
  const img = fs.readFileSync(path.join(ROOT, e.thumb.grid)).toString('base64');
  return {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
        { type: 'text', text: userText(e) },
      ],
    }],
  };
}

function parseMessage(msg) {
  if (msg.stop_reason === 'refusal') throw new Error('refusal: ' + (msg.stop_details?.category ?? ''));
  if (msg.stop_reason === 'max_tokens') throw new Error('max_tokens 에 걸려 잘림');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

const cost = (u, batch) => ((u.input_tokens + (u.cache_read_input_tokens || 0)) * PRICE.input + u.output_tokens * PRICE.output) * (batch ? 0.5 : 1);
const load = () => JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const save = c => fs.writeFileSync(CATALOG, JSON.stringify(c, null, 1));
const pending = c => c.filter(e => e.thumb && !e.labels);

function errMsg(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'API 키가 올바르지 않습니다 (.env 확인)';
  if (err instanceof Anthropic.PermissionDeniedError) return '권한 없음 / 크레딧 부족일 수 있습니다';
  if (err instanceof Anthropic.RateLimitError) return '요청 한도 초과 — 잠시 후 다시';
  if (err instanceof Anthropic.APIError) return `API 오류 ${err.status}: ${err.message}`;
  return String(err.message || err);
}

async function runTest(n) {
  const catalog = load();
  // 팩마다 하나씩 돌아가며 고른다
  const byPack = new Map();
  for (const e of pending(catalog)) (byPack.get(e.pack) || byPack.set(e.pack, []).get(e.pack)).push(e);
  const picks = [];
  while (picks.length < n && [...byPack.values()].some(v => v.length)) {
    for (const v of byPack.values()) if (v.length && picks.length < n) picks.push(v.shift());
  }
  let total = 0;
  for (const e of picks) {
    try {
      const msg = await client.messages.create(params(e));
      e.labels = parseMessage(msg);
      const c = cost(msg.usage, false);
      total += c;
      e.labelMeta = { model: MODEL, mode: 'direct', usage: msg.usage, costUSD: +c.toFixed(5) };
      console.log(`\n■ ${e.id}  (in ${msg.usage.input_tokens} / out ${msg.usage.output_tokens} tok, $${c.toFixed(4)})`);
      console.log(`  ${e.labels.type} > ${e.labels.subtype} | ${e.labels.name_ko}`);
      console.log(`  ${e.labels.description}`);
      console.log(`  색:${e.labels.colors.join(',')}  재질:${e.labels.materials.join(',')}  스타일:${e.labels.style.join(',')}  부위:${e.labels.body_part}`);
      console.log(`  ko:${e.labels.keywords_ko.join(',')}`);
      console.log(`  en:${e.labels.keywords_en.join(',')}  이름일치:${e.labels.name_matches_image}  확신:${e.labels.confidence}`);
      save(catalog);
    } catch (err) {
      console.error(`FAIL ${e.id}: ${errMsg(err)}`);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) break;
    }
  }
  const avg = total / Math.max(1, picks.filter(e => e.labels).length);
  console.log(`\n합계 $${total.toFixed(4)}, 개당 평균 $${avg.toFixed(4)}`);
  console.log(`남은 ${pending(catalog).length}개를 Batch 로 돌리면 약 $${(avg * pending(catalog).length / 2).toFixed(2)} 예상`);
}

async function runBatch() {
  if (fs.existsSync(BATCH_STATE)) {
    console.log('이미 제출한 배치가 있습니다 →', fs.readFileSync(BATCH_STATE, 'utf8'), '\n--collect 로 결과를 받으세요.');
    return;
  }
  const catalog = load();
  const todo = pending(catalog);
  const idMap = {};
  const requests = todo.map((e, i) => {
    const cid = `a${String(i).padStart(4, '0')}`; // custom_id 는 영숫자/-/_ 만 허용
    idMap[cid] = e.id;
    return { custom_id: cid, params: params(e) };
  });
  const batch = await client.messages.batches.create({ requests });
  fs.writeFileSync(BATCH_STATE, JSON.stringify({ id: batch.id, createdAt: new Date().toISOString(), idMap }, null, 1));
  console.log(`제출 완료: ${batch.id} (${requests.length}개). 보통 1시간 안에 끝납니다. --collect 로 확인하세요.`);
}

async function runCollect() {
  const state = JSON.parse(fs.readFileSync(BATCH_STATE, 'utf8'));
  const batch = await client.messages.batches.retrieve(state.id);
  console.log(`상태: ${batch.processing_status}`, batch.request_counts);
  if (batch.processing_status !== 'ended') return;
  const catalog = load();
  const byId = new Map(catalog.map(e => [e.id, e]));
  let ok = 0, bad = 0, total = 0;
  for await (const r of await client.messages.batches.results(state.id)) {
    const e = byId.get(state.idMap[r.custom_id]);
    if (!e) continue;
    if (r.result.type !== 'succeeded') { bad++; console.error(`FAIL ${e.id}: ${r.result.type}`); continue; }
    try {
      e.labels = parseMessage(r.result.message);
      const c = cost(r.result.message.usage, true);
      total += c;
      e.labelMeta = { model: MODEL, mode: 'batch', usage: r.result.message.usage, costUSD: +c.toFixed(5) };
      ok++;
    } catch (err) { bad++; console.error(`FAIL ${e.id}: ${err.message}`); }
  }
  save(catalog);
  fs.renameSync(BATCH_STATE, BATCH_STATE.replace('.json', `.${state.id}.done.json`));
  console.log(`성공 ${ok}, 실패 ${bad}, 배치 비용 약 $${total.toFixed(2)}. 실패분은 --test 나 --batch 로 다시 돌릴 수 있습니다.`);
}

const a = process.argv.slice(2);
if (a[0] === '--test') await runTest(+(a[1] || 10));
else if (a[0] === '--batch') await runBatch();
else if (a[0] === '--collect') await runCollect();
else console.log('usage: --test N | --batch | --collect');

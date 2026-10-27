// AI 검색: Claude 는 자연어 질문을 '검색 조건'으로 바꾸기만 하고, 매칭은 로컬에서 한다.
// (에셋 목록 전체를 매 질문마다 보내지 않으므로 질문당 비용이 작고, 에셋이 늘어도 비용이 같다)

const MODEL = 'claude-opus-5-5';
const PRICE = { input: 4 / 1e6, output: 20 / 1e6 };

export const FIELDS = ['type', 'keywords', 'colors', 'materials', 'style', 'body_part', 'any'];
const TYPES = ['캐릭터', '의상/장비', '무기', '소품', '가구', '건물/구조물', '환경/자연', '탈것', '동물', '몬스터/크리처', '음식', '기타'];
const PARTS = ['머리', '상의', '하의', '손', '발', '등/망토', '전신', '해당없음'];

const group = {
  type: 'object', additionalProperties: false, required: ['field', 'terms'],
  properties: {
    field: { type: 'string', enum: FIELDS },
    terms: { type: 'array', items: { type: 'string' } },
  },
};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'must', 'should', 'rigged', 'max_triangles'],
  properties: {
    summary: { type: 'string', description: '질문을 어떻게 해석했는지 한국어 한 문장' },
    must: { type: 'array', items: group, description: '반드시 만족해야 하는 조건. 그룹 안의 terms 는 OR, 그룹끼리는 AND' },
    should: { type: 'array', items: group, description: '있으면 순위를 올리는 조건' },
    rigged: { type: 'string', enum: ['예', '아니오', '상관없음'] },
    max_triangles: { type: 'integer', description: '폴리곤 상한. 언급 없으면 0' },
  },
};

const SYSTEM = `당신은 게임 3D 에셋 검색 엔진의 질의 해석기입니다. 사용자의 자연어 질문(한국어/영어)을 검색 조건 JSON 으로 바꿉니다.

각 에셋에는 AI 가 붙인 라벨이 있습니다:
- type: ${TYPES.join(' | ')}
- body_part (착용 장비): ${PARTS.join(' | ')}
- colors: 한국어 색명 (빨간색, 짙은 빨간색, 적갈색, 갈색, 회색 …)
- materials: 천, 가죽, 금속, 나무, 돌, 플라스틱 …
- style: 중세, 판타지, 바이킹, 서부, 현대, SF, 호러, 카툰, 로우폴리 …
- keywords: 분류·이름·설명·한국어/영어 키워드·파일명

조건 field 별 매칭 대상: type=분류, keywords=이름/설명/키워드/파일명, colors=색, materials=재질, style=스타일/팩 이름, body_part=착용 부위, any=전체.
매칭은 '부분 문자열 포함'입니다. 그러므로:
- terms 에는 짧은 어근과 동의어를 넉넉히 넣으세요. 예: 붉은 → ["빨간", "붉은", "적갈", "red"], 상의 → body_part ["상의"] + keywords ["상의", "셔츠", "튜닉", "몸통", "흉갑", "shirt", "tunic", "torso", "body"]
- 질문의 핵심 대상은 must, 수식어(분위기·부가 특징)는 should 에 두세요. 색·시대처럼 사용자가 분명히 요구한 속성은 must 입니다.
- type 조건은 확실할 때만 쓰고, 애매하면 keywords 로 표현하세요.
- 캐릭터가 '입고 있는' 옷을 찾는 경우도 고려해 상의/하의 같은 부위 조건은 body_part 와 keywords 두 그룹을 함께 쓰되, 둘 중 하나를 must 로 두고 다른 하나는 should 로 두세요.`;

export async function parseQuery(client, q) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: q }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('요청을 처리할 수 없습니다');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const u = msg.usage;
  return { query: JSON.parse(text), usage: u, costUSD: +(u.input_tokens * PRICE.input + u.output_tokens * PRICE.output).toFixed(4) };
}

// ---- 로컬 매칭 (브라우저 이름 검색에서도 같은 텍스트 구성을 쓴다) ----
const norm = s => String(s ?? '').toLowerCase();

export function fieldText(e) {
  const L = e.labels || {};
  const keywords = [e.name, e.sourcePath, L.subtype, L.name_ko, L.description, ...(L.keywords_ko || []), ...(L.keywords_en || []), ...(L.use_cases || [])];
  const f = {
    type: [L.type],
    keywords,
    colors: [...(L.colors || [])],
    materials: [...(L.materials || []), L.description],
    style: [...(L.style || []), e.pack],
    body_part: [L.body_part],
  };
  f.any = Object.values(f).flat();
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, norm(v.filter(Boolean).join(' | '))]));
}

function matchGroup(ft, g) {
  const hay = ft[g.field] ?? ft.any;
  const hit = g.terms.find(t => t && hay.includes(norm(t)));
  return hit || null;
}

export function runQuery(catalog, query, poolSize = 100) {
  const score = (e, strict) => {
    if (!e.labels) return null;
    const s = e.stats || {};
    if (query.rigged === '예' && !s.skinned) return null;
    if (query.rigged === '아니오' && s.skinned) return null;
    if (query.max_triangles > 0 && s.triangles > query.max_triangles) return null;
    const ft = e._ft || (e._ft = fieldText(e));
    // 부위를 물었는데 다른 부위 장비(장화 vs 상의)면 제외. 부위 없는 캐릭터/소품은 통과
    const bp = e.labels.body_part;
    const partGroups = [...query.must, ...query.should].filter(g => g.field === 'body_part');
    if (partGroups.length && bp !== '해당없음' && bp !== '전신' && !partGroups.some(g => matchGroup(ft, g))) return null;
    let sc = 0;
    const hits = [];
    for (const g of query.must) {
      const h = matchGroup(ft, g);
      if (h) { sc += 10; hits.push(h); } else if (strict) return null;
    }
    for (const g of query.should) {
      const h = matchGroup(ft, g);
      if (h) { sc += 3; hits.push(h); }
    }
    if (e.labels.confidence === '높음') sc += 0.5;
    return sc > 0 ? { e, score: sc, hits } : null;
  };
  // 1차 후보: 모든 필수 조건을 만족하는 것 먼저, 모자라면 일부만 맞는 것으로 poolSize 까지 채운다
  const strict = catalog.map(e => score(e, true)).filter(Boolean).sort((a, b) => b.score - a.score);
  const strictIds = new Set(strict.map(r => r.e.id));
  const partial = catalog.filter(e => !strictIds.has(e.id)).map(e => score(e, false)).filter(Boolean)
    .sort((a, b) => b.score - a.score);
  for (const r of partial) r.partial = true;
  const results = [...strict, ...partial].slice(0, Math.max(poolSize, strict.length));
  return { results, strictCount: strict.length, relaxed: !strict.length && query.must.length > 0 };
}

// ---- 2차: Claude 가 에셋 목록을 직접 보고 고른다 ----
// 목록 블록은 질문과 무관하게 항상 같은 내용/순서라 프롬프트 캐시에 올라간다 (catalog 가 바뀔 때만 새로 씀)
const FULL_LIST_MAX = 1500; // 이보다 많으면 전체 대신 1차 후보만 보낸다

function compactLine(e, i) {
  const L = e.labels;
  return `#${i} ${L.type}>${L.subtype} | ${L.name_ko} | 색:${L.colors.join(',')} | 재질:${L.materials.join(',')}` +
    ` | ${L.style.join(',')} | 부위:${L.body_part} | ${e.stats?.skinned ? '스켈레탈' : '스태틱'} ${e.stats?.triangles ?? '?'}tri` +
    ` | ${L.keywords_ko.slice(0, 5).join(',')}`;
}

const RERANK_SYSTEM = `당신은 게임 3D 에셋 검색 엔진의 최종 선별 담당입니다.
아래에 팀의 에셋 목록이 있습니다(한 줄에 하나, #번호 | 분류>세부 | 이름 | 색 | 재질 | 스타일 | 착용 부위 | 메시 종류·폴리곤 | 키워드).
사용자의 질문(한국어/영어, "~한 느낌" 같은 모호한 표현 포함)에 맞는 에셋을 고르세요.
- tier "정확": 질문의 핵심을 모두 만족. tier "관련": 일부만 맞거나 대안으로 쓸 만함.
- 질문과 단어가 겹치지 않아도 의미·분위기·용도가 맞으면 고르세요. 반대로 단어만 겹치고 의미가 다르면 고르지 마세요.
- 정확 → 관련 순서, 같은 tier 안에서는 더 잘 맞는 순서로 최대 40개.
- reason 은 왜 골랐는지 한국어 15자 안팎.
- 1차 키워드 후보는 참고용입니다. 후보에 없는 에셋도 고를 수 있습니다.`;

const RERANK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['picks'],
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'tier', 'reason'],
        properties: { n: { type: 'integer' }, tier: { type: 'string', enum: ['정확', '관련'] }, reason: { type: 'string' } },
      },
    },
  },
};

export async function rerank(client, q, catalog, poolIds) {
  const labeled = catalog.filter(e => e.labels).sort((a, b) => a.id.localeCompare(b.id));
  const pool = new Set(poolIds);
  const list = labeled.length <= FULL_LIST_MAX ? labeled : labeled.filter(e => pool.has(e.id));
  const num = new Map(list.map((e, i) => [e.id, i]));
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RERANK_SCHEMA } },
    system: [
      { type: 'text', text: RERANK_SYSTEM },
      { type: 'text', text: `에셋 목록 (${list.length}개)\n` + list.map(compactLine).join('\n'), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: `질문: ${q}\n1차 키워드 후보(관련도 순): ${poolIds.filter(id => num.has(id)).slice(0, 100).map(id => '#' + num.get(id)).join(', ') || '없음'}`,
    }],
  });
  if (msg.stop_reason === 'refusal') throw new Error('요청을 처리할 수 없습니다');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const seen = new Set();
  const picks = JSON.parse(text).picks
    .filter(p => list[p.n] && !seen.has(p.n) && seen.add(p.n))
    .map(p => ({ id: list[p.n].id, tier: p.tier, reason: p.reason }));
  const u = msg.usage;
  const costUSD = (u.input_tokens * PRICE.input + (u.cache_creation_input_tokens || 0) * PRICE.input * 1.25 +
    (u.cache_read_input_tokens || 0) * PRICE.input * 0.1 + u.output_tokens * PRICE.output);
  return { picks, usage: u, costUSD: +costUSD.toFixed(4), listSize: list.length };
}

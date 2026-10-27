// 에셋 폴더를 감시하다가 바뀌면  추출(ingest.py) → 썸네일(render.mjs) → 라벨링(label.mjs --auto)  을 돌린다.
// 진행 상태는 data/watch-status.json 에 써서 웹 화면이 보여준다.
//
//   node tools/watch.mjs           감시 시작 (WATCH_DIR, 기본: 프로젝트의 incoming/)
//   node tools/watch.mjs --once    한 번만 업데이트하고 종료
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = path.resolve(process.env.WATCH_DIR || path.join(ROOT, 'incoming'));
const STATUS = path.join(ROOT, 'data', 'watch-status.json');
const BATCH_STATE = path.join(ROOT, 'data', 'batch.json');
const DEBOUNCE_MS = 3000;         // 복사가 끝날 때까지 기다리는 시간
const BATCH_POLL_MS = 120_000;
const once = process.argv.includes('--once');

fs.mkdirSync(WATCH, { recursive: true });

let status = { state: 'idle', message: '대기 중', watchDir: WATCH, log: [] };
function setStatus(patch, logLine) {
  status = { ...status, ...patch, updatedAt: new Date().toISOString() };
  if (logLine) {
    status.log = [...status.log, `${new Date().toLocaleTimeString('ko-KR')} ${logLine}`].slice(-20);
    console.log(logLine);
  }
  fs.writeFileSync(STATUS + '.tmp', JSON.stringify(status, null, 1));
  fs.renameSync(STATUS + '.tmp', STATUS);
}

function run(cmd, args) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      const last = out.trim().split('\n').pop() || '';
      let json = null;
      try { json = JSON.parse(last); } catch { /* 마지막 줄이 JSON 이 아닌 명령도 있다 */ }
      resolve({ code, out, err, json });
    });
  });
}

let running = false, again = false;
async function update() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      setStatus({ state: 'scanning', message: '새 파일 확인 중…' });
      const ing = await run('python', ['tools/ingest.py', WATCH]);
      if (ing.code !== 0 || !ing.json) {
        setStatus({ state: 'error', message: '추출 실패' }, `추출 실패: ${ing.err.trim().split('\n').pop()}`);
        continue;
      }
      const { added, updated, removed } = ing.json;
      if (added.length || updated.length || removed.length) {
        setStatus({}, `추가 ${added.length} · 변경 ${updated.length} · 삭제 ${removed.length}`);
      }
      if (added.length || updated.length) {
        setStatus({ state: 'rendering', message: `썸네일 만드는 중 (${added.length + updated.length}개)…` });
        const r = await run('node', ['tools/render.mjs']);
        if (r.code !== 0) setStatus({}, `썸네일 실패: ${r.err.trim().split('\n').pop()}`);
      }
      setStatus({ state: 'labeling', message: 'AI 라벨링 확인 중…' });
      const lab = await run('node', ['tools/label.mjs', '--auto']);
      const j = lab.json || {};
      if (j.code === 2) {
        setStatus({ state: 'needs_batch', waiting: j.waiting, message: `${j.waiting}개가 한꺼번에 들어왔습니다. Batch 로 처리할까요? (50% 할인)` }, j.reason);
      } else if (j.code === 3) {
        setStatus({ state: 'batch', waiting: j.waiting, message: `배치 처리 중 — 끝나면 새 에셋 ${j.waiting}개도 이어서 라벨링합니다` });
      } else if (j.code === 4) {
        setStatus({ state: 'capped', waiting: j.waiting, message: `${j.reason}. ${j.waiting}개는 내일 이어서 합니다` }, j.reason);
      } else if (j.code === 5 || lab.code !== 0 && !j.code) {
        setStatus({ state: 'error', message: `라벨링 실패: ${j.reason || lab.err.trim().split('\n').pop()}` }, '라벨링 실패');
      } else {
        if (j.labeled) setStatus({}, `라벨링 ${j.labeled}개 완료 ($${j.spent})`);
        if (fs.existsSync(BATCH_STATE)) setStatus({ state: 'batch', waiting: 0, message: '배치 처리 중' });
        else setStatus({ state: 'idle', waiting: 0, message: '대기 중' });
      }
    } while (again);
  } finally {
    running = false;
  }
}

// 배치가 진행 중이면 주기적으로 결과를 받아온다
async function pollBatch() {
  if (!fs.existsSync(BATCH_STATE) || running) return;
  const r = await run('node', ['tools/label.mjs', '--collect']);
  const m = r.out.match(/processing: (\d+), succeeded: (\d+)/);
  if (fs.existsSync(BATCH_STATE)) {
    setStatus({ state: 'batch', message: m ? `배치 처리 중 (완료 ${m[2]} / 남음 ${m[1]})` : '배치 처리 중' });
  } else {
    setStatus({}, r.out.trim().split('\n').pop());
    update(); // 배치 동안 쌓인 새 에셋 처리
  }
}

await update();
if (once) process.exit(0);

let timer = null;
fs.watch(WATCH, { recursive: true }, (_, file) => {
  if (!file || file.endsWith('.tmp')) return;
  clearTimeout(timer);
  timer = setTimeout(update, DEBOUNCE_MS);
});
setInterval(pollBatch, BATCH_POLL_MS);
pollBatch();
console.log(`감시 중: ${WATCH}`);

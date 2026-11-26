// Rock Claim 验证批处理（项目级常驻脚本）
//
// 与 extract_claims_batch.py 对称的"验证侧"runner。抽取侧逐篇抽 claim 落库，
// 本侧逐条 claim 走 EvidenceService.verifyAgainstSource({claim_id}) —— TARGETED_SPAN
// 5 步反幻觉链（取存储 evidence → loadPaper 定位 span → 召回率反幻觉 → LLM 蕴含 →
// CORRECT/MISATTRIBUTED/BROKEN_CITATION），结果落 claim_verifications。
//
// 解决三个问题：
//   1. 没有批量验证脚本 → pi 只能逐条交互调 claim_verify（每次只能验一点量）
//   2. sensenova.ts 已加 IPv4 优先（ipv4first），消除 AAAA→Errno101 的 60s 超时
//   3. repository.ts 已加 busy_timeout=10000，撞锁等而非立即失败
//   4. 强制走 claim_id 模式（TARGETED_SPAN），不用最弱的 UNGUIDED 全库 RAG
//
// 用法:
//   node --experimental-strip-types --no-warnings verify_claims_batch.mjs <project_root> \
//     --project-id N [--limit N] [--no-llm]
//
//   <project_root>   项目根（含 paper-raw/ data/）
//   --project-id N    项目 ID（省略则按目录名查 projects 表）
//   --limit N         只验前 N 条（小测放量；省略=全部 active claim）
//   --no-llm          仅结构接地，不调 LLM 判官（默认调）
//
// 小测: node ... verify_claims_batch.mjs ~/Research-projects/rockburst --project-id 4 --limit 5
// 量跑: nohup node ... verify_claims_batch.mjs ~/Research-projects/rockburst --project-id 4 \
//         >> ~/Research-projects/rockburst/logs/claims_verify.log 2>&1 &
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── 项目根解析：位置参 > $ROCK_PROJECT_ROOT > cwd（绝不硬编码）──
const argv = process.argv.slice(2);
let projectRoot = null;
const idxLimit = argv.indexOf('--limit');
const idxPid = argv.indexOf('--project-id');
const useLlm = !argv.includes('--no-llm');
const LIMIT = idxLimit >= 0 ? parseInt(argv[idxLimit + 1], 10) : null;
const PROJECT_ID = idxPid >= 0 ? parseInt(argv[idxPid + 1], 10) : null;
for (const a of argv) {
  if (a.startsWith('-')) continue;
  // idxLimit/idxPid 为 -1 时 argv[idx+1]=argv[0] 会误吞位置参，故只在该 flag 存在时排除其值
  if (idxLimit >= 0 && a === argv[idxLimit + 1]) continue;
  if (idxPid >= 0 && a === argv[idxPid + 1]) continue;
  projectRoot = path.resolve(a); break;
}
projectRoot = projectRoot || process.env.ROCK_PROJECT_ROOT || process.cwd();
process.env.ROCK_PROJECT_ROOT = projectRoot;
process.chdir(projectRoot);

const DATA_DIR = path.join(projectRoot, 'data');
const LOG_DIR = path.join(projectRoot, 'logs');
const STATE_PATH = path.join(DATA_DIR, 'verify_batch_state.json');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

// ── 状态文件：断点续跑（done 集合 + failed 计数）──
function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch {}
  }
  return { done: [], failed: {} };
}
function saveState(s) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 1)); }

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(5, 19);
  const line = `[${ts}] ${msg}\n`;
  writeFileSync(path.join(LOG_DIR, 'claims_verify.log'), line, { flag: 'a' });
}

// ── 导入 rock-research 的 TS 模块（Node v24 类型剥离）──
const REPO_DIR = path.resolve(import.meta.dirname, '..', 'rock-research');
const { ResearchRepository } = await import(path.join(REPO_DIR, 'db', 'repository.ts'));
const { EvidenceService } = await import(path.join(REPO_DIR, 'services', 'evidence.ts'));

const repo = new ResearchRepository();
const projectId = PROJECT_ID;
if (projectId == null) {
  console.error('[verify-batch] 缺 --project-id N（查项目 ID：sqlite3 data/research.db '
    + '"SELECT id,name FROM projects"）');
  repo.close(); process.exit(1);
}

// active claim，按 id 升序（断点续跑稳定）
const allClaims = repo.getClaimsByProject(projectId)
  .filter(c => c.status === 'active')
  .sort((a, b) => a.id - b.id);
const state = loadState();
const done = new Set(state.done);
const failedSkip = new Set(Object.keys(state.failed).filter(k => state.failed[k] >= 2));
const todo = allClaims.filter(c => !done.has(c.id) && !failedSkip.has(String(c.id)));
const target = LIMIT ? todo.slice(0, LIMIT) : todo;

const total = allClaims.length;
const already = done.size;
console.log(`[verify-batch] project=${path.basename(projectRoot)} pid=${projectId} `
  + `claims=${total} done=${already} skipped=${failedSkip.size} todo=${todo.length}`
  + (LIMIT ? ` limit=${LIMIT}` : '') + ` use_llm=${useLlm}`);
log(`Start pid=${projectId} claims=${total} done=${already} todo=${todo.length}`
  + (LIMIT ? ` limit=${LIMIT}` : '') + ` use_llm=${useLlm}`);
if (target.length === 0) {
  console.log('[verify-batch] 无待验 claim（全部 done 或 skipped）');
  process.exit(0);
}

// 前台运行警告（和 extract_claims_batch.py 一致：逐条 LLM，可能数十分钟）
if (typeof process.stdin?.isatty === 'function' && process.stdin.isatty()) {
  console.log('[verify-batch] ⚠ 前台运行会逐条调 LLM（~3s/条，最坏 60s/条）。'
    + '建议 nohup ... >> logs/claims_verify.log 2>&1 &');
}

const svc = new EvidenceService(repo);
const verdictCount = {};
let processed = 0, okCount = 0, failCount = 0;

for (const claim of target) {
  const t0 = Date.now();
  let ok = false;
  try {
    const r = await svc.verifyAgainstSource({
      claim_id: claim.id, claim_text: claim.text, project_id: projectId, use_llm: useLlm,
    });
    verdictCount[r.verdict] = (verdictCount[r.verdict] || 0) + 1;
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const note = r.notes ? ` | ${String(r.notes).slice(0, 60)}` : '';
    log(`  #${claim.id} ${r.verdict} (${r.mode}) ${dur}s${note}`);
    console.log(`#${claim.id} ${r.verdict} (${r.mode}) ${dur}s` + note);
    ok = true; okCount++;
  } catch (e) {
    const msg = String(e?.message || e);
    log(`  #${claim.id} ERROR: ${msg.slice(0, 200)}`);
    console.log(`#${claim.id} ERROR: ${msg.slice(0, 120)}`);
    if (/locked/i.test(msg)) {
      // DB 锁是环境问题不是 claim 问题：退避重试，不计失败
      log('  db locked, 退避 60s 后重试本条');
      console.log('  db locked, 退避 60s');
      await new Promise(r => setTimeout(r, 60_000));
      continue;  // 不标 done，下轮再试本条
    }
    failCount++;
    const fid = String(claim.id);
    state.failed[fid] = (state.failed[fid] || 0) + 1;
    if (state.failed[fid] >= 2) {
      log(`  SKIP #${claim.id}: 连续失败 2 轮`);
      console.log(`  SKIP #${claim.id}: 连续失败 2 轮`);
    }
  }
  if (ok) {
    done.add(claim.id);
    state.failed[String(claim.id)] = undefined;
  }
  state.done = [...done].filter(x => state.failed[String(x)] == null);
  saveState(state);
  processed++;
  // 退避：避免 LLM 限流（sensenova-6.8-flash-lite 限流较松，2s 够）
  await new Promise(r => setTimeout(r, 2000));
}

log(`Done batch: processed=${processed} ok=${okCount} fail=${failCount} verdicts=${JSON.stringify(verdictCount)}`);
console.log(`\n[verify-batch] Done: processed=${processed} ok=${okCount} fail=${failCount}`);
console.log('[verify-batch] verdicts:', JSON.stringify(verdictCount, null, 2));
console.log(`[verify-batch] state: ${STATE_PATH}`);
repo.close();

// Rock RAG 重建独立 runner —— 绕开 pi TUI，直接调本目录自包含源码（不依赖 pi-local-rag npm 包）
// 用法: node --experimental-strip-types --no-warnings rag_rebuild.mjs [--smoke] [--clean] [--project <dir>]
//   --project <dir>  项目根（默认 $ROCK_PROJECT_ROOT || cwd）；绝不硬编码，换项目跑 --clean 才不会抹错库
//   --clean           rebuild 前清空 chunks/fts/vec/files（清孤儿 chunk；日常重建必带）
//   --smoke           只处理前 2 个目标，验证管线用
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 项目根：--project > $ROCK_PROJECT_ROOT > cwd。绝不硬编码——否则换项目跑 --clean
// 会抹掉别的项目的 rag.db。
const _projIdx = process.argv.indexOf('--project');
const ROOT = _projIdx >= 0 ? path.resolve(process.argv[_projIdx + 1])
  : (process.env.ROCK_PROJECT_ROOT || process.cwd());
process.chdir(ROOT);
const RAG_DB = path.join(ROOT, '.pi', 'rag', 'rag.db');
console.log(`[project] ${ROOT}`);
console.log(`[rag.db] ${RAG_DB}${existsSync(RAG_DB) ? '' : ' (将新建)'}`);

// 从本目录（./）导入 pi-local-rag 源码拷贝——自包含。rag_query.mjs 同样用 ./ 导入。
const { loadConfig, resolveExtensions } = await import('./config.ts');
const { indexFiles } = await import('./indexing.ts');
const { openDb, initSchema } = await import('./db.ts');

const cfg = loadConfig();
const exts = resolveExtensions(cfg);
console.log('[allowlist]', [...exts].join(' '));

const skipDirs = new Set(['.git', 'node_modules', '.pi', 'data', 'logs', 'plot',
  '.claude', '.cache', 'exports', '__pycache__', 'archive']);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDirs.has(e.name) && !e.name.startsWith('.')) walk(p, out);
    } else if (exts.has(path.extname(e.name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

const seen = new Set();
const files = [];
for (const tp of cfg.trackedPaths) {
  if (!existsSync(tp)) continue;
  // 单文件路径：直接加入（若扩展名在允许列表内）
  if (!fs.statSync(tp).isDirectory()) {
    if (exts.has(path.extname(tp).toLowerCase()) && !seen.has(tp)) { seen.add(tp); files.push(tp); }
    continue;
  }
  for (const f of walk(tp)) if (!seen.has(f)) { seen.add(f); files.push(f); }
}
// .pdf / .py 不进本次重建：paper-raw/*.json 是论文解析文本，
// PDF 原文重解析会拖慢数倍且与 JSON 内容重复；.py 是项目维护脚本，非论文内容
const targets = files.filter(f => {
    const lf = f.toLowerCase();
    return !lf.endsWith('.pdf') && !lf.endsWith('.py');
  })
  .sort((a, b) => a.localeCompare(b));
console.log(`[collect] allowlisted=${files.length}, pdf+py excluded, targets=${targets.length}`);

const smoke = process.argv.includes('--smoke');
const list = smoke ? targets.slice(0, 2) : targets;

// --clean：rebuild 前全表清空，彻底清除旧构建残留的孤儿 chunk（如 data/ 下的
// extract_batch_state.json / stress_strain.csv，walk 已排除但 delChunks
// 只删"列表内"文件，孤儿不在列表 → 普通 rebuild 永远清不掉）
if (!smoke && process.argv.includes('--clean')) {
  console.log(`[clean] 清空 ${RAG_DB} 的 chunks/fts/vec/files（rebuild 前彻底清孤儿）`);
  const cdb = openDb();
  cdb.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DELETE FROM chunks;
    DELETE FROM files;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks_vec;
  `);
  initSchema(cdb);   // 重建 fts/vec 虚表 + 触发器
  cdb.close();
  console.log('[clean] wiped chunks / chunks_fts / chunks_vec / files');
}

let lastEmbedLog = 0;
const t0 = Date.now();
const result = await indexFiles(list, {
  onFile: (c, t, name, skipped) => console.log(`[file ${c}/${t}] ${skipped ? 'SKIP' : 'OK'} ${name}`),
  onEmbed: (done, total) => {
    if (done - lastEmbedLog >= 2000 || done === total) {
      lastEmbedLog = done;
      console.log(`[embed] ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  },
});
console.log('[result]', JSON.stringify(result));

// 校验
const db = openDb();
const q = (sql) => db.prepare(sql).get();
console.log('[verify] chunks =', q('SELECT COUNT(*) c FROM chunks').c,
  '| files =', q('SELECT COUNT(*) c FROM files').c,
  '| vec =', (() => { try { return db.prepare('SELECT COUNT(*) c FROM chunks_vec').get().c; } catch (e) { return 'ERR:' + e.message; } })());
const sample = db.prepare('SELECT rowid, embedding FROM chunks_vec LIMIT 1').get();
if (sample) {
  const dim = sample.embedding.length / 4;
  console.log('[verify] vec dim =', dim, dim === 384 ? '(OK)' : '(维度异常!)');
}
db.close();
console.log(smoke ? 'SMOKE-DONE' : 'ALL-DONE');

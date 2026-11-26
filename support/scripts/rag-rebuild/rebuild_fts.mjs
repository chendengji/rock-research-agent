// rebuild_fts.mjs — 用 trigram tokenizer 重建 chunks_fts（中文检索修复），不重跑向量嵌入
// 用法: node --experimental-strip-types --no-warnings rebuild_fts.mjs [projectRoot]
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const ROOT = process.argv[2] || process.env.ROCK_PROJECT_ROOT || process.cwd();
const RAG_DB = path.join(ROOT, '.pi', 'rag', 'rag.db');
if (!existsSync(RAG_DB)) { console.error('no rag.db:', RAG_DB); process.exit(1); }
const { openDb, initSchema } = await import('./db.ts');
const db = openDb(path.join(ROOT, '.pi', 'rag'));
console.log('[db]', RAG_DB);
// 1. 旧 fts 及触发器
db.exec(`
  DROP TRIGGER IF EXISTS chunks_ai;
  DROP TRIGGER IF EXISTS chunks_ad;
  DROP TABLE IF EXISTS chunks_fts;
`);
console.log('[clean] dropped chunks_fts + triggers');
// 2. 重建 trigram fts + 触发器（initSchema 内建 chunks_fts tokenize=trigram）
initSchema(db);
console.log('[init] recreated chunks_fts (trigram)');
// 3. 从 chunks 表重插填充（直接插 fts，不触发 chunks 触发器）
const n = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;
console.log('[fill] chunks rows =', n);
db.exec('BEGIN');
try {
  db.prepare('INSERT INTO chunks_fts(rowid, chunk_content, file_path) SELECT rowid, chunk_content, file_path FROM chunks').run();
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
// 4. 验证
const fc = db.prepare('SELECT COUNT(*) c FROM chunks_fts').get().c;
console.log('[verify] chunks_fts =', fc);
const hit = db.prepare("SELECT COUNT(*) c FROM chunks_fts WHERE chunks_fts MATCH '浸水深度'").get().c;
console.log("[verify] MATCH 浸水深度 =", hit);
const bm = db.prepare("SELECT bm25(chunks_fts) b FROM chunks_fts WHERE chunks_fts MATCH '浸水深度' LIMIT 1").get();
console.log('[verify] bm25 sample =', bm ? bm.b : null);
db.close();
console.log('FTS-REBUILD-DONE');

// rag_query.mjs — RAG 检索 CLI，claim_verify 无靶模式用它取候选原文段。
//
// 为什么独立进程而非在 pi 工具内直接调：pi 进程内 ONNX 嵌入会静默挂起，
// 故用 `node --experimental-strip-types` 独立跑（与 rag-rebuild runner 同理），
// 复用本目录的 search.ts (hybridSearch) 与 db.ts (openDb)，不重造 embedder。
//
// 用法: node --experimental-strip-types --no-warnings rag_query.mjs <query> [projectRoot] [limit] [alpha]
// 输出: stdout 一行 JSON 数组 [{file,content,lineStart,lineEnd,score,bm25,vector}, ...]
//       失败时 stdout 输出 {"error":"..."} 并 exit 1，stderr 打诊断。
//
import { existsSync } from "node:fs";
import { join } from "node:path";

const query = process.argv[2] ?? "";
const projectRoot = process.argv[3] || process.env.ROCK_PROJECT_ROOT || process.cwd();
const limit = parseInt(process.argv[4] ?? "5", 10);
const alpha = parseFloat(process.argv[5] ?? "0.6");

function die(msg) {
  process.stdout.write(JSON.stringify({ error: msg }));
  process.exit(1);
}

if (!query) die("no query");
if (query === "-h" || query === "--help") {
  process.stdout.write("用法: node rag_query.mjs <query> [projectRoot] [limit] [alpha]\n  默认 projectRoot=$ROCK_PROJECT_ROOT||cwd, limit=5, alpha=0.4\n  无索引返回 {no_index:true,...}；有索引零命中返回 []\n");
  process.exit(0);
}
const ragDir = join(projectRoot, ".pi", "rag");
if (!existsSync(join(ragDir, "rag.db"))) {
  // 无索引——返回 no_index 哨兵（区别于"有索引零命中"的 []）；paper_search 据此提示重建
  process.stdout.write(JSON.stringify({ no_index: true, ragDir, error: "no rag.db; 重建：node --experimental-strip-types --no-warnings ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean" }));
  process.exit(0);
}

// 指向项目级 rag.db（getRagDir 优先读 PI_RAG_DIR）
process.env.PI_RAG_DIR = ragDir;

let db;
try {
  const { openDb } = await import("./db.ts");
  const { hybridSearch } = await import("./search.ts");
  db = openDb();
  const hits = await hybridSearch(query, {} /*unused _index*/, limit, alpha, db);
  const out = hits.map(h => ({
    file: h.chunk.file,
    // content 含 JSON 片段噪声；截断到 2000 字足够 locateChunkPage 定位页，又避免 stdout 爆量
    content: h.chunk.content.length > 2000 ? h.chunk.content.slice(0, 2000) : h.chunk.content,
    lineStart: h.chunk.lineStart,
    lineEnd: h.chunk.lineEnd,
    score: Number(h.hybrid.toFixed(4)),
    bm25: Number(h.bm25.toFixed(4)),
    vector: Number(h.vector.toFixed(4)),
  }));
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stderr.write(`[rag_query] ${e.stack || e.message}\n`);
  die("rag query failed: " + (e.message || String(e)));
} finally {
  try { db?.close(); } catch {}
}

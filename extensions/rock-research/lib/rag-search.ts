/**
 * rag-search.ts — claim_verify 无靶模式的 RAG 检索桥。
 *
 * 通过子进程调 scripts/rag-rebuild/rag_query.mjs（独立 node + strip-types），
 * 避开 pi 进程内 ONNX 嵌入挂起问题。带 HF 镜像环境，首次嵌入模型下载走 hf-mirror。
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// rock-research/lib/ → rock-research/ → extensions/ → 包根 rock-research-agent/ → support/scripts/rag-rebuild/rag_query.mjs
// （按 import.meta.url 相对定位，不写死用户/磁盘路径，支持移植）
const RAG_QUERY_SCRIPT = join(__dirname, "..", "..", "..", "support", "scripts", "rag-rebuild", "rag_query.mjs");

/** HF 镜像仅作默认值（HF_ENDPOINT 未显式设置时才使用，海外环境可自行覆盖） */
const HF_MIRROR = "https://hf-mirror.com";

export interface RagHit {
  file: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  bm25: number;
  vector: number;
}

const TIMEOUT_MS = 120_000;

/** 调 RAG 检索；失败/超时/无索引均返回空数组（上层据此判 NO_SUPPORT_FOUND）。 */
export function ragSearch(query: string, projectRoot: string, limit = 5): Promise<RagHit[]> {
  if (!existsSync(RAG_QUERY_SCRIPT)) {
    return Promise.reject(new Error(`rag_query.mjs not found at ${RAG_QUERY_SCRIPT}`));
  }
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--experimental-strip-types", "--no-warnings", RAG_QUERY_SCRIPT, query, projectRoot, String(limit)],
      {
        env: {
          ...process.env,
          ...(process.env.HF_ENDPOINT ? {} : { HF_ENDPOINT: HF_MIRROR, HF_HUB_ENDPOINT: HF_MIRROR }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve([]);
    }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

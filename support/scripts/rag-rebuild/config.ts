import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configFile, getRagDir } from "./store.ts";
import { DEFAULT_TEXT_EXTS } from "./constants.ts";

export interface RagConfig {
  // ragEnabled 是 pi-local-rag 包的遗留开关（控制是否自动嵌入），
  // 本自包含脚本从不检查它——RAG 检索走 paper_search 工具 + rag_query.mjs 子进程。
  // 若项目 config.json 残留此字段，会在 loadConfig() 合并后成为无类型定义的多余属性（无害）。
  ragTopK: number;
  ragScoreThreshold: number;
  ragAlpha: number; // 0 = pure vector, 1 = pure BM25
  extraExtensions: string[];   // user-added file extensions (e.g. [".cs", ".tex"])
  excludeExtensions: string[]; // extensions to drop from the default set
  trackedPaths: string[];      // absolute paths to index (passed to rag_rebuild.mjs --project)
  excludePatterns: string[];   // gitignore-style path patterns
}

export function defaultConfig(): RagConfig {
  return {
    ragTopK: 5, ragScoreThreshold: 0.1, ragAlpha: 0.4,
    extraExtensions: [], excludeExtensions: [],
    trackedPaths: [], excludePatterns: [],
  };
}

export function loadConfig(): RagConfig {
  const cfgFile = configFile(getRagDir());
  if (!existsSync(cfgFile)) return defaultConfig();
  try {
    return { ...defaultConfig(), ...JSON.parse(readFileSync(cfgFile, "utf-8")) };
  } catch { return defaultConfig(); }
}

export function saveConfig(config: RagConfig) {
  writeFileSync(configFile(getRagDir()), JSON.stringify(config, null, 2));
}

/** Normalize a user-supplied extension to lowercase ".ext" form. */
export function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** Build the effective extension allowlist from defaults + user config. */
export function resolveExtensions(config: Pick<RagConfig, "extraExtensions" | "excludeExtensions">): Set<string> {
  const set = new Set(DEFAULT_TEXT_EXTS);
  for (const e of config.extraExtensions) {
    const n = normalizeExt(e);
    if (n) set.add(n);
  }
  for (const e of config.excludeExtensions) {
    const n = normalizeExt(e);
    if (n) set.delete(n);
  }
  return set;
}

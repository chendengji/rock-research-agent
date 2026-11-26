/**
 * rock-research — Pi Extension for Research Core
 *
 * Factory function pattern matching Pi's extension API.
 * Registers 24 tools for claim/evidence/idea/hypothesis/memory management
 * (paper_search, paper_read, claim_verify, claim_save, claim_compare,
 *  claim_evolve, claim_supersede, conflict_analyze, evidence_trace,
 *  idea_save, idea_search, hypothesis_save, hypothesis_search, hypothesis_status,
 *  research_analyze, project_context, research_plot,
 *  memory_map, memory_search, memory_get, memory_reindex  ← 本地 SQLite 记忆库（lib/pi-memory.ts，分级主动检索）
 *  memory_add, memory_dream, memory_dedup                  ← 记忆写入闭环（lib/pi-dream.ts，暂存→会话蒸馏→分类沉淀）
 * ).
 *
 * 记忆只走本地 SQLite 记忆库（~/.pi/memory-data/pi_memory.db）。
 * 旧的 Synapse 跨会话记忆工具（memory_save / memory_retrieve）已移除：
 * 本机未安装 synapse-os，桥接进程永远起不来，两个工具只会返回失败。
 *
 * 记忆写入闭环（memory_add / memory_dream / memory_dedup）：
 *   memory_add 把 agent 主动记忆追加到 <root>/inbox/<日期>.md（不进索引）；
 *   memory_dream 四阶段沉淀：抽取当天会话原文 → 子进程调 SenseNova LLM 蒸馏 →
 *   按 kind 写 dream/ 源目录 → 报告 + scanAndIndex 增量重建 → inbox 归档。
 *   一个日期只 dream 一次（日期级幂等，元数据 dreamed_dates 记录），
 *   重跑同一天默认直接拒绝，需 force=true 覆盖——同一天反复蒸馏会产出
 *   措辞不同的近重复条目，标题去重与正文 Jaccard 都抓不住这类。
 *   memory_dedup 是维护工具：对 dream/ 做近似去重（正文 Jaccard 聚簇），
 *   把重复条目移入 .retired/dream-dedup-<时间戳>/（可恢复，不删除），
 *   之后需再跑一次 memory_reindex 让库里同步移除。
 * MEMORY.md 与 user_facts/ 已废弃（pi 本身不读 MEMORY.md，只读 AGENTS.md/CLAUDE.md），
 * tier 0 改由 dream/user_facts/ 承担。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getRepo } from "./tools/shared.ts";
import { researchPlotTool } from "./tools/research_plot.ts";

function trunc(s: string | null | undefined, n = 200): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── lazy import 缓存 ──
// pi 扩展环境对同一 .ts 模块的并发动态 import 存在竞态：多个工具并行
// `await import()` 同一模块时，命名空间对象可能尚未绑定就返回，导致
// "EvidenceService is not a constructor" 这类错误。首次 import 后缓存
// Promise，并发调用共享同一个已解析模块实例，避免重复触发 loader 竞态。
const _importCache = new Map<string, Promise<any>>();
function lazyImport<T = any>(spec: string): Promise<T> {
  if (!_importCache.has(spec)) {
    _importCache.set(spec, import(spec));
  }
  return _importCache.get(spec) as Promise<T>;
}

export default function (pi: ExtensionAPI) {
  // ── paper_search ──（论文级 RAG 检索；走外部进程免 pi 内嵌入挂死）
  pi.registerTool({
    name: "paper_search",
    label: "Paper Search",
    description: "按 query 检索本地 RAG 索引，返回论文级结果（标题/页/片段/分）。走外部进程（rag_query.mjs），避开 pi 内 ONNX 嵌入挂死。要原始 chunk 级结果可用命令行 rag_query.mjs（见 support/scripts/rag-rebuild/）。无命中时提示用 rag-rebuild runner 重建索引。",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ default: 10, description: "Max results" })),
    }),
    execute: async (_id: string, params: { query: string; limit?: number }) => {
      const projectRoot = process.env.ROCK_PROJECT_ROOT || process.cwd();
      const limit = params.limit ?? 10;
      const { ragSearch } = await lazyImport("./lib/rag-search.ts");
      const { loadPaper, locateChunkPage, windowText, normalize } = await lazyImport("./lib/paper-text.ts");
      const hits = await ragSearch(params.query, projectRoot, limit * 3);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ query: params.query, total: 0,
          note: "无 RAG 命中（项目无 .pi/rag/rag.db、索引为空或检索超时）；用 rag-rebuild runner 重建索引" }) }] };
      }
      // 按论文聚合：每篇只保留最高分 chunk（去重同一论文多 chunk）
      const byPaper = new Map<string, any>();
      for (const h of hits) {
        const paper = h.file.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
        const cur = byPaper.get(paper);
        if (!cur || h.score > cur.score) byPaper.set(paper, h);
      }
      const aggHits = [...byPaper.values()].sort((a, b) => b.score - a.score).slice(0, limit);
      const results = aggHits.map(h => {
        const doc = loadPaper(h.file);
        const paper = h.file.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
        const title = doc?.title || paper;
        let page: number | null = null;
        let snippet = trunc(normalize(h.content), 200);
        if (doc) {
          const loc = locateChunkPage(doc, h.content);
          if (loc.page != null) page = loc.page;
          if (loc.text) snippet = trunc(windowText(loc.text, h.content), 200);
        }
        return { paper, title, page, score: h.score, snippet };
      });
      return { content: [{ type: "text", text: JSON.stringify({ query: params.query,
        total: results.length, results }, null, 2) }] };
    },
  });

  // ── paper_read ──（默认返回结构化摘要，full=true 才返回完整 JSON——避免上百 KB JSON 灌爆 LLM 上下文）
  pi.registerTool({
    name: "paper_read",
    label: "Paper Read",
    description: "读论文结构。默认返回结构化摘要（标题/作者/年份/摘要/章节目录+页范围/页数/参考文献数/text_quality）；path 用 paper_search 命中结果的 paper 字段（不带 .pdf/.json）。full=true 才返回完整解析 JSON（大，慎用）。读不到时提示先 ingest_pdf.py 入库。",
    parameters: Type.Object({
      path: Type.String({ description: "论文文件路径或名（不带 .pdf；用 paper_search 命中的 paper 字段）" }),
      full: Type.Optional(Type.Boolean({ description: "true=返回完整解析 JSON（默认 false 返回摘要）" })),
    }),
    execute: async (_id: string, params: { path: string; full?: boolean }) => {
      const base = join(process.env.ROCK_PROJECT_ROOT || process.cwd(), "paper-raw");
      const stem = params.path.replace(/\.pdf$/i, "").replace(/\.json$/i, "");
      const tryRead = (p: string) => {
        try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
      };
      // 1. 平铺：paper-raw/{stem}.json
      let d = tryRead(join(base, `${stem}.json`));
      // 2. 子分类：扫描 paper-raw/ 下所有一级子目录（不写死分类名单，目录有则覆盖）
      if (!d) {
        try {
          const subs = readdirSync(base, { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name);
          for (const sub of subs) {
            d = tryRead(join(base, sub, `${stem}.json`));
            if (d) break;
          }
        } catch { /* base 不存在则走 not_found */ }
      }
      if (!d) return { content: [{ type: "text", text: JSON.stringify({ status: "not_found",
        message: `No parsed cache for "${params.path}" under ${base}. Run ingest_pdf.py first.` }) }] };
      if (params.full) return { content: [{ type: "text", text: JSON.stringify(d, null, 2) }] };
      // 摘要：关键字段 + 章节目录，不灌正文
      const summary: any = {
        title: d.title ?? null,
        authors: d.authors ?? null,
        year: d.year ?? null,
        abstract: trunc(d.abstract, 600),
        num_pages: d.num_pages ?? (Array.isArray(d.pages) ? d.pages.length : null),
        sections: Array.isArray(d.sections) ? d.sections.map((s: any) => ({
          title: s.title, level: s.level, page_start: s.page_start, page_end: s.page_end,
          has_text: !!(s.text && s.text.trim()),
        })) : null,
        references_count: Array.isArray(d.references) ? d.references.length : null,
        extraction_method: d.extraction_method ?? null,
        text_quality: d.text_quality ?? null,
        hint: "要读某页/章节原文片段，用 paper_search 检索；要完整 JSON 传 full=true",
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  });

  // ── claim_verify ──（引用接地验证：回原文 5 步链）
  pi.registerTool({
    name: "claim_verify",
    label: "Claim Verify",
    description: "引用接地验证：回原文比对 claim 是否被源文真实支持（不是库内权重循环确认）。验已抽取的 claim 必传 claim_id（走 TARGETED_SPAN 反幻觉链）——这是唯一能查出抽取器是否幻觉引用的模式；仅传 claim_text 走 UNGUIDED 全库 RAG 弱模式，只在无 claim_id 时用；cited_file 可直接验证某篇被引论文（TARGETED_FILE）。verdict：有靶 CORRECT/MISATTRIBUTED/BROKEN_CITATION/PAGE_MISATTRIBUTED/SPAN_CONFIRMED；无靶 SUPPORTED_BY/CONTRADICTED_BY/NO_SUPPORT_FOUND。验证历史落 claim_verifications。",
    parameters: Type.Object({
      claim_text: Type.Optional(Type.String({ description: "Claim statement（仅当无 claim_id 时必填，走 UNGUIDED 弱模式）" })),
      claim_id: Type.Optional(Type.Number({ description: "【推荐】验已抽取 claim 时必传：走 TARGETED_SPAN 反幻觉链" })),
      cited_file: Type.Optional(Type.String({ description: "TARGETED_FILE：claim 引用的论文路径/名" })),
      project_id: Type.Optional(Type.Number({ description: "项目 ID（见 project_context，不确定可省略）" })),
      use_llm: Type.Optional(Type.Boolean({ description: "是否调 LLM 判官做语义比对（默认 auto：有 SenseNova key 则用）" })),
      top_k: Type.Optional(Type.Number({ description: "无靶 RAG 命中数（默认 5）" })),
    }),
    execute: async (_id: string, params: any) => {
      const claim_text = params.claim_text ?? "";
      if (!claim_text && !params.claim_id) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "需提供 claim_text 或 claim_id" }) }] };
      }
      try {
        const { EvidenceService } = await lazyImport("./services/evidence.ts");
        const svc = new EvidenceService(getRepo());
        const result = await svc.verifyAgainstSource({
          claim_text,
          claim_id: params.claim_id,
          cited_file: params.cited_file,
          project_id: params.project_id,
          use_llm: params.use_llm,
          top_k: params.top_k,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({
          error: "claim_verify 执行失败: " + (e?.message || String(e)),
          hint: "TARGETED_SPAN 模式依赖 paper-raw/ 解析缓存与 RAG 子进程（rag_query.mjs）；检查项目是否已入库并建索引" }) }] };
      }
    },
  });

  // ── claim_save ──
  pi.registerTool({
    name: "claim_save",
    label: "Claim Save",
    description: "交互式记录一条 Claim（可选附带 Evidence）。用于分析时沉淀发现，区别于批量抽取脚本(extract_claims_batch.py)的自动化产出。",
    parameters: Type.Object({
      text: Type.String({ description: "Claim statement" }),
      project_id: Type.Optional(Type.Number({ description: "项目 ID（见 project_context，不确定可省略）" })),
      claim_type: Type.Optional(Type.String({ description: "observation|interpretation|generalization|mechanism|method|result|limitation" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0-1, default 0.5" })),
      ev_text_span: Type.Optional(Type.String({ description: "附 Evidence：引用原文" })),
      ev_file_path: Type.Optional(Type.String({ description: "附 Evidence：源 PDF 路径" })),
      ev_page: Type.Optional(Type.Number()),
      ev_section: Type.Optional(Type.String()),
      ev_type: Type.Optional(Type.String({ description: "direct|supporting|contradicting|indirect|contextual" })),
      ev_strength: Type.Optional(Type.Number()),
    }),
    execute: async (_id: string, params: any) => {
      const r = getRepo();
      const claim = r.createClaim({
        project_id: params.project_id,
        text: params.text,
        claim_type: params.claim_type,
        confidence: params.confidence,
      });
      let evidence_id: number | null = null;
      if (params.ev_text_span || params.ev_file_path) {
        const ev = r.addEvidence({
          claim_id: claim.id,
          file_path: params.ev_file_path,
          page: params.ev_page,
          section: params.ev_section,
          text_span: params.ev_text_span,
          evidence_type: params.ev_type,
          strength: params.ev_strength,
        });
        evidence_id = ev.id;
      }
      return { content: [{ type: "text", text: JSON.stringify({
        claim_id: claim.id, status: "saved", evidence_id, created_at: claim.created_at }) }] };
    },
  });

  // ── claim_compare ──
  pi.registerTool({
    name: "claim_compare",
    label: "Claim Compare",
    description: "Compare multiple claims to find relations (supports / contradicts / qualifies / refines)",
    parameters: Type.Object({
      claim_ids: Type.Array(Type.Number(), { description: "Two or more claim IDs to compare" }),
    }),
    execute: async (_id: string, params: { claim_ids: number[] }) => {
      const r = getRepo();
      const claims = params.claim_ids.map(id => r.getClaim(id)).filter(Boolean);
      const seen = new Set<string>();
      const relations: any[] = [];
      for (const cid of params.claim_ids) {
        for (const rel of r.getClaimRelations(cid)) {
          // 同一条关系双端都在集合内时会被两遍命中，按 (source,target,relation) 去重
          const key = `${rel.source_id}-${rel.target_id}-${rel.relation}`;
          if (!(params.claim_ids.includes(rel.source_id) && params.claim_ids.includes(rel.target_id))) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          const src = r.getClaim(rel.source_id);
          const tgt = r.getClaim(rel.target_id);
          relations.push({ source_text: trunc(src?.text, 100), target_text: trunc(tgt?.text, 100),
            relation: rel.relation, rationale: rel.rationale });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({
        claims: claims.map(c => ({ id: c!.id, text: trunc(c!.text, 150), confidence: c!.confidence, status: c!.status })),
        relations, has_conflict: relations.some(r => r.relation === "contradicts") }, null, 2) }] };
    },
  });

  // ── claim_evolve ──（演化追踪：claim 的前驱/后继/refine 历史链 + 当前 verdict）
  pi.registerTool({
    name: "claim_evolve",
    label: "Claim Evolution",
    description: "追踪一条 claim 的演化历史：取代了哪条旧 claim、被哪条新 claim 取代、refine/qualify 关系，及当前 verdict 与声明年龄。用于追踪认识随新证据的演变。",
    parameters: Type.Object({
      claim_id: Type.Number({ description: "要查演化链的 claim ID" }),
    }),
    execute: async (_id: string, params: { claim_id: number }) => {
      const { EvolutionService } = await lazyImport("./services/evolution.ts");
      const evo = new EvolutionService(getRepo());
      const result = evo.getEvolution(params.claim_id);
      if (!result) return { content: [{ type: "text", text: JSON.stringify({ error: "Claim not found" }) }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  });

  // ── claim_supersede ──（用新声明取代旧 claim，标记旧为 superseded）
  pi.registerTool({
    name: "claim_supersede",
    label: "Claim Supersede",
    description: "用一条新声明取代旧 claim：创建新 claim（supersedes_id 指向旧）、把旧 claim 标记为 superseded、记录 supersedes 关系。用于新证据修正旧认识时。",
    parameters: Type.Object({
      old_claim_id: Type.Number({ description: "被取代的旧 claim ID" }),
      new_text: Type.String({ description: "取代旧 claim 的新声明文本" }),
      project_id: Type.Optional(Type.Number({ description: "新 claim 所属项目（默认沿用旧 claim 的）" })),
      evidence_id: Type.Optional(Type.Number({ description: "触发取代的 evidence ID（记入 rationale）" })),
    }),
    execute: async (_id: string, params: any) => {
      const { EvolutionService } = await lazyImport("./services/evolution.ts");
      const evo = new EvolutionService(getRepo());
      try {
        const newClaim = evo.supersede(params.old_claim_id, params.new_text,
          params.project_id, params.evidence_id);
        return { content: [{ type: "text", text: JSON.stringify({
          new_claim_id: newClaim.id, superseded_old_claim_id: params.old_claim_id,
          status: "superseded", new_claim_created_at: newClaim.created_at }) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
      }
    },
  });

  // ── evidence_trace ──
  pi.registerTool({
    name: "evidence_trace",
    label: "Evidence Trace",
    description: "Trace a claim's evidence provenance: claim -> evidence list (source file, page, section, quoted text) + 接地验证历史（claim_verify 落库的历次 verdict）。反向按论文查证据请直接用 SQLite 查 evidence 表（evidence 无 paper_id 字段填充）。",
    parameters: Type.Object({
      claim_id: Type.Number({ description: "Claim ID to trace evidence for" }),
    }),
    execute: async (_id: string, params: { claim_id: number }) => {
      const r = getRepo();
      {
        const claim = r.getClaim(params.claim_id);
        const evidence = r.getEvidenceForClaim(params.claim_id);
        const verifications = r.getVerificationsForClaim(params.claim_id);
        return { content: [{ type: "text", text: JSON.stringify({ claim: claim ? { id: claim.id,
          text: trunc(claim.text, 200), confidence: claim.confidence } : null,
          evidence: evidence.map(e => ({ file_path: e.file_path, page: e.page, section: e.section,
            text_span: trunc(e.text_span, 200), type: e.evidence_type, strength: e.strength })),
          total_evidence: evidence.length,
          verifications: verifications.map(v => ({ id: v.id, verdict: v.verdict, mode: v.mode,
            judge_model: v.judge_model, cited_file: v.cited_file ? trunc(v.cited_file, 80) : null,
            cited_page: v.cited_page, notes: trunc(v.notes, 150), created_at: v.created_at })),
          total_verifications: verifications.length }, null, 2) }] };
      }
    },
  });

  // ── idea_save ──
  pi.registerTool({
    name: "idea_save",
    label: "Idea Save",
    description: "Save a research idea with provenance (source claims, rationale, scores)",
    parameters: Type.Object({
      text: Type.String({ description: "Idea description" }),
      project_id: Type.Optional(Type.Number({ description: "项目 ID（见 project_context，不确定可省略）" })),
      source_claims: Type.Optional(Type.Array(Type.Number(), { description: "Source claim IDs" })),
      rationale: Type.Optional(Type.String({ description: "Why this idea" })),
      novelty: Type.Optional(Type.Number({ description: "Novelty score 0-1" })),
      plausibility: Type.Optional(Type.Number({ description: "Plausibility score 0-1" })),
    }),
    execute: async (_id: string, params: any) => {
      const r = getRepo();
      const idea = r.createIdea({
        project_id: params.project_id, text: params.text,
        source_claims: params.source_claims, rationale: params.rationale,
        novelty: params.novelty, plausibility: params.plausibility,
      });
      return { content: [{ type: "text", text: JSON.stringify({ idea_id: idea.id,
        status: "saved", created_at: idea.created_at }) }] };
    },
  });

  // ── idea_search ──
  pi.registerTool({
    name: "idea_search",
    label: "Idea Search",
    description: "Search for research ideas by query text",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      project_id: Type.Optional(Type.Number({ description: "项目 ID（见 project_context，可省略查全库）" })),
    }),
    execute: async (_id: string, params: { query: string; project_id?: number }) => {
      const r = getRepo();
      const ideas = r.searchIdeas(params.query, params.project_id);
      return { content: [{ type: "text", text: JSON.stringify({
        ideas: ideas.map(i => ({ id: i.id, text: trunc(i.text, 200),
          novelty: i.novelty, plausibility: i.plausibility, status: i.status, created_at: i.created_at })),
        total: ideas.length }, null, 2) }] };
    },
  });

  // ── research_analyze ──
  pi.registerTool({
    name: "research_analyze",
    label: "Research Analyze",
    description: "Analyze a research topic with FAST / NORMAL / DEEP modes (consensus, conflicts, gaps, ideas)",
    parameters: Type.Object({
      topic: Type.String({ description: "Research topic or question" }),
      mode: Type.Optional(Type.String({ default: "normal", description: "分析深度：fast / normal / deep（大小写均可；FAST 快速回顾 / NORMAL 一般分析 / DEEP 深度调研）" })),
      project_id: Type.Optional(Type.Number({ description: "项目 ID（见 project_context，不确定可省略）" })),
    }),
    execute: async (_id: string, params: { topic: string; mode?: string; project_id?: number }) => {
      const r = getRepo();
      const raw = (params.mode || "normal").toLowerCase();
      const mode = (["fast", "normal", "deep"].includes(raw) ? raw : "normal") as "fast" | "normal" | "deep";
      // 委托 ReasoningService.synthesize：consensus + conflicts(含可能原因) + gaps + hypotheses + ideas + 标签
      const { ReasoningService } = await lazyImport("./services/reasoning.ts");
      const reasoning = new ReasoningService(r);
      const synth = reasoning.synthesize(params.topic, params.project_id, mode);
      r.logSession({ project_id: params.project_id, query: params.topic, mode,
        summary: `${synth.consensus.length} consensus, ${synth.conflicts.length} conflicts, ${synth.gaps.length} gaps`,
        claim_ids: [] });
      return { content: [{ type: "text", text: JSON.stringify(synth, null, 2) }] };
    },
  });

  // ── conflict_analyze ──（冲突簇分析：用 ConflictService，判定 CONSENSUS/CONTESTED）
  pi.registerTool({
    name: "conflict_analyze",
    label: "Conflict Analyze",
    description: "分析一组 claim 之间的冲突：建冲突簇、计算支持/反对平衡、列出岩石力学常见冲突原因（应力路径/岩性/破坏准则/围压范围）、判定 CONSENSUS / CONTESTED / INSUFFICIENT_EVIDENCE。",
    parameters: Type.Object({
      claim_ids: Type.Array(Type.Number(), { description: "要分析冲突的 claim ID 数组（2 个或以上）" }),
      topic: Type.Optional(Type.String({ description: "冲突主题（标注用）" })),
    }),
    execute: async (_id: string, params: { claim_ids: number[]; topic?: string }) => {
      const { ConflictService } = await lazyImport("./services/conflict.ts");
      const cs = new ConflictService(getRepo());
      const cluster = cs.buildConflictCluster(params.claim_ids, params.topic || "conflict analysis");
      const status = cs.summarizeStatus(cluster);
      return { content: [{ type: "text", text: JSON.stringify({
        status, support_balance: cluster.support_balance,
        relations: cluster.relations.map(r => ({ source: r.source_id, target: r.target_id,
          relation: r.relation, rationale: trunc(r.rationale, 120) })),
        possible_reasons: cluster.possible_reasons,
        claim_ids: cluster.claim_ids }, null, 2) }] };
    },
  });

  // ── hypothesis_save ──（保存可检验假设：声明+预测+可观测+实验+证伪条件）
  pi.registerTool({
    name: "hypothesis_save",
    label: "Hypothesis Save",
    description: "保存一个可检验的研究假设（Hypothesis）：声明 + 预测 + 可观测指标 + 实验设计 + 证伪条件。比 idea 更进一步，要求可证伪。可选关联来源 idea_id。",
    parameters: Type.Object({
      statement: Type.String({ description: "假设声明（可检验的陈述）" }),
      prediction: Type.Optional(Type.String({ description: "假设成立时应观测到什么" })),
      observable: Type.Optional(Type.String({ description: "如何测量/观测" })),
      experiment: Type.Optional(Type.String({ description: "提议的实验设计" })),
      falsification: Type.Optional(Type.String({ description: "什么结果会证伪此假设" })),
      project_id: Type.Optional(Type.Number({ description: "所属项目（见 project_context，可省略）" })),
      idea_id: Type.Optional(Type.Number({ description: "来源 idea ID（若有）" })),
    }),
    execute: async (_id: string, params: any) => {
      const r = getRepo();
      const h = r.createHypothesis({
        statement: params.statement, prediction: params.prediction, observable: params.observable,
        experiment: params.experiment, falsification: params.falsification,
        project_id: params.project_id, idea_id: params.idea_id,
      });
      return { content: [{ type: "text", text: JSON.stringify({
        hypothesis_id: h.id, status: "proposed", created_at: h.created_at,
        testability: params.falsification ? 0.8 : 0.4 }) }] };
    },
  });

  // ── hypothesis_search ──（按项目或来源 idea 查假设）
  pi.registerTool({
    name: "hypothesis_search",
    label: "Hypothesis Search",
    description: "查询研究假设：按项目（project_id）或按来源 idea（idea_id）。至少提供一个参数。",
    parameters: Type.Object({
      project_id: Type.Optional(Type.Number({ description: "按项目查" })),
      idea_id: Type.Optional(Type.Number({ description: "按来源 idea 查" })),
    }),
    execute: async (_id: string, params: { project_id?: number; idea_id?: number }) => {
      const r = getRepo();
      let list;
      if (params.idea_id) list = r.getHypothesesByIdea(params.idea_id);
      else if (params.project_id) list = r.getHypothesesByProject(params.project_id);
      else return { content: [{ type: "text", text: JSON.stringify({ error: "需提供 project_id 或 idea_id" }) }] };
      return { content: [{ type: "text", text: JSON.stringify({
        total: list.length,
        hypotheses: list.map(h => ({ id: h.id, statement: trunc(h.statement, 150), status: h.status,
          has_falsification: !!h.falsification, created_at: h.created_at })) }, null, 2) }] };
    },
  });

  // ── hypothesis_status ──（更新假设状态：proposed→in_design→testing→supported/falsified）
  pi.registerTool({
    name: "hypothesis_status",
    label: "Hypothesis Status",
    description: "更新假设状态生命周期：proposed → in_design → testing → supported / falsified / abandoned。用于追踪假设从提出到验证/证伪。",
    parameters: Type.Object({
      hypothesis_id: Type.Number({ description: "假设 ID" }),
      status: Type.String({ description: "新状态: proposed|in_design|testing|supported|falsified|abandoned" }),
    }),
    execute: async (_id: string, params: { hypothesis_id: number; status: string }) => {
      const r = getRepo();
      r.updateHypothesisStatus(params.hypothesis_id, params.status as any);
      return { content: [{ type: "text", text: JSON.stringify({
        hypothesis_id: params.hypothesis_id, status: params.status, updated: true }) }] };
    },
  });

  // ── project_context ──
  pi.registerTool({
    name: "project_context",
    label: "Project Context",
    description: "Get project context: claims, ideas, hypotheses (omit project_id to list all projects)",
    parameters: Type.Object({
      project_id: Type.Optional(Type.Number({ description: "Project ID (omit to list all projects)" })),
    }),
    execute: async (_id: string, params: { project_id?: number }) => {
      const r = getRepo();
      if (!params.project_id) {
        const projects = r.listProjects();
        return { content: [{ type: "text", text: JSON.stringify({ projects: projects.map(p =>
          ({ id: p.id, name: p.name, status: p.status })) }) }] };
      }
      const p = r.getProject(params.project_id);
      if (!p) return { content: [{ type: "text", text: JSON.stringify({ error: "Project not found" }) }] };
      return { content: [{ type: "text", text: JSON.stringify({ project: { id: p.id, name: p.name, status: p.status },
        claims: r.getClaimsByProject(params.project_id).map(c => ({ id: c.id, text: trunc(c.text, 150), status: c.status })),
        ideas: r.getIdeasByProject(params.project_id).map(i => ({ id: i.id, text: trunc(i.text, 150) })),
        hypotheses: r.getHypothesesByProject(params.project_id).map(h =>
          ({ id: h.id, statement: trunc(h.statement, 150), status: h.status })),
      }, null, 2) }] };
    },
  });

  // ── pi 记忆库（SQLite + FTS5，分级主动检索；实现在 lib/pi-memory.ts）───────────
  // 记忆不注入上下文：只有 agent 主动调这三个工具才取内容；库为空时自动重建一次索引。
  const memReply = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });

  // ── memory_map ──（先看目录再检索：知道库里有哪些层、各层有什么）
  pi.registerTool({
    name: "memory_map",
    label: "Memory Map",
    description: "列出个人记忆库的分级目录（只给标题与数量，不返回全文）。tier 0=用户事实与偏好（dream/user_facts：身份·偏好·环境与路径事实）；tier 1=技能与流程（workskills 的 SKILL.md、workflows、dream/workflows）；tier 2=参考资料与技术笔记（references、technotes、dream/notes、.dreams、history、conflict）；tier 3=历史记忆条目（nanobot 的 semantic/episodic/procedural，条目最多）。dream/* 前缀的来源是 memory_dream 从会话记录蒸馏沉淀的产物。不传 tier 返回各层数量/来源分布 + tier0 标题；传 tier 返回该层标题列表。用于「我之前记过关于 X 的技能/流程/笔记吗」这类先摸底、再 memory_search 的场景。",
    parameters: Type.Object({
      tier: Type.Optional(Type.Number({ description: "0/1/2/3，只看某一层（省略=总览）" })),
      limit: Type.Optional(Type.Number({ default: 40, description: "列出的标题条数上限，最大 200" })),
    }),
    execute: async (_id: string, params: { tier?: number; limit?: number }) => {
      const { openReadyDb, memoryMap } = await lazyImport("./lib/pi-memory.ts");
      const { db, auto, stats } = openReadyDb();
      const out = memoryMap(db, { tier: params.tier, limit: params.limit });
      if (auto && stats) {
        out.note = `记忆库此前为空，已自动重建索引：${stats.total_docs} 篇 / ${(stats.total_bytes / 1048576).toFixed(1)}MB / ${stats.elapsed_ms}ms`;
      }
      return memReply(out);
    },
  });

  // ── memory_search ──（话题相关才调用；命中后用 memory_get 取全文）
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "在个人记忆库按关键词检索（SQLite FTS5 trigram，实测 0-20ms），返回 id/层级/标题/摘要/片段/分数，不返回全文——需要全文用 memory_get(id)。≥3 字符走 trigram 精确子串匹配（BM25 排序）；1-2 字中文自动回退 LIKE 且标题命中加权；≥5 字中文短语自动拆成 2 字分段 AND 提高召回（如「论文下载流程」）；英文缩写按词边界匹配（THM 不会误命中 rhythm）；多词查询优先返回命中词数多的条目。建议按话题定层再用 tier/source 缩小范围：tier=0 用户事实与偏好、tier=1 技能与流程、tier=2 技术笔记、tier=3 历史操作记录。",
    parameters: Type.Object({
      query: Type.String({ description: "关键词，多个用空格或逗号分隔" }),
      tier: Type.Optional(Type.Number({ description: "0/1/2/3 限定层级" })),
      source: Type.Optional(Type.String({ description: "限定来源：workskill、workflow、technote、dream（.dreams 运行报告）、dream_fact/dream_workflow/dream_note（memory_dream 蒸馏产物）、history、conflict、skill_ref、research_wiki、nanobot_semantic、nanobot_episodic、nanobot_procedural" })),
      kind: Type.Optional(Type.String({ description: "限定类型：skill、workflow、note、fact、episode、procedure 等" })),
      limit: Type.Optional(Type.Number({ default: 8, description: "返回条数，1-20" })),
    }),
    execute: async (_id: string, params: { query: string; tier?: number; source?: string; kind?: string; limit?: number }) => {
      const { openReadyDb, memorySearch, splitTerms } = await lazyImport("./lib/pi-memory.ts");
      const { db, auto, stats } = openReadyDb();
      const hits = memorySearch(db, { query: params.query, tier: params.tier, source: params.source, kind: params.kind, limit: params.limit });
      return memReply({
        query: params.query,
        terms: splitTerms(params.query),
        total: hits.length,
        hits: hits.map(h => ({ id: h.id, tier: h.tier, tier_label: h.tier_label, source: h.source, kind: h.kind, title: h.title, snippet: h.snippet, score: h.score, via: h.via, bytes: h.bytes })),
        note: hits.length === 0
          ? "无命中：换关键词（中文≥2 字、英文≥3 字母更有效），或用 memory_map 看库里有哪些条目"
          : "要全文用 memory_get(id)；命中偏少时可去掉 tier/source/kind 过滤再试",
        ...(auto && stats ? { auto_indexed: { docs: stats.total_docs, bytes: stats.total_bytes, elapsed_ms: stats.elapsed_ms } } : {}),
      });
    },
  });

  // ── memory_get ──（取单篇全文；默认截断，避免灌爆上下文）
  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description: "取单篇记忆全文（id 或 path 二选一）。path 用 memory_search / memory_map 返回的 path 字段，如 workskills/nature-writing/SKILL.md、technotes/xxx.md、nanobot:semantic#108。正文默认截断 12000 字符，超出时 truncated=true，要更多传更大的 max_chars（上限 60000）。返回含 tier/source/kind/summary/keywords，可判断来源可信度。",
    parameters: Type.Object({
      id: Type.Optional(Type.Number({ description: "memory_search 返回的 id" })),
      path: Type.Optional(Type.String({ description: "memory_search / memory_map 返回的 path（与 id 二选一）" })),
      max_chars: Type.Optional(Type.Number({ default: 12000, description: "正文截断上限（字符），最大 60000" })),
    }),
    execute: async (_id: string, params: { id?: number; path?: string; max_chars?: number }) => {
      if (params.id == null && !params.path) {
        return memReply({ error: "必须提供 id 或 path（用 memory_map / memory_search 获取）" });
      }
      const { openReadyDb, memoryGet } = await lazyImport("./lib/pi-memory.ts");
      const { db } = openReadyDb();
      const d = memoryGet(db, { id: params.id, path: params.path }, params.max_chars ?? 12000);
      if (!d) return memReply({ error: "未找到该记忆条目", hint: "用 memory_map / memory_search 确认 id 或 path" });
      return memReply(d);
    },
  });

  // ── memory_reindex ──（新增技能/流程/笔记后重建索引；增量、秒级）
  pi.registerTool({
    name: "memory_reindex",
    label: "Memory Reindex",
    description: "重建个人记忆库索引。扫描数据根（默认 ~/.pi/memory-data，可用 ROCK_MEMORY_DIR 覆盖）下的 dream/user_facts、dream/workflows、dream/notes、workskills、workflows、technotes、.dreams（仅 dream-<时间戳>.md 运行报告；旧架构的 moonlight_*/deep_report 复盘与 dry_run 计划都不索引）、research-wiki、history.jsonl、conflict_queue.json，并只读迁移 nanobot_memory.db 的 semantic/episodic/procedural 记忆。inbox/、.retired/、.dream_tmp/ 明确排除（暂存与归档不进索引）。增量更新（未变文件按 bytes 跳过）+ 重建 FTS5，秒级完成。手工新增或修改技能、流程、笔记后调用一次即可被检索；memory_dream 已自动调用，通常无需手动跑。dry_run=true 只统计不写入。",
    parameters: Type.Object({
      dry_run: Type.Optional(Type.Boolean({ default: false, description: "只统计不写入" })),
    }),
    execute: async (_id: string, params: { dry_run?: boolean }) => {
      const { openMemoryDb, scanAndIndex, memoryDbFile, memoryDir } = await lazyImport("./lib/pi-memory.ts");
      const db = openMemoryDb();
      const stats = scanAndIndex(db, { dryRun: params.dry_run ?? false });
      return memReply({
        dry_run: params.dry_run ?? false,
        db_file: memoryDbFile(),
        memory_dir: memoryDir(),
        ...stats,
      });
    },
  });

  // ── memory_add ──（agent 主动记忆：只写「当天 inbox」临时 md，不进索引；等 memory_dream 沉淀入库）
  pi.registerTool({
    name: "memory_add",
    label: "Memory Add",
    description: "把一条 agent 主动记忆追加到「当天的临时 md」（<记忆根>/inbox/<日期>.md）。暂存区**不参与索引**，写进去的内容此刻还查不到——等 memory_dream 把它与当天会话记录一起蒸馏、分类写成 dream/ 下的源文件并重建索引后才可被 memory_search 检索。用于：用户说出一条长期偏好/身份/环境事实，你摸清了一个可复用的流程或踩坑，或得出一个之后会被用到的技术结论。kind 决定 dream 的路由：user_fact=用户身份·偏好·环境与路径事实(→tier0)、workflow=可重复流程与绕坑(→tier1)、note=技术结论与踩坑(→tier2，默认)。text 要自包含并带具体细节（路径、命令、数值、项目名、日期），脱离上下文也能读懂；禁止写密钥值/密码/token 原文——**入口会强制清扫**，掩码统一为 ****（不留 sk-/ghp_ 这类前缀，因为文件名与索引标题都由清扫后的文本派生，留前缀就等于把密钥指纹写进了可检索索引）；返回 scrubbed 告知清扫了几处。同日 inbox 已有相同正文时不会重复追加（duplicate=true）。tags 给 2-8 个关键词利于检索。写完可直接继续干活，不必立刻 dream。",
    parameters: Type.Object({
      text: Type.String({ description: "记忆正文（必填，≥12 字符）。自包含陈述，带具体细节。" }),
      // TypeBox 1.4.3 的 Enum 签名是 Enum(value, options)——必须两参式。
      // 对象式 Enum({enum: [...], default, description}) 会被当成 TypeScript enum 字面量逐值解包，
      // 产出 {"enum":[[整个数组], default, description截断]} 的垃圾 schema：校验器只认 default 那个值，
      // 传 kind:"user_fact"/"workflow" 会报 Validation failed，条目静默退回默认 note（→tier2 错分）。
      kind: Type.Optional(Type.Enum(["user_fact", "workflow", "note"], {
        default: "note",
        description: "user_fact=用户身份/偏好/环境与路径事实(→tier0)；workflow=可重复流程与绕坑(→tier1)；note=技术结论与踩坑(→tier2)"
      })),
      title: Type.Optional(Type.String({ description: "10 字以内的检索标题（省略则由正文首句生成）" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "2-8 个关键词，利于日后按词检索" })),
      date: Type.Optional(Type.String({ description: "归属日期 YYYY-MM-DD（缺省=今天，本地时区）" })),
      reason: Type.Optional(Type.String({ description: "为什么这条值得长期记住（一句话，便于人工审阅暂存块）" })),
    }),
    execute: async (_id: string, params: { text: string; kind?: string; title?: string; tags?: string[]; date?: string; reason?: string }) => {
      const { memoryAdd, memoryDir, localDate, dreamStatus, pendingHint } = await lazyImport("./lib/pi-dream.ts");
      const text = String(params.text ?? "").trim();
      if (!text) return memReply({ error: "text 不能为空" });
      if (text.length < 12) {
        return memReply({ error: `正文太短（${text.length} 字符）`, hint: "写成自包含陈述：什么场景、什么结论、涉及哪个路径/项目。否则蒸馏与检索都用不上。" });
      }
      const r = memoryAdd({ text, kind: params.kind, title: params.title, tags: params.tags, date: params.date, reason: params.reason });
      const st = dreamStatus();
      return memReply({
        ...r,
        memory_dir: memoryDir(),
        today: localDate(),
        dream_status: {
          last_dream_at: st.last_dream_at, hours_since: st.hours_since,
          pending_entries: st.pending_entries, pending_dates: st.pending.map(p => p.date), due: st.due,
        },
        hint: pendingHint(st) || "inbox 暂无积压，可继续工作",
      });
    },
  });

  // ── memory_dream ──（四阶段沉淀：抽取会话 → LLM 蒸馏 → 写 dream/ 源目录 → 报告+重建索引+归档）
  pi.registerTool({
    name: "memory_dream",
    label: "Memory Dream",
    description: "把记忆沉淀进记忆库（memory_add 的收尾，也是每天记忆入库的唯一入口）。四阶段：①**抽取**——扫 ~/.pi/agent/sessions 下指定日期的会话记录，取 user/assistant 文本回合，剔除工具输出、RAG 注入块、thinking 与寒暄 → .dream_tmp/<日期>.md；②**蒸馏**——子进程跑 dream-distill/distill.mjs 分批调 SenseNova LLM，提炼出值得长期保存的条目并丢弃一次性任务（与 rag_rebuild.mjs 同模式，不挂 pi）；③**写入**——inbox 暂存条目（免 LLM，agent 已分类）+ 蒸馏条目按 kind 写成 md 到 dream/user_facts(tier0)、dream/workflows(tier1)、dream/notes(tier2)，每条一篇；④**落账**——写 .dreams/dream-<时间>.md 报告 → scanAndIndex 增量重建 pi_memory.db → 已处理的 inbox 归档到 inbox/archive/（可恢复，不删除）。**一个日期只 dream 一次**：已沉淀过的日期再次运行会直接拒绝（already_dreamed=true，不烧 token），需 force=true 覆盖——同一天反复蒸馏会产出措辞不同的近重复条目，事后用 memory_dedup 清理。**只有真正产出才标记日期**：零产出、蒸馏全批失败、或有 inbox 条目没写成时不标记（marked_dreamed=false），可直接重跑，无需 force。date 必须是合法 YYYY-MM-DD，传错直接中止（aborted=true，不会静默按今天处理并把整个 inbox 扫光）；date 缺省=今天；sessions=false 只处理 inbox；inbox=false 只蒸馏会话；dry_run=true 只出计划（不烧 token、不写 dream 条目、不建索引、不归档；报告写为 dream-dryrun-*.md，不进索引）。建议：当天工作收尾、跨天、或 inbox 积压 ≥3 条时跑一次。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "处理哪一天 YYYY-MM-DD（本地时区）；缺省=今天。传非法格式会直接中止，不会静默按今天处理" })),
      dry_run: Type.Optional(Type.Boolean({ default: false, description: "只出计划：不蒸馏、不写文件、不建索引、不归档" })),
      sessions: Type.Optional(Type.Boolean({ default: true, description: "是否蒸馏会话记录（false=只处理 inbox 暂存）" })),
      inbox: Type.Optional(Type.Boolean({ default: true, description: "是否处理 inbox 暂存条目（false=只蒸馏会话记录）" })),
      model: Type.Optional(Type.String({ description: "蒸馏用模型，默认 sensenova-6.8-flash-lite" })),
      force: Type.Optional(Type.Boolean({ default: false, description: "强制重新处理一个已沉淀过的日期。默认拒绝重跑——同一天反复蒸馏会产出近重复条目；仅在确实需要重新蒸馏（如首次运行时蒸馏失败）时用" })),
    }),
    execute: async (_id: string, params: { date?: string; dry_run?: boolean; sessions?: boolean; inbox?: boolean; model?: string; force?: boolean }) => {
      const { memoryDream, dreamStatus, memoryDir, memoryDbFile, pendingHint } = await lazyImport("./lib/pi-dream.ts");
      const r = await memoryDream({
        date: params.date, dry_run: params.dry_run, sessions: params.sessions, inbox: params.inbox, model: params.model,
        force: params.force,
      });
      const st = dreamStatus();
      const ri = r.reindex as {
        added?: number; updated?: number; unchanged?: number; removed?: number; fts_rebuilt?: boolean;
        total_docs?: number; total_bytes?: number; by_source?: Record<string, number>; elapsed_ms?: number; warnings?: string[];
      } | null;
      return memReply({
        dry_run: r.dry_run,
        date: r.date,
        model: r.model,
        already_dreamed: r.already_dreamed,
        force: r.force,
        aborted: r.aborted,
        marked_dreamed: r.marked_dreamed,
        note: r.note,
        elapsed_ms: r.elapsed_ms,
        memory_dir: r.memory_dir,
        db_file: r.db_file,
        extract: r.extract && {
          ok: r.extract.ok, date: r.extract.date, sessions: r.extract.sessions, turns: r.extract.turns,
          user_turns: r.extract.user_turns, assistant_turns: r.extract.assistant_turns,
          chars: r.extract.chars, raw: r.extract.raw_rel,
        },
        distill: r.distill && {
          ok: r.distill.ok, batches: r.distill.batches, batches_failed: r.distill.batches_failed,
          items: r.distill.items.length, dropped: r.distill.dropped.length, elapsed_ms: r.distill.elapsed_ms,
          errors: r.distill.errors.slice(0, 3),
        },
        inbox: r.inbox,
        items_planned: r.items_planned,
        by_kind: r.by_kind,
        written: r.written,
        skipped: r.skipped,
        archived: r.archived,
        held_back: r.held_back,
        tmp_pruned: r.tmp_pruned,
        reindex: ri && {
          added: ri.added, updated: ri.updated, unchanged: ri.unchanged, removed: ri.removed,
          fts_rebuilt: ri.fts_rebuilt, total_docs: ri.total_docs,
          total_mb: ri.total_bytes != null ? Math.round((ri.total_bytes / 1048576) * 100) / 100 : null,
          by_source: ri.by_source, elapsed_ms: ri.elapsed_ms, warnings: ri.warnings,
        },
        report_file: r.report_file,
        warnings: r.warnings,
        dream_status: {
          last_dream_at: st.last_dream_at, hours_since: st.hours_since,
          pending_entries: st.pending_entries, pending_dates: st.pending.map(p => p.date),
        },
        hint: pendingHint(st) || "inbox 已清空，记忆库已是最新；用 memory_search 检索时可用 source=dream_fact/dream_workflow/dream_note 缩小范围",
      });
    },
  });

  // ── memory_dedup ──（dream 产物的近似去重维护工具；非每日流程）
  pi.registerTool({
    name: "memory_dedup",
    label: "Memory Dedup",
    description: "对 dream/ 记忆产物做近似去重（维护工具，不是日常流程）。历史 LLM 重跑会在同一天同品类下留下措辞不同的近重复条目（如「API Key 配置」/「API Key 配置约定」），标题去重抓不住这类；本工具按正文 Jaccard 相似度聚簇（传递闭包），每簇保留 dream_confidence 最高的一条，其余移入 ~/.pi/memory-data/.retired/dream-dedup-<时间戳>/<kind>/（**移入而非删除，可恢复**），随后需再跑一次 memory_reindex 让库里同步移除。默认口径：token 级 Jaccard ≥0.5 判定为重复——实测同一句子的改写得分 0.52~0.87，真正不同的条目最高 0.41，0.5 正好落在两者之间；但「同一个事实被完全不同地重述」只得分 0.18，与无关条目混在同一区间，阈值分不开（这类靠 memory_dream 的日期级幂等兜住）。用 dry_run=true 先出计划再实跑；date 可限定只处理某一天。整理后的数据上通常找到 0 簇，属正常。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "只处理某一天 YYYY-MM-DD 的条目（缺省=全部）" })),
      threshold: Type.Optional(Type.Number({ default: 0.5, minimum: 0.1, maximum: 1, description: "近似重复判定阈值（正文 Jaccard 相似度），默认 0.5" })),
      dry_run: Type.Optional(Type.Boolean({ default: false, description: "只出计划：报告会判定为重复的条目，不移动任何文件" })),
    }),
    execute: async (_id: string, params: { date?: string; threshold?: number; dry_run?: boolean }) => {
      const { dedupeDreamItems } = await lazyImport("./lib/pi-dream.ts");
      const r = dedupeDreamItems({
        date: params.date, threshold: params.threshold, dryRun: params.dry_run,
      });
      return memReply({
        dry_run: r.dry_run,
        scanned: r.scanned,
        clusters: r.clusters,
        removed_count: r.removed.length,
        removed: r.removed,
        moved_to: r.moved_to,
        note: r.note,
        hint: r.removed.length === 0
          ? "未发现近似重复条目——记忆库是干净的。"
          : (r.dry_run ? "dry_run：未移动任何文件。确认无误后去掉 dry_run 重跑以实际归档。"
                        : "已移入 .retired/（可恢复）。请再跑一次 memory_reindex 让库里同步移除。"),
      });
    },
  });

  // ── research_plot ──（直接复用 tools/research_plot.ts 的完整 description/schema——
  // 避免此处 sparse 描述让 LLM 瞎猜 chartType；execute 包一层 content 格式）
  pi.registerTool({
    ...researchPlotTool,
    execute: async (_id: string, params: any) => {
      const result = await researchPlotTool.execute(_id, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  });
}
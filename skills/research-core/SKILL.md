---
name: research-core
summary: Core research capabilities — claim verification, citation tracing, conflict analysis, research synthesis, gap detection, hypothesis generation
description: Core research capabilities — claim verification, citation tracing, conflict analysis, research synthesis, gap detection, hypothesis generation
triggers: [claim, citation, conflict, synthesis, research gap, hypothesis, verify]
---

# Research Core Skill

## 职责

提供科研推理基础能力。负责将论文信息转化为可验证的科研知识。

## 核心流程

### 1. 引用接地验证 (Citation Grounding) — claim_verify 工具

回原文比对 claim 是否被源文真实支持（不循环确认抽取器判断）。三模式：

```
claim_id     验已存 claim 的存储引用 → 取 evidence.file_path/page/text_span → 回 paper-raw/*.json 原文 → 模糊定位 span（反幻觉）→ LLM 蕴含比对 → verdict
cited_file   claim 引用某指定论文      → RAG 检索该论文 → 页定位 → LLM 蕴含 → verdict
claim_text   无靶，全库 RAG           → RAG 检索 → 页定位 → LLM 蕴含 → verdict
```

verdict 语义（有靶）：CORRECT（原文支持）/ MISATTRIBUTED（引用真实但原文 NOT_ADDRESSED/CONTRADICTS，claim 扭曲源）/ BROKEN_CITATION（引用 span 在源文找不到，抽取器幻觉，零 LLM）/ PAGE_MISATTRIBUTED / SPAN_CONFIRMED（仅结构接地，未启用 LLM 时）
verdict 语义（无靶）：SUPPORTED_BY / CONTRADICTED_BY / NO_SUPPORT_FOUND

结果落 claim_verifications 表，evidence_trace 可回溯验证历史。

> **与权重聚合的区别**：conflict_analyze / research_analyze 内部调 EvidenceService.weighEvidence 做库内权重累加（不回原文），输出 CONSENSUS / CONTESTED / INSUFFICIENT_EVIDENCE——那是冲突分析，非引用接地。两者 verdict 体系不同，勿混用。

### 2. 冲突分析 (Conflict Analysis)

```
Topic
  ↓
find all related claims
  ↓
check claim_relations for 'contradicts'
  ↓
group into conflict clusters
  ↓
identify possible reasons (stress path, rock type, scale, criterion)
  ↓
output: CONSENSUS / CONTESTED / INSUFFICIENT_EVIDENCE
```

### 3. 输出标签协议

所有输出必须内部标记，不外显（除非用户要求严格模式）：
- **FACT**: 有直接论文证据
- **SYNTHESIS**: 多论文综合判断
- **INTERPRETATION**: 基于证据的分析解释
- **HYPOTHESIS**: 可检验的假设
- **IDEA**: 未经验证的想法
- **UNVERIFIED**: 无法从本地证据确认

### 4. 数据源优先级

1. Local PDF > Local metadata
2. Trusted external metadata
3. External search snippet
4. Model internal knowledge (只作线索，不作证据)

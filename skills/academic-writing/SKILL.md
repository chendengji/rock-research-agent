---
name: academic-writing
summary: Academic writing support — evidence-backed outlines, claim ordering, paragraph organization, citation verification, style profiles
description: Academic writing support — evidence-backed outlines, claim ordering, paragraph organization, citation verification, style profiles
triggers: [academic writing, paper outline, literature review, paragraph organization, citation verification, style profile, revision]
---

# Academic Writing Skill

## 职责

负责科研写作的结构和语言支持。

- **不是**句子模仿器
- **不是**自动论文生成器
- **是**结构化写作助手

## 核心原则

### 证据写作 (Evidence-Backed Writing)

```
Claim → Evidence → Argument → Paragraph
          ↓
     Citation MUST be traceable to local PDF or verified external source
```

### 引用优先级

1. Local PDF (有全文) > Local metadata > Trusted external > Search snippet
2. 模型内部知识：只能用于提出线索，不可作为最终引用

### 引用验证

```
Claim citation → search local paper → locate page → find actual text → verify support
输出：CORRECT / MISATTRIBUTED / BROKEN_CITATION（有靶）；SUPPORTED_BY / CONTRADICTED_BY / NO_SUPPORT_FOUND（无靶）
```
由 claim_verify 工具完成（回原文接地，非库内权重累加）。结果落 claim_verifications，evidence_trace 可回溯。

## 写作任务

### 1. 证据提纲 (Evidence-Backed Outline)
- 收集相关 claims
- 验证每个 claim 有证据支持
- 按逻辑排序 claims
- 产生带引用标注的提纲

### 2. 段落组织 (Paragraph Organization)
- Topic sentence (claim)
- Supporting evidence
- Explanation / interpretation
- Transition to next

### 3. 风格配置文件 (Style Profile)
从目标期刊论文中提取抽象写作特征:
- sentence_length
- hedging
- claim_evidence_pattern
- discussion_structure
- limitation_expression

配置文件位于: `$ROCK_AGENT_PKG/support/configs/style_profiles/style_profiles.yaml`（`$ROCK_AGENT_PKG` = 本机 agent 包根，由安装位置决定，不写死绝对路径）


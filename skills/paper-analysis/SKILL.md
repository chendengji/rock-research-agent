---
name: paper-analysis
summary: Structured extraction of methods, results, parameters, limitations from papers, plus cross-paper comparison
description: Structured extraction of methods, results, parameters, limitations from papers, plus cross-paper comparison
triggers: [paper summary, method extraction, result extraction, parameter, limitation, cross-paper]
---

# Paper Analysis Skill

## 职责

负责"理解论文内容"——提取方法、结果、参数、局限性，支持跨论文对比。

## 核心任务

### 1. 论文摘要 (Paper Summary)
- Title + Authors + Year + Journal
- Research objective
- Methodology overview
- Key results (quantified where possible)
- Main conclusions
- 控制在 200-300 字

### 2. 方法提取 (Method Extraction)
- Sample preparation (rock type, dimension, condition)
- Testing apparatus and configuration
- Loading protocol (stress path, rate, confining pressure)
- Measurement techniques (AE, strain, wave velocity)
- Data processing methods

### 3. 结果提取 (Result Extraction)
- Key numerical findings with units
- Stress-strain curves: peak strength, residual, elastic modulus
- AE metrics: count, energy, b-value, RA-AF
- Failure mode description
- Tables: extract structured data

### 4. 参数提取 (Parameter Extraction)
- Hoek-Brown: mi, s, a, GSI, D
- Mohr-Coulomb: c, φ
- Elastic: E, ν
- Fracture toughness: K₁c, G₁c

### 5. 局限性提取 (Limitation Extraction)
- Sample size / representativeness
- Boundary condition simplifications
- Measurement limitations
- Interpretation assumptions
- Applicability scope

### 6. 跨论文对比 (Cross-Paper Comparison)
- Same rock type → compare strength parameters
- Same test method → compare results
- Same phenomenon → compare interpretations

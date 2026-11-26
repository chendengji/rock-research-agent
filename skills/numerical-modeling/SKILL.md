---
name: numerical-modeling
summary: Numerical simulation — FLAC3D, 3DEC, UDEC, FISH, DEM, FEM scripting and analysis
description: Numerical simulation — FLAC3D, 3DEC, UDEC, FISH, DEM, FEM scripting and analysis
triggers: [FLAC3D, 3DEC, UDEC, FISH, numerical modeling, DEM, FEM, Itasca]
---

# Numerical Modeling Skill

## 职责

负责岩石力学数值模拟的全流程支持：脚本编写、模型建立、参数标定、结果分析。

## 核心工具

### 1. FLAC3D
- 模型建立：zone create, geometry import
- 本构模型：Mohr-Coulomb, Hoek-Brown, strain-softening, 双线性
- 边界条件和初始应力
- 结构单元：liner, cable, beam, pile
- FISH 函数：自定义加载路径，伺服控制

### 2. 3DEC / UDEC
- 块体系统构建：block create, joint set
- 节理本构：Coulomb slip, continuously yielding
- 节理参数标定：JRC, JCS, φ_b

### 3. 参数标定
- UCS 校准：调整微观参数直到宏观强度匹配
- 围压系列标定：匹配 Hoek-Brown/Mohr-Coulomb
- 校准优先级：弹性参数 > 强度 > 峰后行为

### 4. 结果分析
- 应力云图：zone stress, contour
- 位移/变形：displacement field
- 塑性区：zone state
- 力链 / 裂纹（DEM）

### 5. Python 辅助
- py_itasca (FLAC3D Python API)
- 参数反演：grid search, LHS
- 批量模拟、自动化后处理

## Python 环境

> **环境放技能目录，单技能隔离**：本技能自带环境 `skills/numerical-modeling/.venv`（uv 建，`pyproject.toml` 声明依赖 `itasca` + `numpy`），**不读全局 `ROCK_PYTHON`**。脚本用 `$PY` 跑：① 技能自带 `.venv`（`"$SK/.venv/Scripts/python.exe"` Windows / `"$SK/.venv/bin/python"` Unix，存在即优先）→ 用它；② 本地项目 `.venv` → 用它；③ 未配置 → `uv run --directory "$SK"`（**uv 优先**）；④ 兜底 → `python3`/`python`。

```bash
SK="$HOME/.pi/agent/packages/rock-research-agent/skills/numerical-modeling"
# 验证环境
$PY -c "import itasca; print('itasca OK')"
```

> **注意**：PyPI 上的 Itasca Python 包名是 `itasca`（不是 `py_itasca`；`py_itasca` 在 PyPI 不存在）。它只是 Python 连接层，**需在已安装的 FLAC3D/3DEC 环境中运行**才真正连上软件；纯 Python 侧仅保证 import 与 API 骨架可用。FLAC3D 自带 Python 插件时，通常应使用其自带解释器（含 `itasca`），本技能环境用于离线脚本开发、参数反演与后处理。

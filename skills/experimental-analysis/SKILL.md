---
name: experimental-analysis
summary: Rock experiment data analysis — stress-strain, AE, RA-AF, energy, fracture, statistics, fitting, visualization
description: Rock experiment data analysis — stress-strain, AE, RA-AF, energy, fracture, statistics, fitting, visualization
triggers: [stress-strain, AE, acoustic emission, RA-AF, energy analysis, fracture analysis, wave velocity, statistics, fitting, visualization]
---

# Experimental Analysis Skill

## 职责

负责岩石力学实验数据的结构化分析和可视化。

## 核心能力

### 1. 应力-应变分析 (Stress-Strain)
- 完整曲线分段：压缩弹性 → 裂纹闭合 → 稳定裂纹扩展 → 不稳定裂纹扩展 → 峰后
- 参数提取：E, ν, σ_cc, σ_ci, σ_cd, σ_peak, σ_residual
- 多种围压下的刚度退化和延性转变

### 2. 声发射分析 (AE Analysis)
- 累计 AE count / energy vs 时间/应变
- 振铃计数率
- AE b-value：Gutenberg-Richter, 滑动窗口

### 3. RA-AF 裂纹分类
- RA (Rise Angle) = 上升时间 / 最大振幅
- AF (Average Frequency) = 振铃计数 / 持续时间
- 张拉裂纹：RA↓, AF↑
- 剪切裂纹：RA↑, AF↓

### 4. 能量分析 (Energy Analysis)
- 弹性应变能
- Dissipated energy
- 能量储存比
- 岩爆倾向指数 W_et

### 5. 拟合 (Fitting)
- Hoek-Brown / Mohr-Coulomb 参数拟合
- 损伤变量标定
- 统计分布拟合：b-value, 裂纹尺寸分布

### 6. 可视化 (Visualization)
- matplotlib/seaborn 多面板图
- 3D 散点和等值线（真三轴数据）
- 裂纹时空分布（AE 定位）

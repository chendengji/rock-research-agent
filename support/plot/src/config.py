#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
路径配置

输出位置：
- 图表：<WORKSPACE>/paper-plot/<session_ts>/
- 数据：<WORKSPACE>/paper-plot/data/<session_ts>/

WORKSPACE 可通过环境变量 WORKSPACE 指定，默认为当前工作目录。
"""
import os
import sys
from datetime import datetime

# sci-plot 技能目录
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 会话时间戳（模块导入时生成，同一脚本多次调用复用）
SESSION_TS = datetime.now().strftime('%Y%m%d_%H%M%S')

# 工作空间目录：从环境变量获取，默认为当前目录
WORKSPACE = os.environ.get('WORKSPACE', os.getcwd())

# plot 目录（统一存放 plot 相关数据）
PLOT_DIR = os.path.join(WORKSPACE, 'paper-plot')
FIGS_DIR = PLOT_DIR  # 图表直接放在 paper-plot/<session_ts>/（无 fig 子层）
DATA_DIR = os.path.join(PLOT_DIR, 'data')

# 批次子目录：paper-plot/<session_ts>/ 和 data/<session_ts>/
BATCH_DIR = os.path.join(FIGS_DIR, SESSION_TS)
DATA_BATCH_DIR = os.path.join(DATA_DIR, SESSION_TS)

# 确保目录存在
os.makedirs(BATCH_DIR, exist_ok=True)
os.makedirs(DATA_BATCH_DIR, exist_ok=True)

# 输出原始数据目录（skill 自己的测试数据）
ORIGINAL_DATA_DIR = os.path.join(SKILL_DIR, 'data')

# 当前项目信息（供工具返回）
CURRENT_WORKSPACE = WORKSPACE
CURRENT_PLOT_DIR = PLOT_DIR

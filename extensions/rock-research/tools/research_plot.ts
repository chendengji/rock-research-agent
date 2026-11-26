/**
 * research_plot — Pi Tool for sci-plot integration
 * 
 * 调用 chendengji/sci-plot 生成期刊级科研图表。
 * 零自研绘图代码，完全复用 sci-plot 能力。
 * 
 * 输出位置：<WORKSPACE>/paper-plot/<timestamp>/
 * WORKSPACE 由 project 参数或环境变量 WORKSPACE 指定
 */
import { Type } from "typebox";
import { spawn, spawnSync } from "child_process";
import { writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

// 按本模块位置相对定位绘图引擎（packages/rock-research-agent/support/plot），
// 不写死用户/磁盘路径；可用环境变量 SCI_PLOT_DIR 覆盖（如引擎单独部署）。
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SCI_PLOT_DIR = process.env.SCI_PLOT_DIR
  || join(THIS_DIR, "..", "..", "..", "support", "plot");
const SCI_PLOT_PY = join(SCI_PLOT_DIR, "src", "sci_plot.py");

/**
 * Python 运行器：优先绘图引擎自带环境（support/plot/.venv，uv 建的，环境跟归属目录走），
 * 不存在时再按 uv run --directory <引擎目录>（自动建 .venv）→ 系统 python 兜底。
 * 不再读全局 ROCK_PYTHON 环境变量——环境随引擎目录管理，不集中堆放。
 */
function resolvePythonRunner(): { cmd: string; args: string[] } {
  const venvPy = process.platform === "win32"
    ? join(SCI_PLOT_DIR, ".venv", "Scripts", "python.exe")
    : join(SCI_PLOT_DIR, ".venv", "bin", "python");
  if (existsSync(venvPy)) return { cmd: venvPy, args: [] };
  try {
    const r = spawnSync("uv", ["run", "--directory", SCI_PLOT_DIR, "python"], { stdio: "ignore" });
    if (r.status === 0) return { cmd: "uv", args: ["run", "--directory", SCI_PLOT_DIR, "python"] };
  } catch { /* 无 uv */ }
  return { cmd: process.platform === "win32" ? "python" : "python3", args: [] };
}

/**
 * 数据类型枚举（对应 sci-plot 6 种）
 */
type DataType = "paired" | "xy_series" | "distribution" | "gridded" | "irregular" | "3d_volume";

/**
 * 图表类型（sci-plot 支持的 37 种，完整清单以 list_charts() 为准）
 */
type ChartType = 
  | "bar" | "line" | "scatter" | "stem" | "stairs" | "stackplot" | "fill_between"
  | "boxplot" | "violin" | "hist" | "ecdf" | "pie" | "errorbar" | "hexbin" | "hist2d"
  | "contour" | "contourf" | "pcolormesh" | "imshow" | "quiver" | "streamplot" | "barbs"
  | "tricontour" | "tricontourf" | "tripcolor" | "triplot"
  | "plot3d" | "scatter3d" | "surface3d" | "wire3d" | "bar3d" | "voxels" | "trisurf3d";

/**
 * 样式枚举（5 种期刊风格）
 */
type StyleType = "nature" | "science" | "ieee" | "ieeetran" | "grid";

export const researchPlotTool = {
  name: "research_plot",
  label: "Research Plot",
  description: 
    "调用绘图引擎（sci-plot 已并入 support/plot）生成期刊级科研图表。\n\n" +
    "**数据类型**: paired/xy_series/distribution/gridded/irregular/3d_volume\n" +
    "**可用图表**: bar, line, scatter, boxplot, violin, hist, contour, surface3d 等 37 种\n" +
    "**可用样式**: nature, science, ieee, ieeetran, grid\n\n" +
    "**岩石力学场景映射**:\n" +
    "- xy_series + line → 应力-应变曲线\n" +
    "- distribution + violin → AE RA-AF 分布\n" +
    "- gridded + contourf → 数值模拟应力场\n" +
    "- paired + bar → 不同围压强度对比",
  
  parameters: Type.Object({
    workspace: Type.Optional(Type.String({
      description: "工作空间目录，默认为当前工作目录。图表将保存到 <workspace>/paper-plot/"
    })),
    dataPath: Type.Optional(Type.String({
      description: "数据文件路径（CSV/Excel/TXT），或绝对路径"
    })),
    inlineData: Type.Optional(Type.String({
      description: "CSV 格式字符串，当无文件时直接使用（首行为列名）"
    })),
    // TypeBox 1.4.3 的 Enum 签名是 Enum(value, options)——必须是两参式。
    // 写成 Enum({enum: [...], default, description}) 对象式会被当成"TypeScript enum 字面量"
    // 逐值解包，产出 {"enum":[[整个数组], default, description截断]} 的垃圾 schema：
    // 校验器只认 default 那个值（其余枚举值全部被拒），调用会报 Validation failed。
    dataType: Type.Optional(Type.Enum(["paired", "xy_series", "distribution", "gridded", "irregular", "3d_volume"], {
      default: "xy_series",
      description: "数据类型，默认为 xy_series（应力应变曲线）"
    })),
    chartType: Type.Optional(Type.String({
      description: "图表类型，如 line, bar, scatter, violin, contourf 等",
      default: "line"
    })),
    style: Type.Optional(Type.Enum(["nature", "science", "ieee", "ieeetran", "grid"], {
      default: "nature",
      description: "期刊风格，默认为 nature"
    })),
    columns: Type.Optional(Type.String({
      description: "列映射，格式: x=列1,y=列2[,group=列3]"
    })),
    outputName: Type.Optional(Type.String({
      description: "输出文件名（不含扩展名），默认自动生成"
    })),
    dpi: Type.Optional(Type.Number({
      default: 300,
      description: "输出分辨率，默认 300 DPI"
    }))
  }),

  execute: async (_id: string, params: {
    workspace?: string;
    dataPath?: string;
    inlineData?: string;
    dataType?: DataType;
    chartType?: ChartType;
    style?: StyleType;
    columns?: string;
    outputName?: string;
    dpi?: number;
  }) => {
    try {
      // 1. 处理数据源
      let dataPath = params.dataPath;
      if (!dataPath && params.inlineData) {
        // 写入临时 CSV（用系统临时目录，跨平台可用）
        const tmpFile = join(tmpdir(), `rock_plot_${Date.now()}.csv`);
        writeFileSync(tmpFile, params.inlineData, "utf-8");
        dataPath = tmpFile;
      }
      
      if (!dataPath) {
        return {
          success: false,
          error: "需要提供 dataPath 或 inlineData"
        };
      }

      // 2. 构造输出路径（使用 WORKSPACE 环境变量或指定目录）
      const workspace = params.workspace ?? process.env.WORKSPACE ?? process.cwd();
      const outputDir = join(workspace, "paper-plot");
      mkdirSync(outputDir, { recursive: true });
      const outputName = params.outputName ?? `fig_${Date.now()}`;
      const outputPath = join(outputDir, `${outputName}.png`);

      // 3. 动态选择 Python 运行器调用 sci-plot
      return await new Promise((resolve) => {
        const { cmd, args: runnerArgs } = resolvePythonRunner();
        const proc = spawn(cmd, [
          ...runnerArgs,
          SCI_PLOT_PY,
          "--input", dataPath,
          "--dtype", params.dataType ?? "xy_series",
          "--chart", params.chartType ?? "line",
          "--style", params.style ?? "nature",
          ...(params.columns ? ["--columns", params.columns] : [])
        ], {
          env: {
            ...process.env,
            PYTHONPATH: join(SCI_PLOT_DIR, "src"),
            WORKSPACE: workspace
          },
          windowsHide: true,
        });

        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });

        // 超时保护（默认 120s），防止渲染挂起导致工具永久等待
        const timer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 120_000);

        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            resolve({ success: false, error: `sci-plot 执行失败 (exit ${code}; runner=${[cmd, ...runnerArgs].join(" ")}): ${stderr}` });
            return;
          }
          // 引擎输出落点：<workspace>/paper-plot/<时间戳>/
          const sessionDir = join(workspace, "paper-plot");
          if (!existsSync(sessionDir)) {
            resolve({ success: false, error: `sci-plot 输出目录不存在：${sessionDir}（检查 Python 环境 ${[cmd, ...runnerArgs].join(" ")} 与 cwd）` });
            return;
          }
          const latestSession = readdirSync(sessionDir)
            .filter(d => d.startsWith("20"))
            .sort()
            .pop();

          if (!latestSession) {
            resolve({ success: false, error: "无法定位输出目录" });
            return;
          }
          const files = readdirSync(join(sessionDir, latestSession));
          const pngFile = files.find(f => f.endsWith(".png"));
          if (!pngFile) {
            resolve({ success: false, error: "未找到生成的 PNG 文件" });
            return;
          }
          const actualPath = join(sessionDir, latestSession, pngFile);
          let copyError: string | null = null;
          try { copyFileSync(actualPath, outputPath); } catch (e: any) { copyError = e?.message || String(e); }
          resolve({
            success: true,
            outputPath: copyError ? undefined : outputPath,
            copyNote: copyError ? `复制到 ${outputPath} 失败：${copyError}；结果在 actualPath` : undefined,
            actualPath: actualPath,
            sessionDir: join(sessionDir, latestSession),
            filename: pngFile,
            message: `图表已生成：${pngFile}`
          });
        });

        proc.on("error", (err) => {
          clearTimeout(timer);
          resolve({ success: false, error: `进程启动失败 (${[cmd, ...runnerArgs].join(" ")}): ${err.message}` });
        });
      });

    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err)
      };
    }
  }
};

/**
 * 预定义的岩石力学常用图表模板
 */
export const plotTemplates = {
  stressStrain: {
    dataType: "xy_series" as DataType,
    chartType: "line" as ChartType,
    columns: "x=strain,y=stress[,group=sample]",
    style: "nature" as StyleType,
    description: "应力-应变曲线"
  },
  aeDistribution: {
    dataType: "distribution" as DataType,
    chartType: "violin" as ChartType,
    columns: "x=group,y=value",
    style: "nature" as StyleType,
    description: "AE RA-AF 分布"
  },
  strengthComparison: {
    dataType: "paired" as DataType,
    chartType: "bar" as ChartType,
    columns: "x=group,y=value[,error=std]",
    style: "science" as StyleType,
    description: "不同围压/条件强度对比"
  },
  stressField: {
    dataType: "gridded" as DataType,
    chartType: "contourf" as ChartType,
    columns: "x=X,y=Y,z=szz",
    style: "nature" as StyleType,
    description: "数值模拟应力场"
  }
};

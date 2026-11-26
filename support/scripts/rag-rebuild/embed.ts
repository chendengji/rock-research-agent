import { EMBEDDING_MODEL } from "./constants.ts";

let _pipeline: any = null;

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * 本地模型加载（完全离线，避开 huggingface.co 不可达）。
 *
 * transformers.js 期望的目录结构是 <localModelPath>/<org>/<name>/{tokenizer.json, onnx/model*.onnx, ...}，
 * 与 huggingface_hub 的 snapshots 结构不同。本函数把 huggingface_hub 的 snapshot 目录
 * 复制到 <localModelPath>/<model_id> 下（幂等），然后用 local_files_only:true 加载。
 *
 * 优先级：LOCAL_MODEL_PATH > HF_HOME > ~/.cache/transformersjs/models
 */
function ensureFlatModelDir(): string {
  const localModelPath =
    process.env.LOCAL_MODEL_PATH ||
    join(homedir(), '.cache', 'transformersjs', 'models');
  const flatTarget = join(localModelPath, ...EMBEDDING_MODEL.split('/'));

  // 从 huggingface_hub 快照里拷一份（transformers.js 只支持 model 目录直存）
  if (!existsSync(flatTarget)) {
    const hfHome = process.env.HF_HOME || join(homedir(), '.cache', 'huggingface');
    const repoSlug = 'models--' + EMBEDDING_MODEL.replace('/', '--');
    const snapRoot = join(hfHome, 'hub', repoSlug, 'snapshots');
    if (!existsSync(snapRoot)) {
      throw new Error(
        `[embed] 本地模型快照不存在: ${snapRoot}\n` +
        `请先把 ${EMBEDDING_MODEL} 缓存到 huggingface_hub，例如:\n` +
        `  HF_HUB_OFFLINE=0 python -c "from huggingface_hub import snapshot_download; snapshot_download('${EMBEDDING_MODEL}', allow_patterns=['*.json','vocab.txt','onnx/*'])"`
      );
    }
    // 取最新 snapshot
    const snaps = require('fs').readdirSync(snapRoot).sort();
    const latest = snaps[snaps.length - 1];
    if (!latest) throw new Error(`[embed] 无 snapshot 目录: ${snapRoot}`);
    const src = join(snapRoot, latest);
    require('fs').mkdirSync(flatTarget, { recursive: true });
    require('fs').cpSync(src, flatTarget, { recursive: true });
    // transformers.js 默认找 model_quantized.onnx；若只有 model.onnx 则同步一份
    const onnxDir = join(flatTarget, 'onnx');
    const modelOnnx = join(onnxDir, 'model.onnx');
    const modelQuantized = join(onnxDir, 'model_quantized.onnx');
    if (existsSync(modelOnnx) && !existsSync(modelQuantized)) {
      require('fs').copyFileSync(modelOnnx, modelQuantized);
    }
    console.error(`[embed] 已把 snapshot 复制到: ${flatTarget}`);
  }
  return localModelPath;
}

async function getEmbedder() {
  if (_pipeline) return _pipeline;
  const { pipeline, env } = await import("@xenova/transformers");

  // 完全离线：禁用 remote、禁用 cache 写入（我们直接给的是完整模型目录）
  env.allowRemoteModels = false;
  env.localModelPath = ensureFlatModelDir();

  console.error(`[embed] 使用本地模型: ${env.localModelPath}/${EMBEDDING_MODEL}`);
  _pipeline = await pipeline("feature-extraction", EMBEDDING_MODEL, { local_files_only: true });
  return _pipeline;
}

export async function embed(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Yield to the event loop so the TUI can render progress updates.
 * ONNX inference is synchronous from the event loop's perspective;
 * without this, the UI freezes during embedding.
 */
const yield_ = () => new Promise<void>(r => setTimeout(r, 0));

/** Default batch size for a single ONNX forward pass. */
export const BATCH_SIZE = 64;

/**
 * Embed `texts` using true batched ONNX inference.
 *
 * The model is called once per batch of up to `BATCH_SIZE` texts rather than
 * once per text, giving a ~BATCH_SIZE× speedup on CPU.  The output Tensor has
 * dims [batchSize, VECTOR_DIM]; we slice it into per-text arrays.
 *
 * `onProgress` is fired after each batch with the cumulative count so the TUI
 * can render a smooth progress bar.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (i: number, total: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embedder = await getEmbedder();
  const results: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    // Pass the whole batch in a single forward pass — the model returns a
    // Tensor with dims [batchSize, VECTOR_DIM].
    const output = await embedder(batch, { pooling: "mean", normalize: true });
    const flat = output.data as Float32Array;
    const dim = flat.length / batch.length; // should equal VECTOR_DIM (384)

    for (let j = 0; j < batch.length; j++) {
      results[start + j] = Array.from(flat.subarray(j * dim, (j + 1) * dim));
    }

    onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
    // Yield after each batch so the TUI can re-render before the next pass.
    await yield_();
  }

  return results;
}

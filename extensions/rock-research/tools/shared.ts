/**
 * Shared tool helpers for rock-research.
 *
 * 单项目：research.db 固定在 <项目根>/data/research.db（项目根 = ROCK_PROJECT_ROOT 环境变量，未设则 cwd）。
 * 单例按项目根缓存：根变化时关闭旧连接、重建指向，避免误连别的库。
 *
 * index.ts 的内联工具与 research_plot.ts 共用此单例。
 */
import { ResearchRepository } from '../db/repository.ts';

let _repo: ResearchRepository | null = null;
let _repoCwd: string | null = null;

export function getRepo(): ResearchRepository {
    const cwd = process.env.ROCK_PROJECT_ROOT || process.cwd();
    if (!_repo || _repoCwd !== cwd) {
        if (_repo) {
            try { _repo.close(); } catch { /* 忽略关闭错误 */ }
        }
        _repo = new ResearchRepository();
        _repoCwd = cwd;
    }
    return _repo;
}

/** 测试/切换场景下强制释放单例（下按 cwd 重建）。 */
export function resetRepo(): void {
    if (_repo) {
        try { _repo.close(); } catch { /* 忽略 */ }
    }
    _repo = null;
    _repoCwd = null;
}

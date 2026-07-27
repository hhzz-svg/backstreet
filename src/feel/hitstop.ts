/**
 * 时间控制 —— hit-stop（定帧）与击杀慢镜。
 *
 * 这两个效果共用 `time.timeScale` 这一个全局量，所以**必须由本模块独占写入**。
 * 别的模块只读 time.scaledDelta / time.unscaledDelta，不要自己改 timeScale。
 *
 * ## 架构
 *
 * timeScale 由两层叠加决定，优先级 hit-stop > 慢镜：
 *
 *   hit-stop 生效中 → feelConfig.hitstop.scale（默认 0，全冻）
 *   否则            → baseScale()：慢镜状态机给出的值（1 / slowmo.scale / 缓动中）
 *
 * 也就是说 hit-stop 是"盖在慢镜上面的一层"，定帧结束时不会粗暴地回 1，
 * 而是回到慢镜当前该有的值。击杀那一瞬间「先定帧 7 帧，再进慢镜」就自然成立了。
 *
 * ## 重入安全（最容易翻车的地方）
 *
 * - hit-stop 定帧期间再次命中：比较 releaseAt 时间戳，取**较长**的那个，
 *   绝不累加。累加 = 高射速下 timeScale 永远回不到 1 = 游戏冻死。
 * - 定时器一律用 setUnscaledTimeout（墙钟）。用受 timeScale 影响的计时器，
 *   timeScale=0 时定时器永远不会触发，直接锁死 —— hit-stop 最经典的死法。
 * - 慢镜的推进用 updateTimeControl 里的 unscaled dt 累计，而不是定时器：
 *   这样才能在 hit-stop 期间**暂停慢镜计时**，让定帧先播完再开始慢镜，
 *   否则 7 帧定帧（约 117ms）会白白吃掉慢镜 400ms 里的四分之一。
 */

import { time, setUnscaledTimeout, lerp, clamp01, type UnscaledTimer } from '../core/time';
import { feelConfig, feelOn, frames } from './config';

// ---------------------------------------------------------------------------
// hit-stop 状态
// ---------------------------------------------------------------------------

let hitStopActive = false;
/** 定帧结束的墙钟时间戳（performance.now()）。重入时用它比较长短。 */
let hitStopReleaseAt = 0;
let hitStopTimer: UnscaledTimer | null = null;

// ---------------------------------------------------------------------------
// 慢镜状态机
// ---------------------------------------------------------------------------

type SlowPhase = 'idle' | 'hold' | 'recover';

let slowPhase: SlowPhase = 'idle';
/** 当前阶段已经走了多少毫秒（只在非定帧时累加）。 */
let slowElapsedMs = 0;

// ---------------------------------------------------------------------------

/** ease-out cubic —— 慢镜回到 1.0 时前段快、尾段柔，不会有"啪"地弹回的突兀感。 */
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** 不考虑 hit-stop 时，当前该有的 timeScale。 */
function baseScale(): number {
  if (slowPhase === 'idle') return 1;

  const cfg = feelConfig.slowmo;
  if (slowPhase === 'hold') return cfg.scale;

  // recover：从慢镜 scale 缓动回 1
  const dur = Math.max(1, cfg.recoverMs);
  return lerp(cfg.scale, 1, easeOutCubic(clamp01(slowElapsedMs / dur)));
}

/** 唯一写 time.timeScale 的地方。 */
function applyScale(): void {
  time.timeScale = hitStopActive ? feelConfig.hitstop.scale : baseScale();
}

function endHitStop(): void {
  hitStopActive = false;
  hitStopReleaseAt = 0;
  hitStopTimer = null;
  applyScale(); // 回到慢镜该有的值，而不是硬回 1
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 定帧 frameCount 帧（60fps 基准，见 config.frames）。
 *
 * 重入安全：定帧期间再次调用，只有当新的结束时刻**更晚**时才延长，否则忽略。
 */
export function hitStop(frameCount: number): void {
  if (!feelOn(feelConfig.hitstop.enabled)) return;
  if (!(frameCount > 0)) return;

  const ms = frames(frameCount);
  const releaseAt = performance.now() + ms;

  // 已有一次更长的定帧在跑 → 什么都不做（绝不叠加）
  if (hitStopActive && releaseAt <= hitStopReleaseAt) return;

  hitStopTimer?.cancel();
  hitStopReleaseAt = releaseAt;
  hitStopActive = true;
  hitStopTimer = setUnscaledTimeout(endHitStop, ms);

  applyScale();
}

/**
 * 击杀慢镜：timeScale → slowmo.scale，保持 durationMs，
 * 再用 recoverMs 做 ease-out 回到 1.0。
 *
 * 与 hit-stop 并存：击杀时通常先 `hitStop(hitstopKill)` 再 `killSlowMo()`，
 * 定帧期间慢镜计时暂停，定帧一结束慢镜才真正开始走。
 *
 * 重入：慢镜期间再次击杀 → 重新回到 hold 阶段并重新计时（连杀会把慢镜续上）。
 */
export function killSlowMo(): void {
  if (!feelOn(feelConfig.slowmo.enabled)) return;

  slowPhase = 'hold';
  slowElapsedMs = 0;
  applyScale();
}

/**
 * 每帧调用一次，驱动慢镜状态机并把 timeScale 写回去。
 *
 * @param dtUnscaled **必须是 time.unscaledDelta**。用 scaledDelta 会在
 *                   timeScale=0 时永远推不动状态机，直接冻死。
 *
 * 调用顺序建议：time.tick() → pumpUnscaledTimers() → updateTimeControl(time.unscaledDelta)
 * → 其余系统。这样本帧读到的 scaledDelta 已经是最新的时间缩放。
 */
export function updateTimeControl(dtUnscaled: number): void {
  // 面板中途关掉开关时要能干净地退出，不能把 timeScale 卡在 0。
  if (hitStopActive && !feelOn(feelConfig.hitstop.enabled)) {
    hitStopTimer?.cancel();
    endHitStop();
  }
  if (slowPhase !== 'idle' && !feelOn(feelConfig.slowmo.enabled)) {
    slowPhase = 'idle';
    slowElapsedMs = 0;
  }

  // 定帧期间慢镜计时暂停 —— 先把定帧播完，慢镜再开始。
  if (!hitStopActive && slowPhase !== 'idle') {
    slowElapsedMs += dtUnscaled * 1000;

    if (slowPhase === 'hold') {
      if (slowElapsedMs >= feelConfig.slowmo.durationMs) {
        slowPhase = 'recover';
        slowElapsedMs = 0;
      }
    } else if (slowElapsedMs >= Math.max(1, feelConfig.slowmo.recoverMs)) {
      slowPhase = 'idle';
      slowElapsedMs = 0;
    }
  }

  applyScale();
}

/** 硬复位：取消定帧、退出慢镜、timeScale 立刻回 1。重开局 / 暂停恢复时调用。 */
export function resetTimeControl(): void {
  hitStopTimer?.cancel();
  hitStopTimer = null;
  hitStopActive = false;
  hitStopReleaseAt = 0;
  slowPhase = 'idle';
  slowElapsedMs = 0;
  time.timeScale = 1;
}

// ---------------------------------------------------------------------------
// 只读查询（契约外的便利接口，给 HUD / 音频 / 调试面板用）
// ---------------------------------------------------------------------------

/** 当前是否处于定帧。 */
export function isHitStopped(): boolean {
  return hitStopActive;
}

/** 当前是否处于慢镜（含缓动恢复阶段）。 */
export function isSlowMo(): boolean {
  return slowPhase !== 'idle';
}

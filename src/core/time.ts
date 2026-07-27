/**
 * 双时钟 —— 本项目最重要的一条工程纪律。
 *
 * scaled   : 受 hit-stop / 慢镜影响。用于角色动画、移动、AI、弹道推进。
 * unscaled : 不受任何时间操纵影响。用于粒子、相机震动、后处理、UI、音频。
 *
 * hit-stop 期间 unscaled 系统必须继续按正常速度走，否则读起来是「卡了」
 * 而不是「打中了」。违反一次，定帧就退化成掉帧。
 *
 * 另：所有定时器一律走 performance.now()（见 setUnscaledTimeout）。
 * 用受 timeScale 影响的时钟做定帧计时器，timeScale=0 时定时器永远不触发，
 * 游戏会直接冻死 —— 这是 hit-stop 最经典的翻车点。
 */

const MAX_FRAME_DT = 0.1; // 100ms —— 切标签页回来时不要让物理炸掉

class Clock {
  /** 受时间缩放影响的帧时长（秒） */
  scaledDelta = 0;
  /** 不受时间缩放影响的真实帧时长（秒） */
  unscaledDelta = 0;
  /** 累计的 unscaled 时间（秒）—— 噪声、动画相位用它 */
  elapsed = 0;
  /** 当前时间缩放。1 = 正常，0 = 定帧，0.35 = 慢镜 */
  timeScale = 1;

  private last = performance.now() / 1000;

  tick(): void {
    const now = performance.now() / 1000;
    const raw = Math.min(now - this.last, MAX_FRAME_DT);
    this.last = now;
    this.unscaledDelta = raw;
    this.scaledDelta = raw * this.timeScale;
    this.elapsed += raw;
  }
}

export const time = new Clock();

// ---------------------------------------------------------------------------
// 不受 timeScale 影响的定时器
// ---------------------------------------------------------------------------

type PendingTimer = { fireAt: number; fn: () => void; cancelled: boolean };

const timers: PendingTimer[] = [];

export interface UnscaledTimer {
  cancel(): void;
}

/** 用真实墙钟计时的一次性定时器。hit-stop / 慢镜恢复必须用它。 */
export function setUnscaledTimeout(fn: () => void, ms: number): UnscaledTimer {
  const t: PendingTimer = { fireAt: performance.now() + ms, fn, cancelled: false };
  timers.push(t);
  return {
    cancel() {
      t.cancelled = true;
    },
  };
}

/** 每帧调用一次，驱动上面的定时器队列。 */
export function pumpUnscaledTimers(): void {
  if (timers.length === 0) return;
  const now = performance.now();
  for (let i = timers.length - 1; i >= 0; i--) {
    const t = timers[i];
    if (t.cancelled) {
      timers.splice(i, 1);
      continue;
    }
    if (now >= t.fireAt) {
      timers.splice(i, 1);
      t.fn();
    }
  }
}

// ---------------------------------------------------------------------------
// 帧率无关的插值助手
// ---------------------------------------------------------------------------

/**
 * 指数逼近系数。`a = expApproach(stiffness, dt)` 然后 `x = lerp(x, target, a)`。
 * 与固定 lerp(x, t, 0.2) 不同，这个在任意帧率下行为一致。
 */
export function expApproach(stiffness: number, dt: number): number {
  return 1 - Math.exp(-stiffness * dt);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

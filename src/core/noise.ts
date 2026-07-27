/**
 * 1D 值噪声（带三次平滑插值）。
 *
 * trauma 屏幕震动必须用连续噪声驱动，不能用 Math.random() 逐帧取值 ——
 * 后者会变成高频抖动，又丑又晕（Eiserloh, GDC 2016）。
 *
 * 每个轴用不同的 seed 采样同一条时间轴，就得到三条互不相关但各自连续的曲线。
 */

function hash(n: number): number {
  // 整数散列 → [0,1)
  let x = Math.sin(n) * 43758.5453123;
  return x - Math.floor(x);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t); // smoothstep
}

/** 返回 [0,1) 的连续噪声。seed 区分轴，t 是时间 × 频率。 */
export function noise1D(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i + seed);
  const b = hash(i + 1 + seed);
  return a + (b - a) * smooth(f);
}

/** 返回 [-1,1] 的连续噪声。震动位移用这个。 */
export function noiseSigned(seed: number, t: number): number {
  return noise1D(seed, t) * 2 - 1;
}

/** 分形噪声 —— 需要更"毛糙"的震动时用。 */
export function fbmSigned(seed: number, t: number, octaves = 2): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noiseSigned(seed + i * 17.13, t * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// 可复现随机 —— 散布图案用，便于调试
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [-1, 1) 均匀分布 */
export function randSigned(): number {
  return Math.random() * 2 - 1;
}

/** 单位圆盘内均匀采样 —— 弹道散布用（不能用两个独立均匀数，那会聚在中心） */
export function randInDisk(): [number, number] {
  const r = Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

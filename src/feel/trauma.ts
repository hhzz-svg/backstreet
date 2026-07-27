/**
 * Trauma 屏幕震动（Squirrel Eiserloh, GDC 2016《Math for Game Programmers: Juicing Your Cameras》）
 *
 * 核心三条：
 * 1. 外部只往里"加创伤"（trauma 0..1），永远不直接设角度 —— 多个来源可叠加。
 * 2. 实际幅度 = trauma^exponent。平方让小创伤几乎不动、大创伤猛砸，
 *    避免"一直在轻微晃"的晕眩感。
 * 3. 用连续噪声而不是 Math.random() 逐帧取值。随机数会变成高频抖动，
 *    又丑又晕；噪声是一条平滑曲线，读起来是"被撞了一下"。
 *
 * 三轴各用不同 seed + 略微错开的频率倍率采样同一条时间轴，
 * 得到三条互不相关但各自连续的曲线。roll 幅度给最大 —— roll 最有劲、最不晕。
 *
 * 双时钟：update(dt) 的 dt 必须是 time.unscaledDelta，elapsed 用 time.elapsed。
 * hit-stop 期间震动必须继续按真实速度走，否则定帧就退化成"卡了"。
 */

import { clamp01 } from '../core/time';
import { noiseSigned } from '../core/noise';
import { feelConfig, feelOn } from './config';

const DEG = Math.PI / 180;

/**
 * 相机震动偏移。
 *
 * **单位是弧度**，直接加到 camera.rotation.x / .y / .z 上即可
 * （feelConfig.shake.maxPitch 等是「度」，本模块内部已经转换过）。
 *
 * pitch → rotation.x（抬头/低头）
 * yaw   → rotation.y（左右甩）
 * roll  → rotation.z（翻滚，幅度最大）
 */
export interface ShakeOffset {
  pitch: number;
  yaw: number;
  roll: number;
}

// 三轴的噪声 seed —— 只要互不相同即可，取无规律的小数避免整数散列碰撞。
const SEED_PITCH = 11.7;
const SEED_YAW = 47.31;
const SEED_ROLL = 91.13;

// 三轴频率的微小错位。全用同一频率时三轴会同相，看起来像"沿一条对角线抖"。
const FREQ_MUL_PITCH = 1.0;
const FREQ_MUL_YAW = 0.93;
const FREQ_MUL_ROLL = 1.11;

export class TraumaShake {
  private trauma = 0;

  /** 复用的输出对象 —— 每帧调用，绝不能在这里 new（GC 抖动直接毁帧时间）。 */
  private readonly out: ShakeOffset = { pitch: 0, yaw: 0, roll: 0 };

  /**
   * 注入创伤。amount 0..1，累加后 clamp 到 1。
   *
   * 同时给 distance 和 falloffRadius 时按 `1 / (1 + d²/r²)` 衰减（爆炸用）：
   * 在半径处衰减到 1/2，2 倍半径处 1/5 —— 比线性衰减更符合"远处只是闷了一下"的直觉。
   */
  add(amount: number, distance?: number, falloffRadius?: number): void {
    if (!feelOn(feelConfig.shake.enabled)) return;
    if (!(amount > 0)) return; // NaN 也会被这条挡掉

    let a = amount;
    if (
      distance !== undefined &&
      falloffRadius !== undefined &&
      falloffRadius > 0 &&
      distance > 0
    ) {
      const d = distance / falloffRadius;
      a /= 1 + d * d;
    }

    this.trauma = clamp01(this.trauma + a);
  }

  /**
   * 每帧驱动。
   *
   * @param dt      **必须是 time.unscaledDelta** —— 震动不受 hit-stop / 慢镜影响。
   * @param elapsed **必须是 time.elapsed**（unscaled 累计时间），噪声相位用它。
   * @returns 复用的 ShakeOffset 对象（弧度）。调用方不要缓存这个引用当快照用。
   */
  update(dt: number, elapsed: number): ShakeOffset {
    const cfg = feelConfig.shake;
    const out = this.out;

    // 关掉时行为退化成"无效果"：创伤清零，输出全零，绝不崩。
    // 清零而不是保留，是为了中途开关面板时不会突然弹出一段陈旧的震动。
    if (!feelOn(cfg.enabled)) {
      this.trauma = 0;
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
      return out;
    }

    // 线性衰减（不是指数）—— 保证一定时间内必定归零，不会有拖不干净的余震。
    this.trauma = Math.max(0, this.trauma - cfg.decay * dt);

    if (this.trauma <= 0) {
      out.pitch = 0;
      out.yaw = 0;
      out.roll = 0;
      return out;
    }

    const amp = Math.pow(this.trauma, cfg.exponent);
    const t = elapsed * cfg.freq;

    out.pitch = cfg.maxPitch * DEG * amp * noiseSigned(SEED_PITCH, t * FREQ_MUL_PITCH);
    out.yaw = cfg.maxYaw * DEG * amp * noiseSigned(SEED_YAW, t * FREQ_MUL_YAW);
    out.roll = cfg.maxRoll * DEG * amp * noiseSigned(SEED_ROLL, t * FREQ_MUL_ROLL);

    return out;
  }

  /** 当前创伤值 0..1 —— 后处理/HUD 想跟震动联动时读它。 */
  get value(): number {
    return this.trauma;
  }

  reset(): void {
    this.trauma = 0;
    this.out.pitch = 0;
    this.out.yaw = 0;
    this.out.roll = 0;
  }
}

/** 全局单例 —— 开火、受击、爆炸、击杀都往这一个里加创伤。 */
export const shake = new TraumaShake();

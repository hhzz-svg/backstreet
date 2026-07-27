/**
 * 后坐力 —— 双弹簧模型。
 *
 * 每发子弹往 **target** 里注入一个冲量，然后两条独立的指数逼近同时跑：
 *
 *   current --(snappiness, 快)--> target      "枪跳起来"
 *   target  --(returnSpeed, 慢)--> 0          "枪落回去"
 *
 * 两条速度拉开差距，就得到"猛地一顶、慢慢沉下来"的手感。
 * 单弹簧（current 直接追 0）永远只能做出软绵绵的橡皮筋感。
 *
 * 另外维护一条 **climb**：连发时累积的枪口上抬。瞬时后坐会完全回落，
 * 但扫射时枪口会越抬越高 —— 这是"压枪"这件事存在的前提，
 * 也是玩家能感知到"我在扫射"的主要视觉信号。射击停止后缓动归零。
 *
 * 所有量都乘 feelConfig.recoil.scale（面板整体调强弱）。
 *
 * 双时钟：update(dt) 的 dt 用 **time.unscaledDelta**。
 * 后坐是相机/枪模的表现层，慢镜时枪口不该跟着变成慢动作上抬 —— 那会很怪。
 */

import { expApproach, lerp, clamp, clamp01 } from '../core/time';
import { randSigned, noiseSigned } from '../core/noise';
import { feelConfig, feelOn } from './config';
import type { WeaponDef } from '../types';

const DEG = Math.PI / 180;

/** 停火多久后 climb 开始回落（秒）。留一点保持时间，点射之间才不会一直上下弹。 */
const CLIMB_HOLD_SEC = 0.12;
/** climb 回落速度相对 returnSpeed 的倍率 —— 比瞬时后坐回得慢，余味更长。 */
const CLIMB_RETURN_MUL = 0.6;
/** 每发注入 climb 的比例（相对该枪的 recoilVert）。 */
const CLIMB_PER_SHOT = 0.34;
/** climb 上限（度）—— 不封顶的话满弹匣扫射会把镜头打到天上。 */
const CLIMB_MAX_DEG = 7.5;

/** 停火多久后连发计数归零（秒）。用于水平弹道图案。 */
const BURST_RESET_SEC = 0.35;

/** target 的封顶，防止极高射速下堆积出离谱的值。单位是「多少发的量」。 */
const TARGET_STACK_LIMIT = 3.2;

const SEED_HORIZ_PATTERN = 3.77;

export class Recoil {
  // 弹簧的两端
  private tPitch = 0;
  private tYaw = 0;
  private tKick = 0;
  private cPitch = 0;
  private cYaw = 0;
  private cKick = 0;

  /** 连发累积上抬（弧度） */
  private climbAmt = 0;

  /** 距上一发的时间（秒） */
  private sinceFire = Number.POSITIVE_INFINITY;
  /** 本轮连发已开火数，用于水平弹道图案 */
  private shotCount = 0;

  // 单发冲量的封顶值，由最近一次 kick 的武器决定
  private capPitch = 0;
  private capYaw = 0;
  private capKick = 0;

  /** 开一枪：注入冲量。关掉 recoil 开关时直接 no-op。 */
  kick(w: WeaponDef): void {
    if (!feelOn(feelConfig.recoil.enabled)) return;

    const s = feelConfig.recoil.scale;

    const vert = w.recoilVert * DEG * s;
    // 水平：纯随机会读成"乱抖"，纯图案又像激光。这里 45% 随机 + 55% 连发图案，
    // 图案用 noiseSigned 按发数采样 —— 扫射时形成可记忆的 S 形弹道，能被练出来。
    const pattern = noiseSigned(SEED_HORIZ_PATTERN, this.shotCount * 0.6);
    const horiz = (randSigned() * 0.45 + pattern * 0.55) * w.recoilHoriz * DEG * s;
    const kick = w.recoilKick * s;

    this.capPitch = vert * TARGET_STACK_LIMIT;
    this.capYaw = Math.abs(w.recoilHoriz * DEG * s) * TARGET_STACK_LIMIT;
    this.capKick = kick * TARGET_STACK_LIMIT;

    // 垂直固定向上（正 = 抬头），水平随机
    this.tPitch = clamp(this.tPitch + vert, -this.capPitch, this.capPitch);
    this.tYaw = clamp(this.tYaw + horiz, -this.capYaw, this.capYaw);
    this.tKick = clamp(this.tKick + kick, 0, this.capKick);

    // 连发上抬：越到弹匣后段每发贡献越少（真实枪械也是先陡后缓）
    const fade = 1 / (1 + this.shotCount * 0.06);
    this.climbAmt = clamp(
      this.climbAmt + vert * CLIMB_PER_SHOT * fade,
      0,
      CLIMB_MAX_DEG * DEG * s
    );

    this.shotCount++;
    this.sinceFire = 0;
  }

  /**
   * 每帧驱动。
   * @param dt **time.unscaledDelta**
   */
  update(dt: number): void {
    const cfg = feelConfig.recoil;

    // 关掉时退化成"无效果"：所有量平滑归零（不是瞬间清零，否则中途关面板会跳一下）
    if (!feelOn(cfg.enabled)) {
      const a = expApproach(20, dt);
      this.tPitch = lerp(this.tPitch, 0, a);
      this.tYaw = lerp(this.tYaw, 0, a);
      this.tKick = lerp(this.tKick, 0, a);
      this.cPitch = lerp(this.cPitch, 0, a);
      this.cYaw = lerp(this.cYaw, 0, a);
      this.cKick = lerp(this.cKick, 0, a);
      this.climbAmt = lerp(this.climbAmt, 0, a);
      this.shotCount = 0;
      return;
    }

    this.sinceFire += dt;

    // current 快速追 target
    const aCur = expApproach(cfg.snappiness, dt);
    this.cPitch = lerp(this.cPitch, this.tPitch, aCur);
    this.cYaw = lerp(this.cYaw, this.tYaw, aCur);
    this.cKick = lerp(this.cKick, this.tKick, aCur);

    // target 慢速回落到 0
    const aTgt = expApproach(cfg.returnSpeed, dt);
    this.tPitch = lerp(this.tPitch, 0, aTgt);
    this.tYaw = lerp(this.tYaw, 0, aTgt);
    this.tKick = lerp(this.tKick, 0, aTgt);

    // climb：停火 CLIMB_HOLD_SEC 之后才开始缓动归零
    if (this.sinceFire > CLIMB_HOLD_SEC) {
      this.climbAmt = lerp(
        this.climbAmt,
        0,
        expApproach(cfg.returnSpeed * CLIMB_RETURN_MUL, dt)
      );
      if (this.climbAmt < 1e-5) this.climbAmt = 0;
    }

    if (this.sinceFire > BURST_RESET_SEC) this.shotCount = 0;
  }

  /**
   * 相机 pitch 偏移（弧度，正 = 抬头）。加到 camera.rotation.x。
   *
   * **注意：这里已经包含了 climb 分量**。相机只叠加 pitch 一个值即可，
   * 不要再把 climb 加上去（会翻倍）。climb 单独暴露只是给枪模/HUD 参考用。
   */
  get pitch(): number {
    return this.cPitch + this.climbAmt;
  }

  /** 相机 yaw 偏移（弧度）。加到 camera.rotation.y。 */
  get yaw(): number {
    return this.cYaw;
  }

  /** 枪模后缩量（米，恒为正）。viewmodel 里沿本地 +Z（朝玩家）平移这么多。 */
  get kickZ(): number {
    return this.cKick;
  }

  /** 连发累积的枪口上抬（弧度，恒为正）。已含在 pitch 里，勿重复叠加到相机。 */
  get climb(): number {
    return this.climbAmt;
  }

  /** 连发累积的归一化强度 0..1 —— 给 HUD 准星张开 / 枪模抖动做输入。 */
  get climb01(): number {
    const s = Math.max(1e-6, feelConfig.recoil.scale);
    return clamp01(this.climbAmt / (CLIMB_MAX_DEG * DEG * s));
  }

  reset(): void {
    this.tPitch = this.tYaw = this.tKick = 0;
    this.cPitch = this.cYaw = this.cKick = 0;
    this.climbAmt = 0;
    this.shotCount = 0;
    this.sinceFire = Number.POSITIVE_INFINITY;
  }
}

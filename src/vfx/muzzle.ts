/**
 * 枪口特效。
 *
 * 分四层，每层单独受 feelConfig 开关控制，方便在 dev 面板里逐层做 A/B：
 *   1. flash  —— 2~3 片不同旋转的 additive 广告牌，寿命 2 帧。真正的「一闪」。
 *   2. light  —— 一盏 2 帧的点光源。这层才是灵魂：它把墙、飞尘、枪模一起点亮。
 *   3. sparks —— 12~20 个沿锥向抛出的 stretch 火花，给出「喷出去」的方向感。
 *   4. smoke  —— 缓慢上升的枪口烟，连发时会累积成一团，是射速的视觉证据。
 *
 * 寿命之所以短到 2 帧：枪口火光在真实世界里比这还短。拉长只会变成「手电筒」，
 * 失去打击感里最贵的那个字 —— 脆。
 *
 * 双时钟：本类不持有 update；所有粒子/光源都由 VfxSystem / LightPool 用
 * time.unscaledDelta 驱动。
 */

import * as THREE from 'three';
import { randInDisk } from '../core/noise';
import { feelConfig, feelOn, frames } from '../feel/config';
import type { LightPool } from './lightPool';
import type { VfxSystem } from './particles';

// --- 模块级临时量 -----------------------------------------------------------
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _colFlash = new THREE.Color();
const _colSpark = new THREE.Color();
const _colSmoke = new THREE.Color();

/** 枪口火光的暖色。契约指定 0xffd9a0。 */
const FLASH_COLOR = 0xffd9a0;
const SPARK_COLOR = 0xffcf80;
const SMOKE_COLOR = 0x6a6660;

/** 光源：强度 8，半径 6m，2 帧 */
const LIGHT_INTENSITY = 8;
const LIGHT_DISTANCE = 6;

/** 给定单位向量 dir，写出两条与之正交的单位向量到 out1/out2 */
function basisFrom(dir: THREE.Vector3, out1: THREE.Vector3, out2: THREE.Vector3): void {
  // 挑一个跟 dir 不平行的参考轴，避免叉乘退化
  if (Math.abs(dir.y) < 0.9) out1.set(0, 1, 0);
  else out1.set(1, 0, 0);
  out1.crossVectors(dir, out1).normalize();
  out2.crossVectors(dir, out1).normalize();
}

export class MuzzleFx {
  constructor(
    private readonly vfx: VfxSystem,
    private readonly lights: LightPool,
  ) {}

  /**
   * @param muzzleWorldPos 枪管末端的世界坐标（不是相机中心！）
   * @param dir            枪口朝向的单位向量
   */
  fire(muzzleWorldPos: THREE.Vector3, dir: THREE.Vector3): void {
    // dir 允许调用方传未归一化的向量，这里保底
    _tmp.copy(dir);
    if (_tmp.lengthSq() < 1e-8) _tmp.set(0, 0, -1);
    _tmp.normalize();
    basisFrom(_tmp, _t1, _t2);

    // ---- 1. 火光 ---------------------------------------------------------
    if (feelOn(feelConfig.vfx.muzzleFlash)) {
      _colFlash.setHex(FLASH_COLOR);
      const flashLife = frames(2) / 1000;
      const petals = 2 + (Math.random() < 0.5 ? 0 : 1); // 2~3 片
      for (let i = 0; i < petals; i++) {
        // 沿枪口方向稍微错开，几片叠起来才有体积
        _pos.copy(muzzleWorldPos).addScaledVector(_tmp, 0.04 + i * 0.05);
        _vel.copy(_tmp).multiplyScalar(1.2);
        this.vfx.flash.spawn({
          position: _pos,
          velocity: _vel,
          color: _colFlash,
          size: 0.42 - i * 0.09 + Math.random() * 0.12,
          life: flashLife * (1 - i * 0.15),
          mode: 'billboard',
          // 池内部会给每个实例随机自转 → 天然做到「不同旋转」
        });
      }

      // ---- 3. 火花 -------------------------------------------------------
      _colSpark.setHex(SPARK_COLOR);
      const n = 12 + Math.floor(Math.random() * 9); // 12~20
      for (let i = 0; i < n; i++) {
        const [u, v] = randInDisk();
        const spread = 0.34; // 锥半角正切，约 19°
        _vel
          .copy(_tmp)
          .addScaledVector(_t1, u * spread)
          .addScaledVector(_t2, v * spread)
          .normalize()
          .multiplyScalar(5 + Math.random() * 10);
        _pos.copy(muzzleWorldPos).addScaledVector(_tmp, 0.03);
        this.vfx.sparks.spawn({
          position: _pos,
          velocity: _vel,
          color: _colSpark,
          size: 0.016 + Math.random() * 0.012,
          life: 0.05 + Math.random() * 0.14,
          gravity: 9.8,
          drag: 4.5,
          mode: 'stretch',
          stretchScale: 0.018,
        });
      }

      // ---- 4. 枪口烟 -----------------------------------------------------
      _colSmoke.setHex(SMOKE_COLOR);
      const puffs = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < puffs; i++) {
        const [u, v] = randInDisk();
        _vel
          .copy(_tmp)
          .multiplyScalar(1.1 + Math.random() * 0.9)
          .addScaledVector(_t1, u * 0.35)
          .addScaledVector(_t2, v * 0.35);
        _vel.y += 0.25;
        _pos.copy(muzzleWorldPos).addScaledVector(_tmp, 0.06 + Math.random() * 0.08);
        this.vfx.smoke.spawn({
          position: _pos,
          velocity: _vel,
          color: _colSmoke,
          size: 0.10 + Math.random() * 0.12,
          life: 0.45 + Math.random() * 0.45,
          gravity: -0.45, // 负重力 = 缓慢上升
          drag: 2.6,
          mode: 'billboard',
          fadeIn: 0.06,
        });
      }
    }

    // ---- 2. 光 -----------------------------------------------------------
    if (feelOn(feelConfig.vfx.muzzleLight)) {
      // 稍微往前一点，别让光源埋在枪模里面
      _pos.copy(muzzleWorldPos).addScaledVector(_tmp, 0.12);
      this.lights.flash(_pos, FLASH_COLOR, LIGHT_INTENSITY, LIGHT_DISTANCE, frames(2));
    }
  }
}

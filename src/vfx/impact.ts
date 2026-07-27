/**
 * 弹着特效 —— 把「射线命中了一个三角形」翻译成「我打中了什么材质」。
 *
 * 全部参数从 SURFACES 表读，不在这里写死：材质表是关卡设计的一部分
 * （铁皮 22 颗白热火花 vs 混凝土 14 团灰白粉尘），玩家靠这个学会认掩体。
 * 这里只负责「怎么演」：
 *
 *   金属  → 大量白热火花是主角，火花亮到要给一盏很短的小点光源
 *   混凝土 → 灰白粉尘团是主角，火花只是点缀
 *   木头  → 少量火花 + 木屑
 *   玻璃  → 无火花，一大把偏冷的碎屑
 *   人体  → 无火花，沿弹道方向喷出的血雾（normal blending，不能发光）
 *
 * 双时钟：本类不持有 update；粒子/光源由 VfxSystem / LightPool 用
 * time.unscaledDelta 驱动，贴花由 DecalSystem 用 unscaledDelta 驱动。
 */

import * as THREE from 'three';
import { randInDisk } from '../core/noise';
import { feelConfig, feelOn, frames } from '../feel/config';
import { surfaceOf } from '../level/materials';
import type { SurfaceKind } from '../types';
import type { DecalSystem } from './decals';
import type { LightPool } from './lightPool';
import type { VfxSystem } from './particles';

// --- 模块级临时量 -----------------------------------------------------------
const _n = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _col = new THREE.Color();

/** 各材质的弹孔直径（米）。金属孔小而利，泥土坑大而糊。 */
const DECAL_SIZE: Record<SurfaceKind, number> = {
  concrete: 0.13,
  brick: 0.13,
  metal: 0.085,
  wood: 0.11,
  glass: 0.12,
  dirt: 0.18,
  flesh: 0.1,
};

/** 火花多到这个数就顺手给一盏小光 —— 主要是金属 */
const SPARK_LIGHT_THRESHOLD = 10;

function basisFrom(dir: THREE.Vector3, out1: THREE.Vector3, out2: THREE.Vector3): void {
  if (Math.abs(dir.y) < 0.9) out1.set(0, 1, 0);
  else out1.set(1, 0, 0);
  out1.crossVectors(dir, out1).normalize();
  out2.crossVectors(dir, out1).normalize();
}

export class ImpactFx {
  constructor(
    private readonly vfx: VfxSystem,
    private readonly decals: DecalSystem,
    private readonly lights: LightPool,
  ) {}

  /**
   * @param point   命中点（世界坐标）
   * @param normal  命中面法线（世界空间，指向射击者一侧）
   * @param surface 表面材质
   * @param mesh    命中的网格。契约签名里没有，但 DecalGeometry 必须要一个
   *                投影目标 —— hitscan 层本来就拿得到，传进来就有弹孔，
   *                不传就只有火花尘烟，不会报错。
   * @param incomingDir 子弹飞行方向（单位向量）。不传则用 -normal 近似，
   *                    血雾靠它决定往哪喷。
   */
  play(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surface: SurfaceKind,
    mesh?: THREE.Mesh,
    incomingDir?: THREE.Vector3,
  ): void {
    const def = surfaceOf(surface);

    _n.copy(normal);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    if (incomingDir && incomingDir.lengthSq() > 1e-8) {
      _dir.copy(incomingDir).normalize();
    } else {
      _dir.copy(_n).negate();
    }

    if (surface === 'flesh') {
      this.bloodMist(point, def.dust, def.dustColor);
      // 人体不留贴花：敌人会动，贴花是世界空间几何，跟不上身体
      return;
    }

    // ---- 火花：additive + stretch，沿法线半球喷 --------------------------
    if (def.sparks > 0 && feelOn(feelConfig.vfx.impactSparks)) {
      basisFrom(_n, _t1, _t2);
      _col.setHex(def.sparkColor);
      const n = def.sparks;
      for (let i = 0; i < n; i++) {
        const [u, v] = randInDisk();
        // spread 大 → 贴着墙面飞（跳弹感）；金属给得最开
        const spread = 1.15;
        _vel
          .copy(_n)
          .addScaledVector(_t1, u * spread)
          .addScaledVector(_t2, v * spread)
          .normalize()
          .multiplyScalar(2.5 + Math.random() * 7);
        _pos.copy(point).addScaledVector(_n, 0.01);
        this.vfx.sparks.spawn({
          position: _pos,
          velocity: _vel,
          color: _col,
          size: 0.014 + Math.random() * 0.012,
          life: 0.1 + Math.random() * 0.3,
          gravity: 9.8,
          drag: 2.2,
          mode: 'stretch',
          stretchScale: 0.02,
        });
      }

      // 白热火花亮到能照亮周围：给一盏极短的小光
      if (def.sparks >= SPARK_LIGHT_THRESHOLD && feelOn(feelConfig.vfx.muzzleLight)) {
        _pos.copy(point).addScaledVector(_n, 0.08);
        this.lights.flash(_pos, def.sparkColor, 2.6, 2.4, frames(2));
      }
    }

    // ---- 尘烟：normal blending，慢、大、有体积 ---------------------------
    if (def.dust > 0 && feelOn(feelConfig.vfx.impactDust)) {
      basisFrom(_n, _t1, _t2);
      _col.setHex(def.dustColor);
      const n = def.dust;
      for (let i = 0; i < n; i++) {
        const [u, v] = randInDisk();
        _vel
          .copy(_n)
          .multiplyScalar(0.7 + Math.random() * 1.6)
          .addScaledVector(_t1, u * 1.5)
          .addScaledVector(_t2, v * 1.5);
        _pos.copy(point).addScaledVector(_n, 0.02);
        // 玻璃碎屑是「掉」不是「飘」：重一点、小一点、活得短
        const shard = surface === 'glass';
        this.vfx.smoke.spawn({
          position: _pos,
          velocity: _vel,
          color: _col,
          size: shard ? 0.03 + Math.random() * 0.04 : 0.09 + Math.random() * 0.18,
          life: shard ? 0.35 + Math.random() * 0.4 : 0.5 + Math.random() * 0.7,
          gravity: shard ? 8 : 1.1,
          drag: shard ? 0.6 : 3.0,
          mode: shard ? 'stretch' : 'billboard',
          stretchScale: 0.012,
          fadeIn: shard ? 0 : 0.05,
        });
      }
    }

    // ---- 贴花 -------------------------------------------------------------
    if (def.decal && mesh) {
      const size = DECAL_SIZE[def.kind] * (0.85 + Math.random() * 0.3);
      this.decals.add(mesh, point, _n, size, def.decalColor);
    }
  }

  /**
   * 血雾：沿弹道方向喷出的一团，外加几滴被拉长的血珠。
   * 全部走 smoke 池（normal blending）—— 血一旦 additive 就会发光，
   * 立刻从「打中人」变成「打中霓虹灯」。
   */
  private bloodMist(point: THREE.Vector3, count: number, color: number): void {
    if (!feelOn(feelConfig.vfx.bloodMist)) return;

    basisFrom(_dir, _t1, _t2);
    _col.setHex(color);

    // 雾团：沿弹道往前喷，扩散角大，滞空久
    for (let i = 0; i < count; i++) {
      const [u, v] = randInDisk();
      _vel
        .copy(_dir)
        .multiplyScalar(1.4 + Math.random() * 3.2)
        .addScaledVector(_t1, u * 1.1)
        .addScaledVector(_t2, v * 1.1);
      _pos.copy(point).addScaledVector(_dir, 0.03);
      this.vfx.smoke.spawn({
        position: _pos,
        velocity: _vel,
        color: _col,
        size: 0.06 + Math.random() * 0.12,
        life: 0.28 + Math.random() * 0.35,
        gravity: 5.5,
        drag: 4.5,
        mode: 'billboard',
        fadeIn: 0.02,
      });
    }

    // 血珠：少量、快、被速度拉成条
    const drops = Math.max(3, Math.round(count * 0.5));
    for (let i = 0; i < drops; i++) {
      const [u, v] = randInDisk();
      _vel
        .copy(_dir)
        .multiplyScalar(4 + Math.random() * 6)
        .addScaledVector(_t1, u * 2.2)
        .addScaledVector(_t2, v * 2.2);
      _pos.copy(point).addScaledVector(_dir, 0.02);
      this.vfx.smoke.spawn({
        position: _pos,
        velocity: _vel,
        color: _col,
        size: 0.022 + Math.random() * 0.026,
        life: 0.22 + Math.random() * 0.26,
        gravity: 11,
        drag: 0.8,
        mode: 'stretch',
        stretchScale: 0.014,
      });
    }
  }
}

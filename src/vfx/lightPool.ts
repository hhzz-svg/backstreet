/**
 * 动态点光源池。
 *
 * 暗巷里最漂亮的东西不是粒子，是光。一次开火用一盏 2 帧的点光源把身前的
 * 墙面、飞尘、枪模同时照亮一下，比再加十万个粒子都管用 —— 因为它改变的是
 * 已经在画面里的每一个像素，而不是往画面上再堆几个像素。
 *
 * 代价也是真的：每盏动态点光源都会增加每片元开销，所以数量必须硬性封顶
 * （feelConfig.vfx.maxDynamicLights）。
 *
 * ⚠ **池里的灯必须常驻 visible=true，闲置时把 intensity 设为 0 —— 绝对不要切 visible。**
 * three 的 shader program 缓存键里包含「场景中可见灯光的数量」。一旦切换
 * light.visible，点光源数量就变了，**整个场景所有受光材质都要重新编译 shader**。
 * 实测：开枪点亮第 1 盏 → 重编 12 个 program（≈350ms 冻结）；
 * 第 2 枪再亮一盏 → 又 12 个（≈400ms）。正好砸在最需要打击感的头两枪上。
 * intensity=0 的灯对画面没有任何贡献，但能让灯光数恒定，一次都不用重编。
 *
 * 双时钟：update(dt) 的 dt 必须是 time.unscaledDelta —— 枪口闪光是「观感」，
 * 不该被 hit-stop 拉长成一盏挂在那儿的灯。
 */

import * as THREE from 'three';
import { feelConfig } from '../feel/config';

interface Slot {
  light: THREE.PointLight;
  active: boolean;
  /** 剩余时间（秒） */
  remain: number;
  /** 总时长（秒） */
  duration: number;
  /** 起始强度 */
  base: number;
}

export class LightPool {
  private readonly slots: Slot[] = [];
  private activeN = 0;

  /**
   * @param size 池容量。默认取 feelConfig.vfx.maxDynamicLights。
   *             注意：容量是构造时定死的（shader 变体数量跟着它走），
   *             运行时如果在 dev 面板把 maxDynamicLights 调小，
   *             flash() 会按新上限抢占而不是新分配 —— 调大则不会超过 size。
   */
  constructor(scene: THREE.Scene, size: number = feelConfig.vfx.maxDynamicLights) {
    const n = Math.max(1, Math.floor(size));
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 6, 2);
      light.castShadow = false; // 动态点光源投影 = 每帧渲 6 个面，M0 一律不给
      light.visible = true; // 常驻可见，靠 intensity=0 熄灭（见文件头注释）
      scene.add(light);
      this.slots.push({ light, active: false, remain: 0, duration: 1, base: 0 });
    }
  }

  get size(): number {
    return this.slots.length;
  }

  get activeCount(): number {
    return this.activeN;
  }

  /**
   * 一次闪光：强度从 intensity 按二次曲线衰减到 0，durationMs 后释放回池。
   *
   * @param durationMs 毫秒（用 frames(2) 之类算出来传进来）
   */
  flash(
    pos: THREE.Vector3,
    color: number,
    intensity: number,
    distance: number,
    durationMs: number,
  ): void {
    const cap = Math.min(this.slots.length, Math.max(0, Math.floor(feelConfig.vfx.maxDynamicLights)));
    if (cap <= 0) return;

    let slot: Slot | null = null;

    // 先找空闲槽，但活跃数不能超过运行时上限
    if (this.activeN < cap) {
      for (let i = 0; i < cap; i++) {
        if (!this.slots[i].active) {
          slot = this.slots[i];
          this.activeN++;
          break;
        }
      }
    }

    // 池满 → 抢占剩余寿命最短的那一盏（它本来也快灭了，抢它最不明显）
    if (!slot) {
      let shortest = Infinity;
      for (let i = 0; i < cap; i++) {
        const s = this.slots[i];
        if (s.active && s.remain < shortest) {
          shortest = s.remain;
          slot = s;
        }
      }
      if (!slot) return;
    }

    const dur = Math.max(0.001, durationMs / 1000);
    slot.active = true;
    slot.remain = dur;
    slot.duration = dur;
    slot.base = intensity;
    slot.light.color.setHex(color);
    slot.light.intensity = intensity;
    slot.light.distance = distance;
    slot.light.position.copy(pos);
  }

  /** @param dt 必须是 time.unscaledDelta */
  update(dt: number): void {
    if (this.activeN === 0) return;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      s.remain -= dt;
      if (s.remain <= 0) {
        s.active = false;
        s.remain = 0;
        s.light.intensity = 0; // 熄灭只降强度，不动 visible
        this.activeN--;
        continue;
      }
      const k = s.remain / s.duration;
      // 二次衰减：起手最亮，尾巴收得干脆，读起来是「闪」不是「亮了一下」
      s.light.intensity = s.base * k * k;
    }
  }

  /** 立刻熄灭全部（重开局用） */
  clear(): void {
    for (const s of this.slots) {
      s.active = false;
      s.remain = 0;
      s.light.intensity = 0;
    }
    this.activeN = 0;
  }

  dispose(): void {
    for (const s of this.slots) {
      s.light.removeFromParent();
      s.light.dispose();
    }
    this.slots.length = 0;
    this.activeN = 0;
  }
}

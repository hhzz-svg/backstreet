/**
 * 伤害数字 —— 世界坐标投影到屏幕的飘字。
 *
 * 池化是硬性要求：AR-15 700rpm，加上穿透和多目标，一秒可能冒十几个数字。
 * 每次 document.createElement 都会给 GC 和布局引擎添堵，所以构造时把 32 个 div
 * 一次性建好，之后只改 transform / opacity / textContent。
 *
 * 「跟随世界位置」而不是「钉在屏幕上」：每帧重新投影 worldPos，
 * 屏幕偏移（上抛弧线）叠在投影结果之上。相机一转，数字跟着敌人走，
 * 这是它能被读成「打在那个人身上」而不是「界面弹了个 toast」的关键。
 *
 * 时钟纪律：update(dt) 的 dt 必须是 time.unscaledDelta。
 * 定帧期间数字照常飘 —— 定帧本来就是为了让人看清这个数字。
 */

import * as THREE from 'three';
import { clamp01, lerp } from '../core/time';
import { noiseSigned } from '../core/noise';
import { feelConfig, feelOn } from '../feel/config';

const STYLE_ID = 'bs-dmg-style';

const CSS = `
.bs-dmg-layer {
  position: absolute; inset: 0; pointer-events: none; overflow: hidden;
}
.bs-dmg {
  position: absolute; left: 0; top: 0;
  display: none; white-space: nowrap;
  font-family: "Bahnschrift", "Segoe UI", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  font-size: 20px; font-weight: 600; line-height: 1;
  color: #f4f1ea;
  text-shadow: 0 2px 5px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9);
  will-change: transform, opacity;
  transform-origin: 50% 50%;
}
.bs-dmg.head { color: #ffc069; font-weight: 700; }
.bs-dmg.kill { color: #e5533a; font-weight: 700; letter-spacing: 0.02em; }
`;

/** 基础字号（px）。爆头 ×1.5，击杀 ×1.25。 */
const BASE_FONT = 20;
const HEAD_FONT_MUL = 1.5;
const KILL_FONT_MUL = 1.25;

/** 上抛高度（像素）与水平漂移范围 */
const RISE_MIN = 46;
const RISE_MAX = 66;
const DRIFT = 30;

interface Slot {
  el: HTMLDivElement;
  world: THREE.Vector3;
  /** 已存活秒数 */
  t: number;
  life: number;
  active: boolean;
  /** 屏幕空间二次贝塞尔的终点水平偏移 / 上抛高度 */
  dx: number;
  rise: number;
  /** 爆头抖动用的噪声种子 */
  seed: number;
  headshot: boolean;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export class DamageText {
  private readonly layer: HTMLDivElement;
  private readonly camera: THREE.Camera;
  private readonly slots: Slot[] = [];
  /** 轮转游标：池满时覆盖最老的那个（宁可吃掉一个旧数字，也不动态建 DOM） */
  private cursor = 0;

  private readonly tmp = new THREE.Vector3();

  constructor(root: HTMLElement, camera: THREE.Camera, pool = 32) {
    injectStyle();
    this.camera = camera;

    this.layer = document.createElement('div');
    this.layer.className = 'bs-dmg-layer';
    root.appendChild(this.layer);

    for (let i = 0; i < pool; i++) {
      const el = document.createElement('div');
      el.className = 'bs-dmg';
      this.layer.appendChild(el);
      this.slots.push({
        el,
        world: new THREE.Vector3(),
        t: 0,
        life: 1,
        active: false,
        dx: 0,
        rise: 0,
        seed: 0,
        headshot: false,
      });
    }
  }

  spawn(worldPos: THREE.Vector3, amount: number, headshot: boolean, killed: boolean): void {
    if (!feelOn(feelConfig.ui.damageNumbers)) return;

    const s = this.pick();
    s.world.copy(worldPos);
    s.t = 0;
    s.life = Math.max(0.1, feelConfig.ui.damageTextLife);
    s.active = true;
    s.dx = (Math.random() * 2 - 1) * DRIFT;
    s.rise = lerp(RISE_MIN, RISE_MAX, Math.random());
    s.seed = Math.random() * 1000;
    s.headshot = headshot;

    const mul = headshot ? HEAD_FONT_MUL : killed ? KILL_FONT_MUL : 1;
    s.el.className = 'bs-dmg' + (headshot ? ' head' : '') + (killed ? ' kill' : '');
    s.el.style.fontSize = (BASE_FONT * mul).toFixed(1) + 'px';
    // 击杀前面挂一个 ✕，一眼区分「打中了」和「打死了」
    s.el.textContent = (killed ? '✕ ' : '') + String(Math.max(1, Math.round(amount)));
    s.el.style.display = 'block';
    s.el.style.opacity = '0';
  }

  /** dt 必须是 time.unscaledDelta */
  update(dt: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const s of this.slots) {
      if (!s.active) continue;

      s.t += dt;
      const p = s.t / s.life;
      if (p >= 1) {
        s.active = false;
        s.el.style.display = 'none';
        continue;
      }

      // 每帧重新投影：相机在动，数字必须黏在世界上那一点
      this.tmp.copy(s.world).project(this.camera);
      if (this.tmp.z > 1) {
        // 目标跑到相机背后了，藏起来但继续计时（别让它复活时突然跳出来）
        s.el.style.opacity = '0';
        continue;
      }
      const sx = (this.tmp.x * 0.5 + 0.5) * w;
      const sy = (-this.tmp.y * 0.5 + 0.5) * h;

      // 屏幕空间二次贝塞尔上抛弧线：P0 起点 → P1 高控制点 → P2 落点
      const e = ease(p);
      const p1x = s.dx * 0.35;
      const p1y = -s.rise * 1.2;
      const p2x = s.dx;
      const p2y = -s.rise * 0.85;
      const om = 1 - e;
      const ox = 2 * om * e * p1x + e * e * p2x;
      const oy = 2 * om * e * p1y + e * e * p2y;

      // 爆头额外抖一下：连续噪声，不是逐帧随机（后者是高频闪，很脏）
      let jx = 0;
      let jy = 0;
      if (s.headshot) {
        const k = (1 - p) * 2.2;
        jx = noiseSigned(s.seed, s.t * 26) * k;
        jy = noiseSigned(s.seed + 91.7, s.t * 26) * k;
      }

      // scale 1.3 过冲回落：先弹出来抓住眼睛，再稳到 1.0
      const scale = p < 0.16 ? lerp(0.45, 1.3, p / 0.16) : lerp(1.3, 1.0, ease((p - 0.16) / 0.84));

      // 后 45% 淡出
      const alpha = p < 0.55 ? 1 : clamp01((1 - p) / 0.45);

      s.el.style.opacity = alpha.toFixed(3);
      s.el.style.transform =
        'translate(-50%,-50%) translate(' +
        (sx + ox + jx).toFixed(1) +
        'px,' +
        (sy + oy + jy).toFixed(1) +
        'px) scale(' +
        scale.toFixed(3) +
        ')';
    }
  }

  /** 当前活跃数字个数（调试信息用） */
  get activeCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.active) n++;
    return n;
  }

  destroy(): void {
    this.layer.remove();
  }

  private pick(): Slot {
    // 先找空闲的
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.cursor + i) % this.slots.length;
      if (!this.slots[idx].active) {
        this.cursor = (idx + 1) % this.slots.length;
        return this.slots[idx];
      }
    }
    // 全满：覆盖游标指向的那个（近似最老）
    const s = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;
    return s;
  }
}

function ease(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * 曳光弹。
 *
 * 一根从枪管末端飞到命中点的细亮条。为什么不是粒子池里的 stretch 广告牌：
 * 契约里 TracerFx.update(dt) 拿不到相机，做不了朝向相机的广告牌，所以这里用
 * 一根 6 面的开口圆柱 —— 从任何角度看都是一条亮线，不需要相机参与。
 *
 * 几何上烘了一条沿轴向的 alpha 渐变（尾端透明 → 头端最亮），
 * 配合 additive，读起来是「拖着尾巴的一发」而不是「一根发光的棍」。
 *
 * 速度：飞行时间固定 ~0.045s，所以距离越远飞得越快（视觉上一致）。
 * 每 N 发一条由 weapon 层按 WeaponDef.tracerEvery 决定，本类不管。
 *
 * 双时钟：update(dt) 的 dt 必须是 time.unscaledDelta。
 */

import * as THREE from 'three';
import { clamp } from '../core/time';
import { feelConfig, feelOn } from '../feel/config';

const FLIGHT_SEC = 0.045;
const MIN_SPEED = 260; // m/s
const MAX_SPEED = 1400;
const RADIUS = 0.014; // m
const MAX_STREAK = 2.6; // m，亮条本身的长度上限
const TRACER_COLOR = 0xffd08a;

// --- 模块级临时量 -----------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _mid = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/** 造一根 +Y 轴向、高 1、半径 1 的开口圆柱，并烘上尾→头的 alpha 渐变 */
function makeStreakGeometry(): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const pos = geo.attributes.position;
  const rgba = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i); // -0.5(尾) .. +0.5(头)
    const t = y + 0.5; // 0..1
    const a = Math.pow(t, 1.8); // 头端集中亮度
    rgba[i * 4] = 1;
    rgba[i * 4 + 1] = 1;
    rgba[i * 4 + 2] = 1;
    rgba[i * 4 + 3] = a;
  }
  // itemSize=4 且 material.vertexColors=true → three 打开 USE_COLOR_ALPHA，
  // vColor.a 会乘进 diffuseColor.a。
  geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
  return geo;
}

export class TracerFx {
  readonly mesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly capacity: number;

  private readonly ox: Float32Array;
  private readonly oy: Float32Array;
  private readonly oz: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly dist: Float32Array;
  private readonly travelled: Float32Array;
  private readonly speed: Float32Array;
  private readonly streak: Float32Array;

  private readonly freeStack: Int32Array;
  private freeCount: number;
  private readonly activeList: Int32Array;
  private activeN = 0;

  constructor(scene: THREE.Scene, capacity = 32) {
    const n = Math.max(1, Math.floor(capacity));
    this.capacity = n;

    this.ox = new Float32Array(n);
    this.oy = new Float32Array(n);
    this.oz = new Float32Array(n);
    this.dx = new Float32Array(n);
    this.dy = new Float32Array(n);
    this.dz = new Float32Array(n);
    this.dist = new Float32Array(n);
    this.travelled = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.streak = new Float32Array(n);

    this.freeStack = new Int32Array(n);
    for (let i = 0; i < n; i++) this.freeStack[i] = n - 1 - i;
    this.freeCount = n;
    this.activeList = new Int32Array(n);

    const geo = makeStreakGeometry();
    const mat = new THREE.MeshBasicMaterial({
      color: TRACER_COLOR,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      fog: false,
    });

    const mesh = new THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colBuf = new Float32Array(n * 3);
    colBuf.fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colBuf, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 11;
    this.mesh = mesh;
    scene.add(mesh);
  }

  get activeCount(): number {
    return this.activeN;
  }

  /**
   * @param from 枪管末端的世界坐标 —— 不要传相机中心，否则曳光弹是从眼睛里射出来的
   * @param to   命中点（或射程末端）的世界坐标
   */
  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    if (!feelOn(feelConfig.vfx.tracer)) return;

    _ay.copy(to).sub(from);
    const d = _ay.length();
    if (d < 0.25) return; // 贴脸命中，画出来只是一坨光
    _ay.multiplyScalar(1 / d);

    let i: number;
    if (this.freeCount > 0) {
      i = this.freeStack[--this.freeCount];
      this.activeList[this.activeN++] = i;
    } else {
      // 池满：抢占飞得最远的那一条（它最接近消失）
      let bestA = 0;
      let bestT = -1;
      for (let a = 0; a < this.activeN; a++) {
        const s = this.activeList[a];
        const t = this.travelled[s] / Math.max(1e-4, this.dist[s]);
        if (t > bestT) {
          bestT = t;
          bestA = a;
        }
      }
      i = this.activeList[bestA];
    }

    this.ox[i] = from.x;
    this.oy[i] = from.y;
    this.oz[i] = from.z;
    this.dx[i] = _ay.x;
    this.dy[i] = _ay.y;
    this.dz[i] = _ay.z;
    this.dist[i] = d;
    this.travelled[i] = 0;
    this.speed[i] = clamp(d / FLIGHT_SEC, MIN_SPEED, MAX_SPEED);
    this.streak[i] = Math.min(MAX_STREAK, d * 0.55);
  }

  /** @param dt 必须是 time.unscaledDelta */
  update(dt: number): void {
    if (this.activeN === 0) {
      this.mesh.count = 0;
      return;
    }

    // --- 推进 + 回收 ---
    for (let a = this.activeN - 1; a >= 0; a--) {
      const i = this.activeList[a];
      this.travelled[i] += this.speed[i] * dt;
      // 尾巴也走完了才算结束
      if (this.travelled[i] - this.streak[i] >= this.dist[i]) {
        this.activeN--;
        this.activeList[a] = this.activeList[this.activeN];
        this.freeStack[this.freeCount++] = i;
      }
    }

    // --- 写实例数据（紧凑打包到 [0, activeN)）---
    const matArr = this.mesh.instanceMatrix.array as Float32Array;
    const colArr = this.mesh.instanceColor!.array as Float32Array;

    for (let a = 0; a < this.activeN; a++) {
      const i = this.activeList[a];
      const dist = this.dist[i];
      const head = Math.min(this.travelled[i], dist);
      const tail = Math.max(0, head - this.streak[i]);
      const len = head - tail;

      if (len < 1e-4) {
        // 长度为 0 的实例：缩到 0，别画
        _m4.makeScale(0, 0, 0);
        _m4.toArray(matArr, a * 16);
        continue;
      }

      _ay.set(this.dx[i], this.dy[i], this.dz[i]);
      // 随便找一条与轴向正交的向量（圆柱绕自身轴对称，转到哪都一样）
      _ax.crossVectors(Math.abs(_ay.y) < 0.9 ? UP : RIGHT, _ay);
      if (_ax.lengthSq() < 1e-10) _ax.set(1, 0, 0);
      _ax.normalize();
      _az.crossVectors(_ax, _ay).normalize();

      _mid.set(
        this.ox[i] + this.dx[i] * (tail + len * 0.5),
        this.oy[i] + this.dy[i] * (tail + len * 0.5),
        this.oz[i] + this.dz[i] * (tail + len * 0.5),
      );

      _ax.multiplyScalar(RADIUS);
      _ay.multiplyScalar(len);
      _az.multiplyScalar(RADIUS);
      _m4.makeBasis(_ax, _ay, _az);
      _m4.setPosition(_mid);
      _m4.toArray(matArr, a * 16);

      // 快到终点时整体收暗，避免「啪」地消失
      const remain = 1 - clamp(this.travelled[i] / Math.max(1e-4, dist + this.streak[i]), 0, 1);
      const k = 0.35 + 0.65 * Math.min(1, remain * 2.2);
      const c3 = a * 3;
      colArr[c3] = k;
      colArr[c3 + 1] = k;
      colArr[c3 + 2] = k;
    }

    this.mesh.count = this.activeN;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  clear(): void {
    for (let a = this.activeN - 1; a >= 0; a--) {
      this.freeStack[this.freeCount++] = this.activeList[a];
    }
    this.activeN = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

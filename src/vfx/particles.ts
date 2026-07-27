/**
 * 自写的 InstancedMesh 广告牌粒子池。
 *
 * 为什么不用现成的粒子库：M0 需要的只有「一个四边形，朝向相机或沿速度拉伸，
 * 会衰减」。自己写 200 行换来的是完全可控的池化、零 GC、以及 hit-stop 期间
 * 用 unscaledDelta 继续走的纪律。
 *
 * 渲染实现（这段很关键，改之前先看懂）：
 * - 一个 InstancedMesh(PlaneGeometry(1,1))，容量固定，运行时永不 new 网格。
 * - 每帧把「活着的」粒子紧凑地写进实例槽 [0, activeCount)，再设 mesh.count，
 *   死掉的槽根本不进 draw call，不用靠缩放到 0 来隐藏。
 * - 颜色走 instanceColor（setColorAt）。
 * - 不透明度走一条 itemSize=4 的 InstancedBufferAttribute，名字必须叫 'color'
 *   且 material.vertexColors = true —— three 只有在
 *   `vertexColors === true && geometry.attributes.color.itemSize === 4`
 *   时才会打开 USE_COLOR_ALPHA，让 vColor.a 乘进 diffuseColor.a。
 *   这条属性只用 a 分量（rgb 恒为 1），色相仍然由 instanceColor 决定。
 * - additive 池额外把 instanceColor 整体压暗来淡出（additive 下变暗 == 淡出），
 *   normal 池则靠 alpha 淡出（把烟压暗只会变成黑烟）。
 *
 * 双时钟：update(dt) 的 dt 必须是 time.unscaledDelta。
 * hit-stop 期间粒子继续飞，才读得出「定住的是世界，不是渲染」。
 */

import * as THREE from 'three';
import { clamp01, expApproach } from '../core/time';
import { flashTexture, smokeTexture, sparkTexture } from './textures';

export interface ParticleSpawn {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
  size: number;
  life: number;
  /** 重力加速度 m/s²，正数向下。负数 = 上浮（枪口烟用）。默认 0 */
  gravity?: number;
  /** 空气阻力刚度，v *= exp(-drag*dt)。默认 0 */
  drag?: number;
  /** 'billboard' 面向相机；'stretch' 沿速度方向拉伸（曳光弹/火花） */
  mode?: 'billboard' | 'stretch';
  /**
   * stretch 模式的拉伸系数，单位「秒」：
   * 四边形沿速度方向的长度 = size + speed * stretchScale。
   * 即 stretchScale 相当于「把该粒子这么多秒走过的距离画成一条」。默认 0.02。
   */
  stretchScale?: number;
  /** 淡入时长（秒）。烟尘用 0.05 左右，避免凭空出现。默认 0 */
  fadeIn?: number;
}

// --- 模块级临时量：单线程，复用即可，避免每帧 GC ---------------------------
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const MODE_BILLBOARD = 0;
const MODE_STRETCH = 1;

export class ParticlePool {
  readonly capacity: number;
  readonly mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly sizeArr: Float32Array;
  private readonly grav: Float32Array;
  private readonly dragArr: Float32Array;
  private readonly stretch: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotV: Float32Array;
  private readonly mode: Uint8Array;

  /** free list：栈式复用槽位 */
  private readonly freeStack: Int32Array;
  private freeCount: number;
  /** 活跃槽位列表（顺序无意义，删除用 swap-remove） */
  private readonly activeList: Int32Array;
  private activeN = 0;

  /** alpha 通道（itemSize=4 的实例属性，只用 .a） */
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  /** additive 池靠压暗颜色淡出，normal 池靠 alpha 淡出 */
  private readonly fadeByColor: boolean;

  constructor(
    scene: THREE.Scene,
    texture: THREE.Texture,
    capacity: number,
    blending: THREE.Blending = THREE.AdditiveBlending,
  ) {
    this.capacity = capacity;
    this.fadeByColor = blending === THREE.AdditiveBlending;

    const n = capacity;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.sizeArr = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.dragArr = new Float32Array(n);
    this.stretch = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotV = new Float32Array(n);
    this.mode = new Uint8Array(n);

    this.freeStack = new Int32Array(n);
    for (let i = 0; i < n; i++) this.freeStack[i] = n - 1 - i; // 先用 0 号槽
    this.freeCount = n;
    this.activeList = new Int32Array(n);

    const geo = new THREE.PlaneGeometry(1, 1);
    // 每实例 RGBA：rgb 恒 1，a 是不透明度。名字必须是 'color' 才能触发
    // three 的 USE_COLOR_ALPHA 分支。
    const rgba = new Float32Array(n * 4);
    rgba.fill(1);
    this.alphaAttr = new THREE.InstancedBufferAttribute(rgba, 4);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('color', this.alphaAttr);

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending,
      depthTest: true,
      depthWrite: false, // 粒子永远不写深度，否则互相切出硬边
      side: THREE.DoubleSide,
      vertexColors: true,
      // additive 粒子吃雾会在远处「越远越亮」，反直觉；normal 粒子（烟尘）
      // 则必须吃雾，否则远处的烟浮在雾前面像贴纸。
      fog: !this.fadeByColor,
    });

    const mesh = new THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 提前建好 instanceColor，让 shader 从第一帧起就带 USE_INSTANCING_COLOR
    const colBuf = new Float32Array(n * 3);
    colBuf.fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colBuf, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false; // 粒子到处飞，实例包围球没意义
    mesh.renderOrder = 10;
    this.mesh = mesh;
    scene.add(mesh);
  }

  get activeCount(): number {
    return this.activeN;
  }

  spawn(p: ParticleSpawn): void {
    let i: number;
    if (this.freeCount > 0) {
      i = this.freeStack[--this.freeCount];
    } else {
      // 池满：抢占「剩余寿命最短」的活跃粒子（只采样前 8 个，O(1)）
      let bestA = 0;
      let bestLife = Infinity;
      const probe = Math.min(8, this.activeN);
      for (let a = 0; a < probe; a++) {
        const s = this.activeList[a];
        if (this.life[s] < bestLife) {
          bestLife = this.life[s];
          bestA = a;
        }
      }
      i = this.activeList[bestA];
      // 直接原地复用，不动 activeList
      this.initSlot(i, p);
      return;
    }

    this.activeList[this.activeN++] = i;
    this.initSlot(i, p);
  }

  private initSlot(i: number, p: ParticleSpawn): void {
    this.px[i] = p.position.x;
    this.py[i] = p.position.y;
    this.pz[i] = p.position.z;
    this.vx[i] = p.velocity.x;
    this.vy[i] = p.velocity.y;
    this.vz[i] = p.velocity.z;
    this.cr[i] = p.color.r;
    this.cg[i] = p.color.g;
    this.cb[i] = p.color.b;
    const l = Math.max(1e-4, p.life);
    this.life[i] = l;
    this.maxLife[i] = l;
    this.sizeArr[i] = p.size;
    this.grav[i] = p.gravity ?? 0;
    this.dragArr[i] = p.drag ?? 0;
    this.stretch[i] = p.stretchScale ?? 0.02;
    this.fadeIn[i] = p.fadeIn ?? 0;
    this.mode[i] = p.mode === 'stretch' ? MODE_STRETCH : MODE_BILLBOARD;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotV[i] = (Math.random() * 2 - 1) * 1.6;
  }

  /** swap-remove：把最后一个活跃槽换到位置 a */
  private release(a: number): void {
    const slot = this.activeList[a];
    this.activeN--;
    this.activeList[a] = this.activeList[this.activeN];
    this.freeStack[this.freeCount++] = slot;
  }

  /**
   * @param dt   必须是 time.unscaledDelta —— 定帧期间粒子照常飞
   * @param camera 用于广告牌朝向与 stretch 的视线基准
   */
  update(dt: number, camera: THREE.Camera): void {
    if (this.activeN === 0) {
      this.mesh.count = 0;
      return;
    }

    camera.getWorldPosition(_camPos);
    camera.getWorldQuaternion(_camQ);

    // --- 第一遍：积分 + 回收 -------------------------------------------------
    for (let a = this.activeN - 1; a >= 0; a--) {
      const i = this.activeList[a];
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.release(a);
        continue;
      }
      const d = this.dragArr[i];
      if (d > 0) {
        // exp(-drag*dt)，帧率无关
        const damp = 1 - expApproach(d, dt);
        this.vx[i] *= damp;
        this.vy[i] *= damp;
        this.vz[i] *= damp;
      }
      this.vy[i] -= this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotV[i] * dt;
    }

    // --- 第二遍：把活跃粒子紧凑写进实例槽 -----------------------------------
    const matArr = this.mesh.instanceMatrix.array as Float32Array;
    const colArr = this.mesh.instanceColor!.array as Float32Array;
    const alpArr = this.alphaAttr.array as Float32Array;

    for (let a = 0; a < this.activeN; a++) {
      const i = this.activeList[a];

      const t = clamp01(this.life[i] / this.maxLife[i]); // 1 → 0
      const fi = this.fadeIn[i] > 0 ? clamp01((this.maxLife[i] - this.life[i]) / this.fadeIn[i]) : 1;
      const alpha = t * fi;

      _pos.set(this.px[i], this.py[i], this.pz[i]);
      const size = this.sizeArr[i];

      let built = false;
      if (this.mode[i] === MODE_STRETCH) {
        _ay.set(this.vx[i], this.vy[i], this.vz[i]);
        const speed = _ay.length();
        if (speed > 1e-4) {
          _ay.multiplyScalar(1 / speed);
          _az.copy(_camPos).sub(_pos); // 指向相机
          _ax.crossVectors(_ay, _az);
          if (_ax.lengthSq() > 1e-10) {
            _ax.normalize();
            _az.crossVectors(_ax, _ay).normalize(); // 重新正交化，det = +1
            const len = size + speed * this.stretch[i];
            _ax.multiplyScalar(size);
            _ay.multiplyScalar(len);
            _m4.makeBasis(_ax, _ay, _az);
            _m4.setPosition(_pos);
            built = true;
          }
        }
      }
      if (!built) {
        // 广告牌：抄相机朝向，再绕视线轴自转
        _q.copy(_camQ);
        _qSpin.setFromAxisAngle(Z_AXIS, this.rot[i]);
        _q.multiply(_qSpin);
        _scale.set(size, size, 1);
        _m4.compose(_pos, _q, _scale);
      }

      _m4.toArray(matArr, a * 16);

      const k = this.fadeByColor ? alpha : 1;
      const c3 = a * 3;
      colArr[c3] = this.cr[i] * k;
      colArr[c3 + 1] = this.cg[i] * k;
      colArr[c3 + 2] = this.cb[i] * k;

      const c4 = a * 4;
      alpArr[c4] = 1;
      alpArr[c4 + 1] = 1;
      alpArr[c4 + 2] = 1;
      alpArr[c4 + 3] = this.fadeByColor ? 1 : alpha;
    }

    this.mesh.count = this.activeN;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  /** 立刻清空（重开局用） */
  clear(): void {
    for (let a = this.activeN - 1; a >= 0; a--) this.release(a);
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

/**
 * 三个池打包：火花 / 烟尘 / 火光。
 * 容量是拍出来的：AR-15 700rpm 全自动时，火花是唯一可能撞上限的一路。
 */
export class VfxSystem {
  readonly sparks: ParticlePool;
  readonly smoke: ParticlePool;
  readonly flash: ParticlePool;

  constructor(scene: THREE.Scene) {
    this.sparks = new ParticlePool(scene, sparkTexture(), 1024, THREE.AdditiveBlending);
    this.smoke = new ParticlePool(scene, smokeTexture(), 512, THREE.NormalBlending);
    this.flash = new ParticlePool(scene, flashTexture(), 96, THREE.AdditiveBlending);
    // 烟要画在火花下面：先烟后火花，additive 才叠得亮
    this.smoke.mesh.renderOrder = 9;
    this.sparks.mesh.renderOrder = 11;
    this.flash.mesh.renderOrder = 12;
  }

  /** @param dt 必须是 time.unscaledDelta */
  update(dt: number, camera: THREE.Camera): void {
    this.sparks.update(dt, camera);
    this.smoke.update(dt, camera);
    this.flash.update(dt, camera);
  }

  get activeCount(): number {
    return this.sparks.activeCount + this.smoke.activeCount + this.flash.activeCount;
  }

  clear(): void {
    this.sparks.clear();
    this.smoke.clear();
    this.flash.clear();
  }

  dispose(): void {
    this.sparks.dispose();
    this.smoke.dispose();
    this.flash.dispose();
  }
}

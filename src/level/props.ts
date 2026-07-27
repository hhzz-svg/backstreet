/**
 * 《暗巷 BACKSTREET》—— 程序化道具几何工厂。
 *
 * ## 这个模块是什么
 *
 * 一组**纯函数**，每个返回一条 `THREE.BufferGeometry`，几何**已经 applyMatrix4
 * 摆到世界坐标**（不是局部坐标 + 一个 Object3D 变换）。调用方拿到就能直接丢进
 * 材质桶：
 *
 * ```ts
 * const metalGeos: THREE.BufferGeometry[] = [];
 * metalGeos.push(fireEscapeGeo({ x: 4, y: 3, z: -6, floors: 3, facing: -1 }));
 * metalGeos.push(acUnitGeo({ x: 3.58, y: 2.9, z: -5.5 }));
 * const mesh = new THREE.Mesh(mergeGeometries(metalGeos, false), metalMaterial);
 * ```
 *
 * ## 为什么不返回 Mesh
 *
 * draw call 预算 ≤ 180、hitMeshes ≤ 16。一个道具一个 Mesh 会两头爆。
 * **材质归 alley.ts**：只有把「几何生产」和「材质决策」拆开，才可能把 30 个道具
 * 按 concrete / metal / wood 三个桶合并成 3 个网格、3 个 draw call、3 棵 BVH。
 * 所以这里刻意不 import materials.ts，也不 import textures.ts —— 本模块零材质依赖。
 *
 * ## 调用方需要知道的三件事
 *
 * 1. **几何在世界坐标**。push 进 alley.ts 的 Builder 时用单位矩阵，不要再乘一次。
 * 2. **不含碰撞代理**。这些都是细碎几何，直接进 Octree 会把节点数炸掉（见 alley.ts
 *    Builder 的注释）。调用方应该为大件（fireEscape / dumpster / balcony / palletStack）
 *    另外 `b.proxy(...)` 一个包围盒，小件（管线 / 栏杆 / 招牌 / 晾衣绳）根本不要碰撞。
 * 3. **属性集合被强制统一为 position / normal / uv，且一定是 indexed**。
 *    `mergeGeometries` 要求所有输入几何的属性名集合、属性数量、indexed 与否完全一致，
 *    差一条就整桶返回 null。每个函数返回前都会走一遍 `finalize()` 兜底。
 *
 * ## 三角形预算（实测，非估算 —— 盒子 12 tri，seg 段圆柱封盖 4×seg、开口 2×seg）
 *
 * | 道具            | tri  | | 道具          | tri |
 * |-----------------|------|-|---------------|-----|
 * | fireEscape(4层) | 1080 | | crate         | 108 |
 * | stair(14级)     | 192  | | barrel        |  92 |
 * | railing         | ≤168 | | dumpster      | 168 |
 * | balcony         | 192  | | palletStack×5 | 300 |
 * | acUnit          | 148  | | awning        |  96 |
 * | pipeRun(带弯头) | 136  | | signBoard     |  96 |
 * | windowFrame     | ≤108 | | doorFrame     |  84 |
 * | rubblePile(16)  | 192  | | clothesLine   | 144 |
 * | ladder          | 192  | | glassPane     |  12 |
 *
 * 实测：32 件道具铺满一条 40m 巷子 = 4832 tri / 7.2ms（基线 9.4k tri，预算 60k / 250ms）。
 *
 * 手段：圆柱径向分段一律 6~8（不是 32），栏杆立柱 / 绳索 / 斜撑全用盒子而不是圆柱，
 * 木托盘只建看得见的面。除 fireEscape（大件，配额 1200）外单件都压在 200 以内。
 *
 * ## 随机
 *
 * 全部走 `mulberry32(seed)`。不传 seed 的函数从自己的世界坐标散列出 seed
 * （`seedOf`），所以**同一个位置永远长同一个样**，改 alley.ts 里别的东西不会让
 * 已经调好的道具变形。要两个同位置不同形，改一下 y 或者传 rotY。
 *
 * 零外部资源：只有代码生成的盒子和圆柱。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { mulberry32 } from '../core/noise';

// ---------------------------------------------------------------------------
// 贴图密度 —— 与 alley.ts 的 TILE 对齐（UV 直接烘进几何，材质 repeat 保持 1）
// ---------------------------------------------------------------------------

/** 一张贴图平铺多少米重复一次。数值来自 alley.ts 的 TILE 表，保证并排时密度一致。 */
const TILE = {
  metal: 0.95, // alley: metalStruct 1.0 / metalProp 0.9
  wood: 0.8,
  concrete: 1.6,
  cloth: 1.1,
  glass: 1.0,
} as const;

const TAU = Math.PI * 2;
const UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const ONE = /*@__PURE__*/ new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clampI(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}

function clampF(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 从任意数字（通常是世界坐标）散列出一个稳定的 32 位 seed。
 * 坐标乘 1000 取整 —— 1mm 以内的改动不会换掉随机形态，方便微调摆位。
 */
function seedOf(...nums: number[]): number {
  let h = 0x9e3779b9;
  for (const n of nums) {
    h = (Math.imul(h ^ (Math.round(n * 1000) | 0), 0x85ebca6b) >>> 0) ^ (h >>> 13);
  }
  return h >>> 0;
}

/** 绕 Y 轴把局部偏移 (ox, oz) 转到父物件的朝向上。整组零件一起偏航时用。 */
function rotXZ(ox: number, oz: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [ox * c + oz * s, -ox * s + oz * c];
}

/**
 * 与 alley.ts 的 boxUV 逐字一致：把 BoxGeometry 的 UV 按真实世界尺寸重标定。
 * BoxGeometry(segments=1) 顶点顺序固定 +X,-X,+Y,-Y,+Z,-Z，每面 4 个顶点，
 * 面内 u/v 对应世界轴：±X → (d,h)，±Y → (w,d)，±Z → (w,h)。
 */
function boxUV(geo: THREE.BufferGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const dims: readonly [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const su = dims[f][0] / tile;
    const sv = dims[f][1] / tile;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
}

function scaleUV(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

const _euler = /*@__PURE__*/ new THREE.Euler();
const _quat = /*@__PURE__*/ new THREE.Quaternion();
const _pos = /*@__PURE__*/ new THREE.Vector3();
const _scl = /*@__PURE__*/ new THREE.Vector3();
const _a = /*@__PURE__*/ new THREE.Vector3();
const _b = /*@__PURE__*/ new THREE.Vector3();
/** 给 strut() 传端点用的临时向量。strut 内部立刻把值复制走，复用是安全的。 */
const _tmpA = /*@__PURE__*/ new THREE.Vector3();
const _tmpB = /*@__PURE__*/ new THREE.Vector3();

/**
 * 姿态矩阵。欧拉序 'YXZ'，和 alley.ts 的 xform 一致：
 * 先绕自身 Z（侧倾），再绕 X（俯仰），最后绕 Y（偏航）。
 * s 是**均匀**缩放 —— applyMatrix4 会用法线矩阵重算法线，均匀缩放下法线不会歪。
 */
function mat(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  s = 1,
): THREE.Matrix4 {
  _euler.set(rx, ry, rz, 'YXZ');
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  _scl.set(s, s, s);
  return new THREE.Matrix4().compose(_pos, _quat, _scl);
}

/**
 * 返回前的统一收口。**这是整个文件最容易踩的一条契约**：
 * mergeGeometries 会逐几何比对属性名集合和属性个数，任何一条多余的属性
 * （tangent / color / skinIndex…）或者少一条 uv，整桶合并直接返回 null，
 * 而且只在 console 里 error，alley.ts 那边会拿到 undefined 然后炸在 computeBoundsTree。
 * 所以：只留 position / normal / uv，强制 indexed，清掉 groups 和 morph。
 */
function finalize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') {
      g.deleteAttribute(name);
    }
  }
  if (!g.hasAttribute('normal')) g.computeVertexNormals();
  if (!g.hasAttribute('uv')) {
    const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (g.index === null) {
    // 全部输入都是 indexed 图元，正常走不到这里；兜底防止某天换了图元把整桶带崩。
    const n = (g.getAttribute('position') as THREE.BufferAttribute).count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/** 空几何（属性齐全、count=0），只在零件列表为空时返回，保证调用方合并不会失败。 */
function emptyGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(0), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(0), 1));
  return g;
}

// ---------------------------------------------------------------------------
// 零件累加器 —— 每个工厂函数内部先在**局部坐标**堆零件，最后一次性合并 + 上根矩阵
// ---------------------------------------------------------------------------

class Parts {
  private list: THREE.BufferGeometry[] = [];

  constructor(private readonly tile: number) {}

  /** 盒子。关卡里 90% 的零件；栏杆立柱、扶手、板条一律用它，不用圆柱。 */
  box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): this {
    const g = new THREE.BoxGeometry(w, h, d);
    boxUV(g, w, h, d, this.tile);
    g.applyMatrix4(mat(x, y, z, rx, ry, rz));
    this.list.push(g);
    return this;
  }

  /**
   * 圆柱。**seg 只允许 6~8** —— 一根 seg=32 的管子是 128 个三角形，
   * 挂满一条巷子就是 5k，而在 90° FOV、3m 开外，8 段和 32 段肉眼无差。
   * open=true 去掉两个端盖（三角形直接减半），管子/护罩/桶箍都该开口。
   */
  cyl(
    rTop: number,
    rBot: number,
    h: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    open = false,
  ): this {
    const s = clampI(seg, 6, 8);
    const g = new THREE.CylinderGeometry(rTop, rBot, h, s, 1, open);
    scaleUV(g, (Math.PI * (rTop + rBot)) / this.tile, h / this.tile);
    g.applyMatrix4(mat(x, y, z, rx, ry, rz));
    this.list.push(g);
    return this;
  }

  /**
   * 两点之间的方杆：斜撑、楼梯斜梁、雨棚面板、晾衣绳段。
   * 截面 t（局部 X）× w（局部 Z），长度沿 from→to。
   * 注意 setFromUnitVectors 的旋转轴是 UP×dir：方向在 XY 平面内时轴是 ±Z
   * （所以局部 Z 保持世界 Z，雨棚面板的宽度方向不会被拧歪）；
   * 方向在 YZ 平面内时轴是 ±X（楼梯斜梁的厚度方向保持世界 X）。
   */
  strut(t: number, w: number, from: THREE.Vector3, to: THREE.Vector3): this {
    const dir = _a.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-5) return this;
    const g = new THREE.BoxGeometry(t, len, w);
    boxUV(g, t, len, w, this.tile);
    _quat.setFromUnitVectors(UP, _b.copy(dir).divideScalar(len));
    _pos.addVectors(from, to).multiplyScalar(0.5);
    g.applyMatrix4(new THREE.Matrix4().compose(_pos, _quat, ONE));
    this.list.push(g);
    return this;
  }

  /**
   * 带顶点扰动的盒子 —— 碎石块专用。
   * 按 8 个角分组给同一个偏移，否则 BoxGeometry 的 24 个顶点（每角重复 3 次）
   * 会各自乱跑，把盒子扯成一堆穿帮的碎片。位移后必须 computeVertexNormals，
   * 由 build(root, true) 统一做。
   */
  chunk(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rx: number,
    ry: number,
    rz: number,
    rnd: () => number,
    amt: number,
  ): this {
    const g = new THREE.BoxGeometry(w, h, d);
    boxUV(g, w, h, d, this.tile);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const off = new Float32Array(24);
    for (let c = 0; c < 24; c++) off[c] = (rnd() - 0.5) * amt;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const c = ((px > 0 ? 1 : 0) | (py > 0 ? 2 : 0) | (pz > 0 ? 4 : 0)) * 3;
      pos.setXYZ(i, px + off[c], py + off[c + 1], pz + off[c + 2]);
    }
    pos.needsUpdate = true;
    g.applyMatrix4(mat(x, y, z, rx, ry, rz));
    this.list.push(g);
    return this;
  }

  /** 合并 → 上根矩阵 → 收口。renormalize 只在做过顶点位移时传 true。 */
  build(root: THREE.Matrix4, renormalize = false): THREE.BufferGeometry {
    const list = this.list;
    this.list = [];
    if (list.length === 0) return finalize(emptyGeo());

    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) {
      for (const g of list) g.dispose();
    }
    merged.applyMatrix4(root);
    if (renormalize) merged.computeVertexNormals();
    return finalize(merged);
  }
}

// ---------------------------------------------------------------------------
// 参数类型（导出，方便 alley.ts 建配置表）
// ---------------------------------------------------------------------------

export interface FireEscapeOpts {
  x: number;
  y: number;
  z: number;
  floors: number;
  facing: 1 | -1;
}
export interface StairOpts {
  x: number;
  y: number;
  z: number;
  steps: number;
  rise: number;
  run: number;
  width: number;
  rotY?: number;
}
export interface RailingOpts {
  x: number;
  y: number;
  z: number;
  length: number;
  height?: number;
  rotY?: number;
}
export interface BalconyOpts {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  rotY?: number;
}
export interface AcUnitOpts {
  x: number;
  y: number;
  z: number;
  rotY?: number;
  scale?: number;
}
export interface PipeRunOpts {
  x: number;
  y: number;
  z: number;
  len: number;
  radius?: number;
  axis?: 'x' | 'y' | 'z';
  elbows?: boolean;
}
export interface CrateOpts {
  x: number;
  y: number;
  z: number;
  size?: number;
  rotY?: number;
}
export interface BarrelOpts {
  x: number;
  y: number;
  z: number;
  rotY?: number;
  tipped?: boolean;
}
export interface DumpsterOpts {
  x: number;
  y: number;
  z: number;
  rotY?: number;
  lidOpen?: boolean;
}
export interface PalletStackOpts {
  x: number;
  y: number;
  z: number;
  count: number;
  rotY?: number;
}
export interface AwningOpts {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  facing: 1 | -1;
}
export interface SignBoardOpts {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  rotY?: number;
}
export interface WindowFrameOpts {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  rotY?: number;
  mullions?: number;
}
export interface DoorFrameOpts {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  rotY?: number;
}
export interface RubblePileOpts {
  x: number;
  y: number;
  z: number;
  radius: number;
  count: number;
  seed: number;
}
export interface ClothesLineOpts {
  x1: number;
  y1: number;
  z1: number;
  x2: number;
  y2: number;
  z2: number;
  sheets: number;
  seed: number;
}
export interface LadderOpts {
  x: number;
  y: number;
  z: number;
  height: number;
  rotY?: number;
}

// ---------------------------------------------------------------------------
// 1 · 室外逃生梯 —— 巷战场景的招牌剪影，也是垂直交战空间
// ---------------------------------------------------------------------------

/** 层高。3.0m 让 8m 高的巷墙正好放得下 2 层平台 + 一段上屋顶的梯段。 */
const FE_FLOOR_H = 3.0;
/** 平台外伸（离墙多远）。1.55m：站得上人，又不至于把 8m 宽的巷子占掉五分之一。 */
const FE_DEPTH = 1.55;
/** 平台沿墙方向的长度。要装得下一整段斜梯（7 级 × 0.33 = 2.31m）。 */
const FE_SPAN = 2.6;
const FE_RAIL_H = 1.02;

/**
 * 铁质室外逃生梯（踏步 + 栏杆 + 平台 + 底部下放梯）。
 *
 * 坐标约定：
 *  - `(x, y, z)` 是**第一层平台的标高与贴墙点**，不是地面。想让第一层在 3m，
 *    就传 y = 3。底部的下放梯自动从这里往下伸 2.4m（离地一段 —— 现实里这段是
 *    可下放的活动梯，也顺便让玩家爬不上去，不会破坏关卡的水平流线）。
 *  - `facing` 是结构从贴墙点伸出的方向：`-1` 沿 -X 伸（装在右墙 x=+4 上），
 *    `+1` 沿 +X 伸（装在左墙 x=-4 上）。内部统一按 +X 建，再整体绕 Y 转 180°。
 *  - 各层斜梯左右交替（`i % 2`），是真实逃生梯的走法，也让剪影不呆板。
 *
 * 材质：metal（穿透 0.55）。**这是个陷阱掩体** —— 玩家躲在平台底下会以为有遮蔽。
 * 三角形：14 盒/层 + 9 盒/梯段 + 7 盒下放梯，floors=4 时 90 盒 = 1080 tri（配额 1200）。
 * 碰撞：调用方自己给 `(x±D/2, y..y+floors*3, z)` 加一个 proxy 盒，不要让 Octree 吃踏步。
 */
export function fireEscapeGeo(o: FireEscapeOpts): THREE.BufferGeometry {
  const floors = clampI(o.floors, 1, 4);
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, floors));
  const p = new Parts(TILE.metal);

  const D = FE_DEPTH;
  const S = FE_SPAN;
  const xFront = D + 0.05; // 平台外沿

  for (let i = 0; i < floors; i++) {
    // 每层踏板略有沉降（老铁架不会是水平的），±8mm 足够读出来又不会穿模
    const fy = i * FE_FLOOR_H + (rnd() - 0.5) * 0.016;

    // 平台：钢格栅板 + 三根边梁
    p.box(D, 0.05, S, D * 0.5 + 0.05, fy - 0.025, 0);
    p.box(0.06, 0.16, S, xFront, fy - 0.11, 0);
    p.box(D, 0.12, 0.06, D * 0.5 + 0.05, fy - 0.09, -(S * 0.5 - 0.03));
    p.box(D, 0.12, 0.06, D * 0.5 + 0.05, fy - 0.09, S * 0.5 - 0.03);

    // 外沿栏杆：上下两道横杆 + 4 根立柱（立柱用盒子，一根 12 tri，圆柱要 24~32）
    p.box(0.05, 0.05, S, xFront - 0.02, fy + FE_RAIL_H, 0);
    p.box(0.04, 0.04, S, xFront - 0.02, fy + FE_RAIL_H * 0.52, 0);
    for (const t of [-0.46, -0.15, 0.15, 0.46]) {
      p.box(0.05, FE_RAIL_H, 0.05, xFront - 0.02, fy + FE_RAIL_H * 0.5, S * t);
    }

    // 两侧扶手（只有上横杆，侧面基本看不见立柱，省 4 个盒子）
    p.box(D, 0.05, 0.05, D * 0.5 + 0.05, fy + FE_RAIL_H, -(S * 0.5 - 0.05));
    p.box(D, 0.05, 0.05, D * 0.5 + 0.05, fy + FE_RAIL_H, S * 0.5 - 0.05);

    // 斜撑：从墙面往外上方顶住平台外沿，逃生梯的受力全靠这两根
    for (const s of [-1, 1]) {
      const zb = s * (S * 0.5 - 0.12);
      p.strut(
        0.05,
        0.05,
        _tmpA.set(0.06, fy - 0.62, zb),
        _tmpB.set(xFront - 0.06, fy - 0.12, zb),
      );
    }

    // 通往上一层的斜梯（顶层没有）
    if (i < floors - 1) {
      const dir = i % 2 === 0 ? 1 : -1;
      const steps = 7;
      const rise = FE_FLOOR_H / (steps + 1);
      const run = 0.33;
      const cx = 0.78; // 梯段贴平台内侧走，把外沿留给人站
      const z0 = -dir * (S * 0.5 - 0.15);
      for (let k = 0; k < steps; k++) {
        p.box(0.72, 0.04, 0.26, cx, fy + (k + 1) * rise, z0 + dir * (k + 0.5) * run);
      }
      for (const s of [-1, 1]) {
        p.strut(
          0.05,
          0.17,
          _tmpA.set(cx + s * 0.38, fy - 0.02, z0),
          _tmpB.set(cx + s * 0.38, fy + steps * rise + 0.02, z0 + dir * steps * run),
        );
      }
    }
  }

  // 底部下放梯：从一层平台往下 2.4m，末端悬空（现实里是配重活动梯）
  {
    const zL = S * 0.5 - 0.34;
    const yTop = -0.06;
    const h = 2.4;
    for (const s of [-1, 1]) {
      p.box(0.05, h, 0.05, D * 0.62 + s * 0.21, yTop - h * 0.5, zL);
    }
    for (let k = 0; k < 5; k++) {
      p.box(0.05, 0.035, 0.42, D * 0.62, yTop - 0.28 - k * 0.44, zL);
    }
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.facing === 1 ? 0 : Math.PI, 0));
}

// ---------------------------------------------------------------------------
// 2 · 楼梯
// ---------------------------------------------------------------------------

/**
 * 一段直跑楼梯。`(x, y, z)` 是**底部起步点**（第一级踏面的正下方地面中心），
 * 梯段沿局部 +Z 向上爬，`rotY` 转朝向。
 *
 * 只建踏面 + 两根斜梁，不建踢面 —— 巷子里的楼梯多半是钢制敞开式，
 * 而且省下 14 个盒子（168 tri）。踏面比 run 略宽一点（0.06m）做出鼻沿。
 * steps 上限 14（16 盒 = 192 tri）。
 */
export function stairGeo(o: StairOpts): THREE.BufferGeometry {
  const steps = clampI(o.steps, 1, 14);
  const rise = Math.max(0.08, o.rise);
  const run = Math.max(0.14, o.run);
  const w = Math.max(0.4, o.width);
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, steps));
  const p = new Parts(TILE.concrete);

  for (let k = 0; k < steps; k++) {
    // 每级踏面微微歪一点点（±0.3°），整段读起来才不像 CAD 出来的
    const tilt = (rnd() - 0.5) * 0.01;
    p.box(w, 0.05, run + 0.06, 0, (k + 1) * rise - 0.025, (k + 0.5) * run, tilt);
  }

  // 斜梁：从起步点连到梯段顶端，strut 会自动算出倾角
  const topY = steps * rise;
  const topZ = steps * run;
  for (const s of [-1, 1]) {
    p.strut(
      0.07,
      0.2,
      _tmpA.set(s * (w * 0.5 - 0.035), 0.06, -0.02),
      _tmpB.set(s * (w * 0.5 - 0.035), topY - 0.06, topZ + 0.02),
    );
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 3 · 栏杆
// ---------------------------------------------------------------------------

/**
 * 一段直栏杆。`(x, y, z)` 是**底部中心**，沿局部 ±X 各伸 length/2，`rotY` 转朝向。
 * 立柱数按 0.95m 间距推，上限 12 根（14 盒 = 168 tri）。
 */
export function railingGeo(o: RailingOpts): THREE.BufferGeometry {
  const L = Math.max(0.3, o.length);
  const H = o.height ?? 1.05;
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, L));
  const p = new Parts(TILE.metal);

  p.box(L, 0.05, 0.05, 0, H - 0.025, 0);
  p.box(L, 0.04, 0.04, 0, H * 0.54, 0);

  const n = clampI(L / 0.95 + 1, 2, 12);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const px = -L * 0.5 + 0.04 + (L - 0.08) * t;
    // 老栏杆立柱歪一两度，比笔直的好看
    p.box(0.05, H, 0.06, px, H * 0.5, 0, 0, 0, (rnd() - 0.5) * 0.035);
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 4 · 阳台
// ---------------------------------------------------------------------------

/**
 * 挑出式阳台。`(x, y, z)` 是**贴墙面、台面标高**的那个点；
 * 阳台沿局部 +X 挑出 `d`，沿局部 ±Z 各伸 `w/2`，`rotY` 转朝向
 * （装在右墙 x=+4 上就传 rotY = Math.PI）。
 *
 * 战术意义：这是给关卡加**垂直威胁**用的 —— 敌人从上面打下来，玩家的低掩体全失效。
 * 所以底板故意做实（不是格栅），从下往上看是完全不透的，玩家只能靠贴墙规避。
 * 15 盒 + 1 = 192 tri。
 */
export function balconyGeo(o: BalconyOpts): THREE.BufferGeometry {
  const w = Math.max(0.6, o.w);
  const d = Math.max(0.5, o.d);
  const railH = 1.0;
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, w, d));
  const p = new Parts(TILE.concrete);

  // 台面 + 三面挂板（贴墙那面不要）
  p.box(d, 0.12, w, d * 0.5, -0.06, 0);
  p.box(0.07, 0.22, w, d - 0.035, -0.14, 0);
  p.box(d, 0.2, 0.07, d * 0.5, -0.13, -(w * 0.5 - 0.035));
  p.box(d, 0.2, 0.07, d * 0.5, -0.13, w * 0.5 - 0.035);

  // 栏杆：外沿上下两道 + 两侧各一道
  p.box(0.05, 0.05, w, d - 0.05, railH, 0);
  p.box(0.04, 0.04, w, d - 0.05, railH * 0.55, 0);
  p.box(d, 0.05, 0.05, d * 0.5, railH, -(w * 0.5 - 0.05));
  p.box(d, 0.05, 0.05, d * 0.5, railH, w * 0.5 - 0.05);

  // 立柱：外沿 4 根 + 两侧各 1 根
  for (const t of [-0.42, -0.14, 0.14, 0.42]) {
    p.box(0.05, railH, 0.05, d - 0.05, railH * 0.5, w * t, 0, 0, (rnd() - 0.5) * 0.03);
  }
  for (const s of [-1, 1]) {
    p.box(0.05, railH, 0.05, d * 0.55, railH * 0.5, s * (w * 0.5 - 0.05));
  }

  // 两根斜撑顶住挑出端 —— 没有它整个阳台读起来像漂浮的
  for (const s of [-1, 1]) {
    const zb = s * (w * 0.5 - 0.14);
    p.strut(
      0.08,
      0.08,
      _tmpA.set(0.05, -0.92, zb),
      _tmpB.set(d - 0.1, -0.16, zb),
    );
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 5 · 空调外机
// ---------------------------------------------------------------------------

/**
 * 墙挂空调外机。`(x, y, z)` 是**机体中心**，出风面朝局部 -X（默认朝 -X，
 * 装在右墙上就是朝巷子里），`rotY` 转朝向，`scale` 均匀缩放（默认 1）。
 *
 * 比 alley.ts 里现有的那套多了扇叶和百叶 —— 扇叶是刻意留的：
 * 它是全场少数几个「打中会有具体反馈」的小目标，火花打在护罩上很好看。
 * 3 扇叶 + 护罩 + 轮毂 + 百叶 + 托架 + 冷媒管 = 148 tri。
 * 注：scale 是矩阵均匀缩放，UV 密度会跟着缩放走。0.8~1.3 内看不出来，超出请谨慎。
 */
export function acUnitGeo(o: AcUnitOpts): THREE.BufferGeometry {
  const s = o.scale ?? 1;
  const p = new Parts(TILE.metal);

  const W = 0.86; // 沿 X（进深）
  const H = 0.7;
  const D = 0.6; // 沿 Z（宽）

  p.box(W, H, D, 0, 0, 0);

  // 出风口护罩（轴沿 X：绕 Z 转 90° 把圆柱的 Y 轴倒到 X 上）+ 轮毂 + 3 片扇叶
  p.cyl(0.25, 0.25, 0.05, 8, -W * 0.5 - 0.02, 0, 0, 0, 0, Math.PI / 2, true);
  p.cyl(0.06, 0.06, 0.1, 6, -W * 0.5 + 0.02, 0, 0, 0, 0, Math.PI / 2);
  for (let k = 0; k < 3; k++) {
    p.box(0.03, 0.4, 0.07, -W * 0.5 + 0.03, 0, 0, (k * TAU) / 3);
  }

  // 侧面百叶（两片就够读出「这是台外机」）
  p.box(0.02, 0.06, D - 0.1, W * 0.5 + 0.01, 0.12, 0);
  p.box(0.02, 0.06, D - 0.1, W * 0.5 + 0.01, -0.06, 0);

  // 墙面托架 + 顺墙爬下去的冷媒管
  for (const dz of [-0.2, 0.2]) {
    p.box(0.52, 0.05, 0.06, 0.1, -H * 0.5 - 0.06, dz);
  }
  p.box(0.07, 0.34, 0.07, W * 0.42, -H * 0.5 - 0.14, 0.2);

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0, s));
}

// ---------------------------------------------------------------------------
// 6 · 管线
// ---------------------------------------------------------------------------

/**
 * 一段管线。`(x, y, z)` 是**管段中心**，`axis` 是走向（默认 'y'，立管），
 * `len` 是长度，`radius` 默认 0.06，`elbows` 为 true 时两端各加一个 90° 弯头短管。
 *
 * 管身用 8 段圆柱开口（16 tri）—— 封盖在墙里根本看不到，白送 16 个三角形没必要；
 * 弯头那两截才封盖（要露端面）。法兰同样用开口圆柱做箍，抱箍直接用盒子。
 * 实测：不带弯头 72 tri，带弯头 136 tri。
 */
export function pipeRunGeo(o: PipeRunOpts): THREE.BufferGeometry {
  const r = o.radius ?? 0.06;
  const len = Math.max(0.15, o.len);
  const axis = o.axis ?? 'y';
  const p = new Parts(TILE.metal);

  // 圆柱默认沿 Y。转到 X：绕 Z 转 90°；转到 Z：绕 X 转 90°。
  const rx = axis === 'z' ? Math.PI / 2 : 0;
  const rz = axis === 'x' ? Math.PI / 2 : 0;

  p.cyl(r, r, len, 8, 0, 0, 0, rx, 0, rz, true);

  // 两道法兰箍，位置在 ±len/4，给长管一点尺度参照
  const ax = axis === 'x' ? 1 : 0;
  const ay = axis === 'y' ? 1 : 0;
  const az = axis === 'z' ? 1 : 0;
  for (const t of [-0.25, 0.25]) {
    p.cyl(
      r * 1.35,
      r * 1.35,
      r * 0.9,
      8,
      ax * len * t,
      ay * len * t,
      az * len * t,
      rx,
      0,
      rz,
      true,
    );
  }

  // 抱箍（把管子固定在墙上的那两个铁卡子），用盒子，比圆环便宜得多
  for (const t of [-0.34, 0.34]) {
    p.box(
      r * 2.6 + (ax ? 0 : 0.04),
      r * 2.6 + (ay ? 0 : 0.04),
      r * 2.6 + (az ? 0 : 0.04),
      ax * len * t,
      ay * len * t,
      az * len * t,
    );
  }

  if (o.elbows === true) {
    // 两端各拐一个 90°：一小截封盖圆柱，方向取一条与主轴垂直的轴。
    // 立管(y) → 拐向 +Z（从墙上探出去接横管）；横管(x/z) → 拐向 -Y（顺墙爬下去）。
    const eLen = Math.max(0.12, r * 6);
    for (const s of [-1, 1]) {
      const px = ax * len * 0.5 * s;
      const py = ay * len * 0.5 * s;
      const pz = az * len * 0.5 * s;
      if (axis === 'y') {
        p.cyl(r, r, eLen, 8, px, py, pz + eLen * 0.5, Math.PI / 2);
      } else {
        p.cyl(r, r, eLen, 8, px, py - eLen * 0.5, pz);
      }
    }
  }

  return p.build(mat(o.x, o.y, o.z, 0, 0, 0));
}

// ---------------------------------------------------------------------------
// 7 · 木箱
// ---------------------------------------------------------------------------

/**
 * 木箱。`(x, y, z)` 是**落地点**（箱底中心），`size` 是边长（默认 0.85），
 * `rotY` 是额外偏航；不传 rotY 时按位置散列出一个 ±0.35rad 的随机偏航，
 * 这样一排箱子不会像货架。
 *
 * 主体 1 盒 + 4 根角柱 + 顶部 4 根边框 = 9 盒 = 108 tri。
 * 角柱和边框是让它「读起来是钉起来的板条箱」而不是一个纹理立方体的关键。
 */
export function crateGeo(o: CrateOpts): THREE.BufferGeometry {
  const s = o.size ?? 0.85;
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, s));
  const yaw = o.rotY ?? (rnd() - 0.5) * 0.7;
  const p = new Parts(TILE.wood);

  const h = s * 0.9;
  const t = Math.min(0.075, s * 0.09); // 板条厚度
  const half = s * 0.5;

  p.box(s, h, s, 0, h * 0.5, 0);

  // 四根角柱
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.box(t, h + 0.015, t, sx * (half - t * 0.35), h * 0.5, sz * (half - t * 0.35));
    }
  }
  // 顶部一圈边框
  p.box(s + t * 0.4, t, t, 0, h - t * 0.5, -(half - t * 0.35));
  p.box(s + t * 0.4, t, t, 0, h - t * 0.5, half - t * 0.35);
  p.box(t, t, s - t, -(half - t * 0.35), h - t * 0.5, 0);
  p.box(t, t, s - t, half - t * 0.35, h - t * 0.5, 0);

  // 微微侧倾（±1.5°）：堆在一起的箱子从来不是水平的
  const tiltX = (rnd() - 0.5) * 0.05;
  const tiltZ = (rnd() - 0.5) * 0.05;
  return p.build(mat(o.x, o.y, o.z, tiltX, yaw, tiltZ));
}

// ---------------------------------------------------------------------------
// 8 · 铁桶
// ---------------------------------------------------------------------------

/**
 * 200L 铁桶。`(x, y, z)` 是落地点；`tipped` 为 true 时**横躺**（轴沿局部 X，
 * 桶心抬到半径高），`rotY` 转朝向。
 *
 * 8 段封盖桶身 32 + 两道箍 32 + 顶沿 16 + 桶盖螺塞 12 = 92 tri。
 * 横躺的桶是好用的低掩体（0.6m），也是唯一会「滚」的视觉暗示。
 */
export function barrelGeo(o: BarrelOpts): THREE.BufferGeometry {
  const rnd = mulberry32(seedOf(o.x, o.y, o.z));
  const p = new Parts(TILE.metal);

  const R = 0.29;
  const H = 0.88;

  // 局部原点放在桶心，横躺时才好绕自己转
  p.cyl(R, R, H, 8, 0, 0, 0);
  p.cyl(R * 1.07, R * 1.07, 0.055, 8, 0, -H * 0.18, 0, 0, 0, 0, true);
  p.cyl(R * 1.07, R * 1.07, 0.055, 8, 0, H * 0.18, 0, 0, 0, 0, true);
  p.cyl(R * 1.04, R * 1.04, 0.05, 8, 0, H * 0.5 - 0.025, 0, 0, 0, 0, true);
  p.box(0.08, 0.035, 0.08, R * 0.45, H * 0.5 + 0.015, R * 0.2);

  const yaw = (o.rotY ?? 0) + (rnd() - 0.5) * 0.5;
  if (o.tipped === true) {
    // 绕自身 Z 转 90° 放倒（欧拉序 YXZ：Z 先作用于局部，再整体偏航）。
    // 抬升量按**箍**的半径算（R×1.07）而不是桶身半径，否则箍会陷进地面 1.5cm。
    return p.build(mat(o.x, o.y + R * 1.07 + 0.005, o.z, 0, yaw, Math.PI / 2));
  }
  return p.build(mat(o.x, o.y + H * 0.5, o.z, 0, yaw, 0));
}

// ---------------------------------------------------------------------------
// 9 · 垃圾箱
// ---------------------------------------------------------------------------

/**
 * 四轮铁皮垃圾箱。`(x, y, z)` 是落地点（箱体中心的地面投影），
 * `lidOpen` 为 true 时箱盖向后掀开约 107°，`rotY` 转朝向。
 *
 * **这是全场最典型的材质陷阱**：1.2m 高、看着比混凝土矮墙还厚实，
 * 实际穿透 0.55。掀开的盖子还会挡住后面的视线，是「以为安全」的第二层。
 * 6 盒 72 + 4 个 6 段轮子 96 = 168 tri。
 */
export function dumpsterGeo(o: DumpsterOpts): THREE.BufferGeometry {
  const rnd = mulberry32(seedOf(o.x, o.y, o.z));
  const p = new Parts(TILE.metal);

  const L = 1.95; // 沿 X
  const W = 0.98; // 沿 Z
  const bodyY0 = 0.18;
  const bodyH = 0.9;
  const topY = bodyY0 + bodyH;

  p.box(L * 0.92, 0.14, W * 0.88, 0, 0.14, 0); // 底裙
  p.box(L, bodyH, W, 0, bodyY0 + bodyH * 0.5, 0); // 箱体
  for (const sx of [-1, 1]) {
    p.box(0.06, bodyH * 0.95, W + 0.02, sx * L * 0.31, bodyY0 + bodyH * 0.5, 0); // 加强筋
  }

  // 铰链轴（贴 -Z 侧）+ 箱盖
  const hingeZ = -(W * 0.5 - 0.02);
  const hingeY = topY + 0.02;
  p.box(L * 0.97, 0.06, 0.06, 0, hingeY, hingeZ);

  const lidHalf = W * 0.52;
  if (o.lidOpen === true) {
    const th = -1.87; // 绕 X 掀起 ~107°，向后倚
    p.box(
      L + 0.04,
      0.07,
      W + 0.06,
      0,
      hingeY - lidHalf * Math.sin(th),
      hingeZ + lidHalf * Math.cos(th),
      th,
    );
  } else {
    p.box(L + 0.04, 0.07, W + 0.06, 0, hingeY + 0.03, hingeZ + lidHalf);
  }

  // 四个脚轮（轴沿 Z：绕 X 转 90°）。seg=6，一个 24 tri。
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      p.cyl(0.105, 0.105, 0.075, 6, sx * L * 0.37, 0.105, sz * W * 0.34, Math.PI / 2);
    }
  }

  return p.build(mat(o.x, o.y, o.z, 0, (o.rotY ?? 0) + (rnd() - 0.5) * 0.06, 0));
}

// ---------------------------------------------------------------------------
// 10 · 木托盘堆
// ---------------------------------------------------------------------------

/**
 * 木托盘堆。`(x, y, z)` 是落地点，`count` 是层数（上限 5），`rotY` 转朝向。
 *
 * 单层只建看得见的 3 块面板 + 2 根纵梁 = 5 盒 = 60 tri，**不建底板**
 * （堆起来以后底板永远看不见，全场省下几百个三角形）。层数上限 5 → 300 tri，
 * 这是唯一一个随参数线性增长的道具，堆高时请自己算预算。
 *
 * 每层有独立的偏航抖动（±4°）和水平偏移 —— 一摞完全对齐的托盘一眼假。
 */
export function palletStackGeo(o: PalletStackOpts): THREE.BufferGeometry {
  const n = clampI(o.count, 1, 5);
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, n));
  const p = new Parts(TILE.wood);

  const PL = 1.15; // 沿 X
  const PW = 0.78; // 沿 Z
  const PH = 0.14; // 单层高

  for (let i = 0; i < n; i++) {
    const a = (rnd() - 0.5) * 0.14;
    const ox = (rnd() - 0.5) * 0.06;
    const oz = (rnd() - 0.5) * 0.06;
    const by = i * PH;

    // 面板（3 块，沿 Z 分布），每块自己算旋转后的落点
    for (const t of [-0.32, 0, 0.32]) {
      const [dx, dz] = rotXZ(0, PW * t, a);
      p.box(PL, 0.024, PW * 0.22, ox + dx, by + PH - 0.012, oz + dz, 0, a);
    }
    // 两根纵梁
    for (const t of [-0.36, 0.36]) {
      const [dx, dz] = rotXZ(0, PW * t, a);
      p.box(PL, PH - 0.03, 0.09, ox + dx, by + (PH - 0.03) * 0.5, oz + dz, 0, a);
    }
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 11 · 布/铁皮雨棚
// ---------------------------------------------------------------------------

/**
 * 雨棚。`(x, y, z)` 是**贴墙的上沿挂点**，棚面沿 `facing`（±X）挑出 `d`，
 * 沿 ±Z 展开 `w`。棚面是 4 段折线拟合的抛物线（下垂 0.45×d），
 * 前端挂一条挡水裙边。
 *
 * 关卡作用：把它下面的东西压进阴影里，制造「看得见入口看不清里面」的门廊。
 * 4 段棚面 + 裙边 + 挂条 + 2 根斜撑 = 8 盒 = 96 tri。
 */
export function awningGeo(o: AwningOpts): THREE.BufferGeometry {
  const w = Math.max(0.6, o.w);
  const d = Math.max(0.4, o.d);
  const drop = d * 0.45;
  const p = new Parts(TILE.metal);

  // 墙上的挂条
  p.box(0.09, 0.11, w + 0.1, 0.045, 0, 0);

  // 棚面：p(t) = (d·t, -drop·t²)，4 段折线。strut 的方向在 XY 平面内，
  // 旋转轴是 ±Z，所以每段的局部 Z（宽度 w）保持世界 Z，不会被拧歪。
  const seg = 4;
  for (let i = 0; i < seg; i++) {
    const t0 = i / seg;
    const t1 = (i + 1) / seg;
    p.strut(
      0.035,
      w,
      _tmpA.set(d * t0, -drop * t0 * t0, 0),
      _tmpB.set(d * t1, -drop * t1 * t1, 0),
    );
  }

  // 前沿裙边
  p.box(0.03, 0.24, w, d + 0.01, -drop - 0.11, 0);

  // 两根斜撑（顶住前沿，也是唯一挡子弹的部分——其实也挡不住，metal 0.55）
  for (const s of [-1, 1]) {
    const zb = s * (w * 0.5 - 0.09);
    p.strut(
      0.045,
      0.045,
      _tmpA.set(0.06, 0.42, zb),
      _tmpB.set(d - 0.05, -drop + 0.04, zb),
    );
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.facing === 1 ? 0 : Math.PI, 0));
}

// ---------------------------------------------------------------------------
// 12 · 招牌
// ---------------------------------------------------------------------------

/**
 * 墙挂/挑出式招牌。`(x, y, z)` 是**牌面中心**，牌面法线沿局部 ±X，
 * 高 `h` 沿 Y、宽 `w` 沿 Z，`rotY` 转朝向。
 *
 * 上沿带一个投光灯罩 —— 如果 alley.ts 想在这加一盏暖光（PointLight 80~250），
 * 灯罩下方 0.12m 就是现成的挂点；自发光面记得用 MeshBasicMaterial + toneMapped:false，
 * 颜色乘 1.4~2.4 才过得了 bloom 阈值 0.85。
 * 8 盒 = 96 tri。
 */
export function signBoardGeo(o: SignBoardOpts): THREE.BufferGeometry {
  const w = Math.max(0.3, o.w);
  const h = Math.max(0.25, o.h);
  const p = new Parts(TILE.metal);

  p.box(0.05, h, w, 0, 0, 0); // 牌面
  p.box(0.075, 0.06, w + 0.1, 0, h * 0.5 + 0.03, 0); // 上边框
  p.box(0.075, 0.06, w + 0.1, 0, -h * 0.5 - 0.03, 0); // 下边框
  p.box(0.075, h, 0.06, 0, 0, -(w * 0.5 + 0.03)); // 左边框
  p.box(0.075, h, 0.06, 0, 0, w * 0.5 + 0.03); // 右边框

  // 两根挂臂（往墙里去）
  for (const s of [-1, 1]) {
    p.box(0.32, 0.05, 0.05, -0.18, h * 0.3, s * w * 0.32);
  }
  // 上沿投光灯罩
  p.box(0.2, 0.06, w * 0.66, 0.08, h * 0.5 + 0.14, 0, 0, 0, -0.3);

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 13 · 窗框
// ---------------------------------------------------------------------------

/**
 * 窗框（**只有框，不含玻璃**）。`(x, y, z)` 是洞口中心，洞口高 `h` 沿 Y、
 * 宽 `w` 沿 Z，框厚沿 ±X，`rotY` 转朝向，`mullions` 是竖向窗棂根数（0~4，默认 1）。
 *
 * 玻璃是另一种材质（穿透 0.95，要单独一个 glass 桶和一个半透明材质），
 * 所以这里不出玻璃 —— 配套用 `glassPaneGeo()` 拿一块尺寸对齐的玻璃丢进 glass 桶。
 * 上下框 + 左右框 + 4 窗棂 + 1 横挺 = 9 盒 = 108 tri。
 */
export function windowFrameGeo(o: WindowFrameOpts): THREE.BufferGeometry {
  const w = Math.max(0.3, o.w);
  const h = Math.max(0.3, o.h);
  const n = clampI(o.mullions ?? 1, 0, 4);
  const p = new Parts(TILE.metal);

  p.box(0.14, 0.1, w + 0.24, 0, h * 0.5 + 0.05, 0); // 上框
  p.box(0.22, 0.12, w + 0.24, 0.04, -h * 0.5 - 0.06, 0); // 窗台（外挑一点，挡雨）
  p.box(0.14, h, 0.1, 0, 0, -(w * 0.5 + 0.05)); // 左框
  p.box(0.14, h, 0.1, 0, 0, w * 0.5 + 0.05); // 右框

  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    p.box(0.08, h, 0.06, 0, 0, -w * 0.5 + w * t);
  }
  p.box(0.07, 0.055, w, 0, h * 0.18, 0); // 横挺

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

/**
 * 配套玻璃（补充导出，不在契约清单里但 windowFrameGeo 离了它没法用）。
 * 尺寸自动内收 2cm 嵌进框里，厚 3cm。丢进 alley.ts 的 `glass` 桶。12 tri。
 */
export function glassPaneGeo(o: WindowFrameOpts): THREE.BufferGeometry {
  const w = Math.max(0.3, o.w);
  const h = Math.max(0.3, o.h);
  const p = new Parts(TILE.glass);
  p.box(0.03, h - 0.02, w - 0.02, -0.02, 0, 0);
  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 14 · 门框
// ---------------------------------------------------------------------------

/**
 * 门框（**只有框，不含门扇**）。`(x, y, z)` 是**洞口底边中心**（地面高度），
 * 洞口高 `h` 沿 Y、宽 `w` 沿 Z，框厚沿 ±X，`rotY` 转朝向。
 *
 * 门扇通常是木头（穿透 0.75）、框是金属（0.55），两种材质要进两个桶，
 * 所以门扇请调用方自己用一个 `crateGeo` 尺寸的盒子做，或者干脆不做 ——
 * alley.ts 现有的三个凹进都是敞开的门洞，敞开本身就是「切派清角」的场景。
 * 7 盒 = 84 tri。
 */
export function doorFrameGeo(o: DoorFrameOpts): THREE.BufferGeometry {
  const w = Math.max(0.5, o.w);
  const h = Math.max(1.2, o.h);
  const p = new Parts(TILE.metal);

  for (const s of [-1, 1]) {
    p.box(0.16, h, 0.12, 0, h * 0.5, s * (w * 0.5 + 0.06)); // 门樘
  }
  p.box(0.16, 0.14, w + 0.24, 0, h + 0.07, 0); // 门楣
  p.box(0.24, 0.05, w + 0.14, 0.03, 0.025, 0); // 门槛（2.5cm，跨得过去，不影响移动手感）

  // 两个铰链座 + 一块门吸铁板：小细节，但让门洞不再是「墙上的一个矩形洞」
  p.box(0.1, 0.16, 0.16, 0.05, h * 0.78, -(w * 0.5 + 0.02));
  p.box(0.1, 0.16, 0.16, 0.05, h * 0.22, -(w * 0.5 + 0.02));
  p.box(0.09, 0.28, 0.05, 0.05, h * 0.5, w * 0.5 + 0.02);

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

// ---------------------------------------------------------------------------
// 15 · 碎石堆
// ---------------------------------------------------------------------------

/**
 * 碎石/瓦砾堆。`(x, y, z)` 是堆的中心落地点，`radius` 是摊开半径，
 * `count` 是石块数（上限 16 → 192 tri），`seed` 显式给（同一处想换一堆形状就改 seed）。
 *
 * 石块用 `chunk()`：按 8 个角分组扰动顶点，做出崩裂面，最后统一 computeVertexNormals。
 * 分组是必须的 —— BoxGeometry 每个角有 3 个顶点（各属一个面），逐顶点乱位移会把盒子撕开。
 * 越靠中心块越大（`1 - r/radius` 驱动），符合塌落物的自然堆积。
 *
 * 关卡作用：**不是掩体**，是给「这里塌过」讲故事的地面装饰，顺便打乱脚步节奏。
 * 高度压在 0.35m 以内，不会挡住蹲姿视线，也不会卡住玩家胶囊（本来也不该进 Octree）。
 * 石块会有约 0.15m 埋进地面 —— 这是故意的，整整齐齐浮在地面上的碎石一眼假。
 * 所以不要把它摆在悬空平台/阳台上，只摆在实心地面上。
 */
export function rubblePileGeo(o: RubblePileOpts): THREE.BufferGeometry {
  const count = clampI(o.count, 1, 16);
  const R = Math.max(0.15, o.radius);
  const rnd = mulberry32(o.seed >>> 0);
  const p = new Parts(TILE.concrete);

  for (let i = 0; i < count; i++) {
    const ang = rnd() * TAU;
    const rr = R * Math.sqrt(rnd()); // sqrt 让散点在圆盘上均匀，不会挤在中心
    const t = 1 - rr / R; // 中心大、边缘小
    const s = (0.09 + 0.24 * t) * (0.55 + rnd() * 0.85);
    p.chunk(
      s,
      s * (0.45 + rnd() * 0.5),
      s * (0.7 + rnd() * 0.6),
      Math.cos(ang) * rr,
      s * 0.3,
      Math.sin(ang) * rr,
      (rnd() - 0.5) * 0.9,
      rnd() * TAU,
      (rnd() - 0.5) * 0.9,
      rnd,
      s * 0.26,
    );
  }

  // 做了顶点位移 → 必须重算法线（BoxGeometry 每面独立顶点，重算后仍是硬边，不会糊）
  return p.build(mat(o.x, o.y, o.z, 0, 0, 0), true);
}

// ---------------------------------------------------------------------------
// 16 · 晾衣绳
// ---------------------------------------------------------------------------

/**
 * 横跨巷子的晾衣绳 + 挂着的床单。两个端点 `(x1,y1,z1)`→`(x2,y2,z2)` 都是
 * **世界坐标**（不是相对量），所以这个函数没有 rotY —— 朝向由两点决定。
 *
 * 绳子用 6 段折线拟合悬链线（下垂 = 0.05×跨度），布片挂在绳上、
 * 沿绳向排开、各自有一点随风的侧倾。
 *
 * 关卡作用：这是**巷战最好用的视线遮断** —— 不挡子弹（贴的是布），
 * 但在 3~5m 高度把长条视线切碎，逼玩家往前推。alley.ts 请把它单独放一个
 * 布料材质桶（DoubleSide、roughness 1.0），别混进 wood。
 * 6 段绳 + 6 片布 = 12 盒 = 144 tri。
 */
export function clothesLineGeo(o: ClothesLineOpts): THREE.BufferGeometry {
  const sheets = clampI(o.sheets, 0, 6);
  const rnd = mulberry32(o.seed >>> 0);
  const p = new Parts(TILE.cloth);

  const dx = o.x2 - o.x1;
  const dy = o.y2 - o.y1;
  const dz = o.z2 - o.z1;
  const span = Math.hypot(dx, dz);
  if (span < 1e-4) return finalize(emptyGeo());
  const sag = 0.05 * span + 0.02 * sheets;

  /** 悬链线近似：抛物线下垂，t=0.5 处最低。 */
  const at = (t: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(
      o.x1 + dx * t,
      o.y1 + dy * t - sag * 4 * t * (1 - t),
      o.z1 + dz * t,
    );

  // 绳段（0.018 见方的盒子；一根 12 tri，比任何圆柱都便宜）
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    p.strut(0.018, 0.018, at(i / segs, _tmpA), at((i + 1) / segs, _tmpB));
  }

  // 布片：局部 X 沿绳的水平走向 → ry 使 (1,0,0) 转到 (dxn, 0, dzn)
  const ry = Math.atan2(-dz / span, dx / span);
  for (let i = 0; i < sheets; i++) {
    const t = (i + 0.5 + (rnd() - 0.5) * 0.35) / sheets;
    at(clampF(t, 0.08, 0.92), _tmpA);
    const sw = 0.42 + rnd() * 0.4; // 沿绳宽度
    const sh = 0.5 + rnd() * 0.65; // 垂下高度
    p.box(
      sw,
      sh,
      0.018,
      _tmpA.x,
      _tmpA.y - 0.035 - sh * 0.5,
      _tmpA.z,
      (rnd() - 0.5) * 0.22, // 绕绳向翻一点（风）
      ry,
      (rnd() - 0.5) * 0.16, // 挂歪一点
    );
  }

  // 两点已经是世界坐标，根矩阵是单位阵
  return p.build(mat(0, 0, 0));
}

// ---------------------------------------------------------------------------
// 17 · 爬梯
// ---------------------------------------------------------------------------

/**
 * 贴墙爬梯。`(x, y, z)` 是**底端落点**，梯子沿 +Y 爬 `height`，
 * 梯宽 0.44m 展在局部 ±Z，两个墙撑伸向局部 -X，`rotY` 转朝向
 * （装右墙 x=+4 上传 rotY=0 时墙撑朝 -X，也就是背对巷子 —— 装左墙请传 Math.PI）。
 *
 * 踏杆按 0.32m 间距推，上限 12 根（16 盒 = 192 tri）。
 * 和 fireEscapeGeo 的下放梯不同，这个是**贴墙固定**的，可以做成真能爬的
 * 垂直通道（如果 player.ts 以后加攀爬），所以两根边梃是实心的、可当细掩体。
 */
export function ladderGeo(o: LadderOpts): THREE.BufferGeometry {
  const H = Math.max(0.6, o.height);
  const rnd = mulberry32(seedOf(o.x, o.y, o.z, H));
  const p = new Parts(TILE.metal);

  const halfW = 0.22;
  for (const s of [-1, 1]) {
    p.box(0.05, H, 0.055, 0, H * 0.5, s * halfW);
  }

  const n = clampI(H / 0.32, 2, 12);
  const gap = H / (n + 1);
  for (let k = 0; k < n; k++) {
    p.box(0.05, 0.035, halfW * 2, 0, gap * (k + 1), 0, 0, 0, (rnd() - 0.5) * 0.02);
  }

  // 两个墙撑（把梯子架离墙面 ~0.16m，背光时能读出一条缝）
  for (const t of [0.12, 0.88]) {
    p.box(0.18, 0.05, halfW * 2 + 0.1, -0.1, H * t, 0);
  }

  return p.build(mat(o.x, o.y, o.z, 0, o.rotY ?? 0, 0));
}

/**
 * 《暗巷 BACKSTREET》M0+ 关卡 —— 56m 主巷 + 二层立体走道 + 侧巷环线 + 远端小广场。
 *
 * ── 这一版扩建了什么 ───────────────────────────────────────────────
 *
 * 1. **主巷延长到 ~56m**（z: +21.3 → -24 是巷子，-24 → -34 是小广场）。
 *    出生点、四个原始敌人位、路灯(z≈2) / 落地窗(z≈-11.5) / 火桶(z≈-17.5)
 *    三处暖光锚点全部原样保留 —— 那套亮度是实测标定过的，不动。
 *
 * 2. **垂直层（本次的主角）**。设计文档里「不加资产就能提升战术深度的最大杠杆」：
 *      · 右墙两段室外逃生梯（FE1 z≈8~15.6 / FE2 z≈-19.4~-11.4）→ 二层
 *      · 三段二层走道 A(右) / B(左) / C(右) 呈 **Z 字交错**，
 *        中间用两段横跨巷子的连桥相接 —— 过桥的那两秒是全场最暴露的时刻
 *      · 一处**室内楼梯间**藏在半降的铁皮卷帘门后面（z≈6.6，必须蹲着钻进去），
 *        是争夺二楼视野的唯一室内通道
 *      · 二层地板是实体（collider 里有），栏杆**不是**实体：
 *        想下去随时可以跨过 0.25m 挡水台跳下来。垂直流动性 > 防呆。
 *
 * 3. **侧巷环线**。主巷左墙 z≈-4 开口 → 西 4m → 南 9.6m（死路）
 *    → **木板围挡** → 折回段 → 主巷 z≈-16.7（火桶旁边）重新汇入。
 *    围挡是 wood(穿透 0.75)：子弹随便过，人只能从下面那道 1.5m 高的破口**蹲着**钻。
 *    这就是「需要开枪开路的侧翼」——一条随时可能被打穿的迂回路。
 *
 * 4. **小广场**（16m × 10m）。垂直度在这里结束，换成开阔的低掩体对抗，
 *    给整条动线一个节奏上的收束。
 *
 * ── 掩体纪律（Level Design Book）─────────────────────────────────
 *   · 低掩体优于高掩体：主力掩体全部 0.9~1.2m，蹲下全遮、站起能打。
 *   · 交错摆放 + 保留清晰视线：左右交替，间隔 ~5m，中间不塞东西。
 *   · 宜少不宜多：56m 主巷 + 广场 + 侧巷一共只有 13 组独立掩体，全部可 360° 绕。
 *   · 90° 锐角：三处凹进 / 侧巷两个直角 / 广场装卸台角，都是标准的「切派」清角场景。
 *   · **材质即信息**：只有 concrete 是真掩体；metal(0.55) / wood(0.75) 看着像掩体
 *     其实是陷阱；二层栏杆是 metal —— 半掩体，挡得住轮廓挡不住子弹。
 *
 * ── 性能纪律 ────────────────────────────────────────────────────
 *   · 同材质几何全部 mergeGeometries 合并 → 全场 9 个实体网格（= 9 个 hitMesh）
 *     + 6 个自发光装饰 + 2 个 InstancedMesh。
 *   · 碰撞体只用**盒子代理**建（不是渲染几何）：examples 的 Octree 在 split() 里
 *     `new Octree(box)`，子树拿不到 trianglesPerLeaf/maxLevel，一旦某个小体积里
 *     堆了几十个三角形（圆柱侧面、钢筋、窗棂、栏杆）就会一路细分到 16 层，
 *     再把地面那几个巨大三角形复制进每一片叶子。用盒子代理后节点数掉一个量级。
 *   · 楼梯/逃生梯：**渲染是真台阶，碰撞是一块隐形斜坡**。胶囊在 0.3m 台阶上会一格
 *     一格顿挫，斜坡则是丝滑的；玩家看到的仍然是台阶。所有斜坡 ≤ 32°。
 *
 * 零外部资源：几何全部代码生成，贴图全部来自 vfx/textures.ts 的 Canvas 程序化贴图。
 *
 * > 注：几何工厂库 `props.ts` 由另一个 agent 并行编写。本文件目前**自带**等价的
 * > 局部工厂（`propCrate` / `propBarrel` / `propDumpster` / … 一组同名函数），
 * > 保证单文件即可编译通过；props.ts 落地后把这些局部函数换成 import 即可，
 * > 调用点的形参形状是照着约定的 `{x, y, z, …, rotY}` 写的。
 */

import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';

import type { SurfaceKind } from '../types';
import { concreteTexture, metalTexture, woodTexture } from '../vfx/textures';
import { time, setUnscaledTimeout, clamp } from '../core/time';
import {
  acUnitGeo,
  awningGeo,
  balconyGeo,
  barrelGeo,
  clothesLineGeo,
  crateGeo,
  doorFrameGeo,
  dumpsterGeo,
  fireEscapeGeo,
  glassPaneGeo,
  ladderGeo,
  palletStackGeo,
  pipeRunGeo,
  railingGeo,
  rubblePileGeo,
  signBoardGeo,
  stairGeo,
  windowFrameGeo,
} from './props';
import { fbmSigned, noiseSigned, mulberry32 } from '../core/noise';

// ---------------------------------------------------------------------------
// three-mesh-bvh 挂载（幂等；weapon / enemy 层若重复挂载同样安全）
// ---------------------------------------------------------------------------

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
// acceleratedRaycast 内部会检查 geometry.boundsTree，没有 BVH 的网格自动回退到原生 raycast。
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export interface LevelBuild {
  group: THREE.Group;
  collider: Octree;
  /** 供 hitscan BVH 射线用的实体网格列表，每个 mesh.userData.surface: SurfaceKind */
  hitMeshes: THREE.Mesh[];
  spawnPoint: THREE.Vector3;
  enemySpawns: THREE.Vector3[];
}

// ---------------------------------------------------------------------------
// 尺寸常量
// ---------------------------------------------------------------------------

const HALF_W = 4.0; // 主巷宽 8m，两侧内墙面在 x = ±4
const WALL_T = 0.5; // 墙厚
const WALL_CX = HALF_W + WALL_T * 0.5; // 主巷墙体中心 x = 4.25
const WALL_H = 8.0; // 主巷墙高（高到看不见天，形成峡谷感）

const Z_NEAR = 21.3; // 玩家端封口
const Z_MOUTH = -24.0; // 主巷 / 广场交界（主巷本体 45.3m）

/** 小广场：16m × 10m。主巷 45.3 + 广场 10 ≈ 56m 总长 */
const PZ_HALF = 8.0; // 广场半宽（内墙面 x = ±8）
const PZ_CX = PZ_HALF + WALL_T * 0.5; // 广场墙体中心 8.25
const PZ_FAR = -34.0; // 广场远端内墙面
const PZ_H = 7.0; // 广场墙高（比主巷矮 1m，出巷口时天开一点）

/** 二层地板顶面高度。1.8m 站姿 + 1.8m 净空，上下都不压抑 */
const Y2 = 3.6;
const DECK_T = 0.3; // 楼板厚
const DECK_D = 2.3; // 走道进深
const DECK_X_IN = HALF_W - DECK_D; // 走道内沿 x = 1.7
const RAIL_H = 1.1; // 栏杆高（半掩体：站着上半身露出来）
/**
 * 平台板往斜坡里多探出去的量。
 * 斜坡代理是一块**有厚度**的斜板，它的端面垂直于坡面，所以顶面沿 z 的覆盖范围
 * 会比 [z0,z1] 偏移约 thick/2·sin(pitch) ≈ 0.1m —— 正好落在梯段与平台的接缝上，
 * 踩上去会掉进那 0.1m 的空档。平台板两端各多压 0.16m 就把接缝盖死了，
 * 代价是接缝处一个 0.09m 的小台阶（胶囊底球半径 0.35m，走过去无感）。
 */
const LAND_OVER = 0.16;
const KERB_H = 0.25; // 楼板边缘挡水台 —— 防止误滑落，跳一下就能过去

const SIDE_H = 6.0; // 侧巷墙高（比主巷矮，读起来是「更次一级的空间」）
const DOOR_W = 2.4;
const DOOR_H = 2.5;

/** 门洞中心 z */
const DOOR_R1 = -7.8; // 右墙，敞开的深凹进（敌人点 #3，切派清角）
const DOOR_R2 = 6.6; // 右墙，半降的铁皮卷帘门 → 楼梯间（唯一室内上楼通道）
const DOOR_L1 = 0.9; // 左墙，敞开的浅凹进

/** 卷帘门下沿高度：1.35m > 蹲姿 1.2m，所以「必须蹲着钻」，站着过不去 */
const SHUTTER_GAP = 1.35;

// ---- 侧巷环线 ----
const SA_X = -8.0; // 侧巷远端内墙面
const SA_CX = SA_X - WALL_T * 0.5; // 侧巷外墙中心 -8.25
const SA_A_Z0 = -5.6; // A 段（东西向）南边界
const SA_A_Z1 = -2.6; // A 段北边界 —— 主巷左墙开口就是这 3m
const SA_B_X = -5.0; // B 段（南北向）东边界；B 段与主巷之间是 1m 厚隔墙
const SA_B_Z = -15.2; // B 段南端 = 木板围挡所在平面
const SA_C_Z = -18.2; // C 段（折回段）南边界
const GATE_GAP_X0 = -6.95; // 围挡上那道破口的 x 范围（1.5m 高，只有蹲着才钻得过）
const GATE_GAP_X1 = -5.95;
const GATE_GAP_H = 1.5;

// ---- 楼梯间（右墙后面的竖井）----
const ST_X0 = 4.5;
const ST_X1 = 8.0;
const ST_CX = ST_X1 + WALL_T * 0.5; // 8.25
const ST_Z0 = 0.6;
const ST_Z1 = 8.2;
const ST_MID_Y = 2.0; // 中间平台高度（下方净空 1.86m，站着刚好过）

// ---- 二层三段走道（Z 字交错）----
const A_Z0 = 5.2;
const A_Z1 = 13.4; // 平台 A：右墙，俯瞰出生端接近路
const B_Z0 = -3.0;
const B_Z1 = 6.4; // 平台 B：左墙，俯瞰路灯段
const C_Z0 = -19.5;
const C_Z1 = -1.9; // 平台 C：右墙，俯瞰主巷中段与远段（最长的一段）
const CW1_Z0 = 5.2; // 连桥 1（钢制走道）A ↔ B
const CW1_Z1 = 6.4;
const CW2_Z0 = -3.0; // 连桥 2（跳板压在两根大管道上）B ↔ C
const CW2_Z1 = -1.9;

// ---------------------------------------------------------------------------
// 材质分组 —— 同类项合并成一个 Mesh
// 每个合并网格就是一个 hitMesh，userData.surface 决定穿透 / 弹着 / 音效。
// ---------------------------------------------------------------------------

type MatKey =
  | 'concreteFloor'
  | 'concreteWall'
  | 'concreteCover'
  | 'brick'
  | 'metalStruct' // 雨棚 / 卷帘门 / 楼板 / 栏杆 / 楼梯 / 管道（建筑结构件）
  | 'metalProp' // 垃圾箱 / 铁桶 / 空调外机（可推倒的道具感）
  | 'wood'
  | 'glass'
  | 'puddle';

const KEY_SURFACE: Record<MatKey, SurfaceKind> = {
  concreteFloor: 'concrete',
  concreteWall: 'concrete',
  concreteCover: 'concrete',
  brick: 'brick',
  metalStruct: 'metal',
  metalProp: 'metal',
  wood: 'wood',
  glass: 'glass',
  puddle: 'dirt',
};

/** 每个材质组一张贴图平铺多少米重复一次（UV 直接烘进几何，材质 repeat 保持 1）。 */
const TILE: Record<MatKey, number> = {
  concreteFloor: 2.6,
  concreteWall: 2.4,
  concreteCover: 1.6,
  brick: 1.1,
  metalStruct: 1.0,
  metalProp: 0.9,
  wood: 0.8,
  glass: 1.0,
  puddle: 3.0,
};

const CASTS_SHADOW: Record<MatKey, boolean> = {
  concreteFloor: false, // 地面只收阴影，自己不投（省 shadow map 填充）
  concreteWall: true,
  concreteCover: true,
  brick: true,
  metalStruct: true,
  metalProp: true,
  wood: true,
  glass: false, // 玻璃投不透明阴影会很假
  puddle: false,
};

// ---------------------------------------------------------------------------
// 几何工具
// ---------------------------------------------------------------------------

/**
 * 把 BoxGeometry 的 UV 按真实世界尺寸重标定，让所有盒子共用一张贴图时密度一致。
 * BoxGeometry(segments=1) 的顶点顺序固定为 +X,-X,+Y,-Y,+Z,-Z，每面 4 个顶点。
 * 面内 u/v 对应的世界轴：±X → (d,h)，±Y → (w,d)，±Z → (w,h)。
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

/** 圆柱 / 圆盘等的 UV 统一缩放（近似即可，圆柱侧面 u 环绕、v 沿高）。 */
function scaleUV(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _identity = new THREE.Matrix4();

function xform(x: number, y: number, z: number, ry = 0, rz = 0, rx = 0): THREE.Matrix4 {
  _euler.set(rx, ry, rz, 'YXZ');
  _quat.setFromEuler(_euler);
  _pos.set(x, y, z);
  return new THREE.Matrix4().compose(_pos, _quat, _one);
}

/** 绕 Y 转 ry 后，沿局部 +X 走 d 米落在世界的 (x, z)。摆同一物件的两端配件用。 */
function offX(x: number, z: number, ry: number, d: number): [number, number] {
  return [x + Math.cos(ry) * d, z - Math.sin(ry) * d];
}

/**
 * 累积几何 → 按材质组合并。
 *
 * 同时维护两套几何：
 *  - **渲染 / 命中几何**：全细节，按材质分桶合并，每桶一个 Mesh + 一棵 BVH。
 *  - **碰撞代理**：只有盒子和斜坡板。原因见文件头的性能纪律。
 */
class Builder {
  private buckets = new Map<MatKey, THREE.BufferGeometry[]>();
  private colliders: THREE.BufferGeometry[] = [];
  private collideOn = true;

  /** 在回调里生成的东西只渲染 / 可被子弹打中，不参与胶囊碰撞。 */
  detail(fn: () => void): void {
    const prev = this.collideOn;
    this.collideOn = false;
    try {
      fn();
    } finally {
      this.collideOn = prev;
    }
  }

  push(key: MatKey, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    geo.applyMatrix4(m);
    let arr = this.buckets.get(key);
    if (arr === undefined) {
      arr = [];
      this.buckets.set(key, arr);
    }
    arr.push(geo);
  }

  /**
   * 收下 props.ts 已经摆到世界坐标的成品几何。
   * props 的 finalize() 保证属性集合是 position/normal/uv 且一定 indexed，
   * 和这里 BoxGeometry / CylinderGeometry 的布局一致，所以能并进同一个桶。
   * **永远不进碰撞体** —— 道具的碰撞由调用方另外 proxy 一个包围盒。
   */
  geo(key: MatKey, geo: THREE.BufferGeometry): void {
    this.push(key, geo, _identity);
  }

  /** 只进碰撞体的盒子代理（给一堆细碎几何做一个整体包围盒时用）。 */
  proxy(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void {
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.applyMatrix4(xform(x, y, z, ry, rz, rx));
    this.colliders.push(g);
  }

  /**
   * 沿 Z 走向的斜坡碰撞代理：顶面**正好**穿过 (z0,y0)-(z1,y1) 这条线。
   * 楼梯 / 逃生梯的碰撞全部走它 —— 台阶只负责好看，走起来是丝滑的斜面。
   */
  rampProxy(
    cx: number,
    width: number,
    z0: number,
    y0: number,
    z1: number,
    y1: number,
    thick = 0.4,
  ): void {
    const dz = z1 - z0;
    const dy = y1 - y0;
    const len = Math.hypot(dz, dy);
    if (len < 1e-4) return;
    // 局部 +Z 要指向 (0, dy/len, dz/len)。Rx(θ) 把 +Z 映到 (0,-sinθ,cosθ)。
    const rx = Math.atan2(-dy, dz);
    const cosPitch = Math.abs(dz) / len;
    // 顶面平面下移 thick/(2·cosPitch)，恰好让顶面通过两端点
    const drop = thick / (2 * Math.max(0.2, cosPitch));
    this.proxy(width, thick, len, cx, (y0 + y1) * 0.5 - drop, (z0 + z1) * 0.5, 0, 0, rx);
  }

  /** 轴对齐 / 绕 Y、Z 旋转的盒子 —— 关卡里 90% 的东西 */
  box(
    key: MatKey,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
  ): void {
    const g = new THREE.BoxGeometry(w, h, d);
    boxUV(g, w, h, d, TILE[key]);
    this.push(key, g, xform(x, y, z, ry, rz));
    if (this.collideOn) this.proxy(w, h, d, x, y, z, ry, rz);
  }

  /** 顶面在 top 的板（楼板 / 平台 / 台阶最常用的写法，省得每次心算 y 中心） */
  slab(key: MatKey, w: number, d: number, cx: number, top: number, cz: number, t: number): void {
    this.box(key, w, t, d, cx, top - t * 0.5, cz);
  }

  /** 立式圆柱（铁桶、垃圾桶、立管）。碰撞用外接方盒代理。 */
  cyl(
    key: MatKey,
    rTop: number,
    rBot: number,
    h: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
    rz = 0,
    rx = 0,
  ): void {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
    const circ = Math.PI * (rTop + rBot);
    scaleUV(g, circ / TILE[key], h / TILE[key]);
    this.push(key, g, xform(x, y, z, ry, rz, rx));
    if (this.collideOn) {
      const r = Math.max(rTop, rBot) * 1.72; // 正多边形外接方盒略收一点，避免碰撞比看起来大
      this.proxy(r, h, r, x, y, z, ry, rz);
    }
  }

  /** 任意两点之间的杆件（吊杆、钢筋、缆绳、横管）。永远不进碰撞体。 */
  rod(key: MatKey, from: THREE.Vector3, to: THREE.Vector3, r: number, seg = 8): void {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    scaleUV(g, (2 * Math.PI * r) / TILE[key], len / TILE[key]);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.normalize(),
    );
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    this.push(key, g, new THREE.Matrix4().compose(mid, q, _one));
  }

  /** 贴地的椭圆积水面。只渲染 + 可命中，不进碰撞体（6mm 厚的面片会让胶囊抖）。 */
  puddle(x: number, z: number, rx: number, rz: number, ry = 0): void {
    const g = new THREE.CircleGeometry(1, 20);
    scaleUV(g, 2 / TILE.puddle, 2 / TILE.puddle);
    g.rotateX(-Math.PI / 2);
    g.scale(rx, 1, rz);
    this.push('puddle', g, xform(x, 0.006, z, ry));
  }

  entries(): [MatKey, THREE.BufferGeometry[]][] {
    return [...this.buckets.entries()];
  }

  colliderGeometry(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.colliders, false);
    for (const g of this.colliders) g.dispose();
    return merged;
  }
}

// ---------------------------------------------------------------------------
// 复合几何工厂
//
// 名字和形参形状对齐并行开发中的 `props.ts`（`{x, y, z, …, rotY}`）。
// props.ts 落地后把这一节整体删掉、改成 import 即可，调用点不用动。
// ---------------------------------------------------------------------------

interface Placed {
  x: number;
  y: number;
  z: number;
  rotY?: number;
}

/** 长栏杆切成 ≤8m 的段：props 的 railingGeo 立柱上限 12 根，太长会稀得像晾衣架。 */
const RAIL_SEG_MAX = 8;

/** 木箱（wood 0.75 —— 挡视线不挡子弹）。碰撞用一个盒子代理。 */
function propCrate(b: Builder, o: Placed & { size: number; height?: number }): void {
  const h = o.height ?? o.size * 0.9;
  b.geo('wood', crateGeo({ x: o.x, y: o.y, z: o.z, size: o.size, rotY: o.rotY }));
  b.proxy(o.size, h, o.size * 0.92, o.x, o.y + h * 0.5, o.z, o.rotY ?? 0);
}

/** 废油桶（metal 0.55 —— 看着像掩体的陷阱） */
function propBarrel(b: Builder, o: Placed & { height?: number; radius?: number }): void {
  const h = o.height ?? 0.92;
  const r = o.radius ?? 0.3;
  b.geo('metalProp', barrelGeo({ x: o.x, y: o.y, z: o.z, rotY: o.rotY }));
  b.proxy(r * 1.72, h, r * 1.72, o.x, o.y + h * 0.5, o.z);
}

/** 大铁皮垃圾箱（metal 0.55 —— 全场最像掩体的陷阱） */
function propDumpster(b: Builder, o: Placed & { width: number; height: number }): void {
  b.geo('metalProp', dumpsterGeo({ x: o.x, y: o.y, z: o.z, rotY: o.rotY }));
  b.proxy(o.width, o.height, o.width * 0.48, o.x, o.y + o.height * 0.5, o.z, o.rotY ?? 0);
}

/** 木托盘堆（wood 0.75）。整堆一个代理盒，别让 Octree 在层间 30cm 的缝里炸开。 */
function propPalletStack(b: Builder, o: Placed & { count: number }): void {
  b.geo('wood', palletStackGeo({ x: o.x, y: o.y, z: o.z, count: o.count, rotY: o.rotY }));
  b.proxy(1.2, 0.145 * o.count, 1.0, o.x, o.y + 0.145 * o.count * 0.5, o.z, o.rotY ?? 0);
}

/** 空调外机（metal）：墙面唯一的立体细节，也是可打碎感的靶标 */
function propAcUnit(b: Builder, o: Placed & { side: 1 | -1 }): void {
  b.geo('metalProp', acUnitGeo({ x: o.x, y: o.y, z: o.z, rotY: o.side > 0 ? 0 : Math.PI }));
  b.proxy(0.85, 0.68, 0.58, o.x, o.y, o.z);
}

/** 外挂管道（metal）：沿 z 走的一条。纯装饰，不进碰撞 */
function propPipeRun(
  b: Builder,
  o: { x: number; y: number; z0: number; z1: number; radius?: number },
): void {
  b.geo(
    'metalStruct',
    pipeRunGeo({
      x: o.x,
      y: o.y,
      z: (o.z0 + o.z1) * 0.5,
      len: Math.abs(o.z1 - o.z0),
      radius: o.radius ?? 0.05,
      axis: 'z',
      elbows: true,
    }),
  );
}

/** 雨棚 / 彩钢瓦顶（metal）。主板保留碰撞，免得跳到箱子上撞头穿模。 */
function propAwning(
  b: Builder,
  o: Placed & { width: number; depth: number; side: 1 | -1 },
): void {
  b.geo('metalStruct', awningGeo({ x: o.x, y: o.y, z: o.z, w: o.depth, d: o.width, facing: o.side }));
  b.proxy(o.width, 0.14, o.depth, o.x, o.y, o.z);
}

/** 招牌（metal）。纯装饰 */
function propSignBoard(
  b: Builder,
  o: Placed & { width: number; height: number; side: 1 | -1 },
): void {
  b.geo(
    'metalStruct',
    signBoardGeo({ x: o.x, y: o.y, z: o.z, w: o.width, h: o.height, rotY: o.side > 0 ? 0 : Math.PI }),
  );
}

/** 门框（metal 包边），贴在墙洞四周。纯装饰 */
function propDoorFrame(
  b: Builder,
  o: { z: number; width: number; height: number; side: 1 | -1 },
): void {
  b.geo(
    'metalStruct',
    doorFrameGeo({
      x: (HALF_W - 0.07) * o.side,
      y: 0,
      z: o.z,
      w: o.width,
      h: o.height,
      rotY: o.side > 0 ? -Math.PI / 2 : Math.PI / 2,
    }),
  );
}

/** 瓦砾堆（brick 0.25）：矮、宽、不规则，是「打不穿但能翻」的半掩体 */
function propRubblePile(
  b: Builder,
  o: Placed & { radius: number; height: number; seed: number },
): void {
  b.geo('brick', rubblePileGeo({ x: o.x, y: o.y, z: o.z, radius: o.radius, count: 14, seed: o.seed }));
  // 碰撞用两个交叉方盒近似成八角形，比十几块乱转的碎石干净得多
  b.proxy(o.radius * 1.7, o.height * 0.8, o.radius * 1.35, o.x, o.height * 0.4, o.z);
  b.proxy(o.radius * 1.35, o.height * 0.8, o.radius * 1.7, o.x, o.height * 0.4, o.z);
}

/** 晾衣绳：缆绳 + 布片（props 自带，衣物另有 InstancedMesh 加密） */
function propClothesLine(
  b: Builder,
  o: { x0: number; x1: number; y: number; z: number; sag: number },
): void {
  b.geo(
    'metalStruct',
    clothesLineGeo({
      x1: o.x0,
      y1: o.y,
      z1: o.z,
      x2: o.x1,
      y2: o.y,
      z2: o.z,
      sheets: 0, // 布片交给 InstancedMesh（要按绳做彩色实例），这里只要绳
      seed: Math.round(Math.abs(o.z) * 977 + Math.abs(o.y) * 31),
    }),
  );
}

/** 靠墙的检修爬梯（纯装饰 —— 胶囊爬不了垂直梯，上楼请走楼梯 / 逃生梯） */
function propLadder(b: Builder, o: { x: number; z: number; y0: number; y1: number }): void {
  b.geo('metalStruct', ladderGeo({ x: o.x, y: o.y0, z: o.z, height: o.y1 - o.y0 }));
}

/**
 * 栏杆（metal 0.55）—— **半掩体**：站着上半身露出来，蹲下全遮，但子弹随便过。
 * 不进碰撞体（细立柱会卡胶囊，也会挡住「从二层跳下去」这条战术选项），
 * 防误落靠楼板边缘的 KERB_H 挡水台。
 *
 * axis='z' 表示沿 z 走、架在 x=c 上；axis='x' 反之。
 * railingGeo 沿局部 ±X 伸展，所以 axis='z' 时绕 Y 转 90°。
 */
function propRailing(
  b: Builder,
  axis: 'x' | 'z',
  c: number,
  a0: number,
  a1: number,
  baseY: number,
): void {
  const total = Math.abs(a1 - a0);
  if (total < 0.3) return;
  const segs = Math.ceil(total / RAIL_SEG_MAX);
  const lo = Math.min(a0, a1);
  for (let i = 0; i < segs; i++) {
    const len = total / segs;
    const mid = lo + len * (i + 0.5);
    b.geo(
      'metalStruct',
      railingGeo({
        x: axis === 'z' ? c : mid,
        y: baseY,
        z: axis === 'z' ? mid : c,
        length: len,
        height: RAIL_H,
        rotY: axis === 'z' ? Math.PI / 2 : 0,
      }),
    );
  }
}

/**
 * 一段沿 Z 走向的楼梯：**渲染是 props 的真台阶，碰撞是一块隐形斜坡**。
 * 胶囊在 0.3m 台阶上会一格一格顿挫，斜坡则是丝滑的；玩家看到的仍然是台阶。
 * stairGeo 从 (x,y,z) 沿局部 +Z 往上爬，所以往 -Z 爬的梯段绕 Y 转 180°。
 */
function propStair(
  b: Builder,
  key: MatKey,
  cx: number,
  width: number,
  z0: number,
  y0: number,
  z1: number,
  y1: number,
  steps: number,
): void {
  const down = z1 < z0;
  b.geo(
    key,
    stairGeo({
      x: cx,
      y: y0,
      z: z0,
      steps,
      rise: (y1 - y0) / steps,
      run: Math.abs(z1 - z0) / steps,
      width,
      rotY: down ? Math.PI : 0,
    }),
  );
  // 碰撞：一块斜坡，顶面正好贴着台阶顶
  b.rampProxy(cx, width, z0, y0, z1, y1);
}

/**
 * 室外逃生梯的**装饰段**（props 的 fireEscapeGeo）。
 * 注意 props 的下放梯刻意离地一段（爬不上去），所以它只负责剪影和「这栋楼有逃生梯」
 * 的信息；真正能走的两段在 buildFireEscape()，那是自建的斜坡 + 台阶。
 * 只挂在**没有二层走道**的墙段上，免得和楼板打架。
 */
function propFireEscapeDecor(b: Builder, x: number, y: number, z: number, floors: number, facing: 1 | -1): void {
  b.geo('metalStruct', fireEscapeGeo({ x, y, z, floors, facing }));
  // 大件，给一个整体代理盒（1.55m 外伸是 props 里的 FE_DEPTH）
  b.proxy(1.55, floors * 3.0, 2.6, x + 0.775 * facing, y + floors * 1.5, z);
}

// ---------------------------------------------------------------------------
// 贴图 / 材质
// ---------------------------------------------------------------------------

/**
 * textures.ts 的贴图是模块级缓存的共享实例，直接改它的 wrap/repeat 会污染别的模块。
 * 这里 clone 一份（clone 共享底层 source，GPU 上不会多传一张图）再改包裹模式。
 */
function wrapped(tex: THREE.Texture): THREE.Texture {
  const t = tex.clone();
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace; // 防止 textures.ts 漏设导致整体偏亮
  t.anisotropy = 8; // 会被 renderer 的上限自动 clamp
  t.needsUpdate = true;
  return t;
}

/**
 * 注意金属件的 roughness 没有跟着 0.8~0.95 走，而是 0.42~0.6：
 * 场景没有 envMap，metalness 一高、roughness 一高，金属会直接糊成一块死黑，
 * 铁皮垃圾箱和二层栏杆这种关键读数物件必须读得出来。
 */
function makeMaterials(): Record<MatKey, THREE.Material> {
  const concreteWallTex = wrapped(concreteTexture(0x9a9a95));
  const concreteFloorTex = wrapped(concreteTexture(0x7b7b76));
  const concreteCoverTex = wrapped(concreteTexture(0x8e8c86));
  const brickTex = wrapped(concreteTexture(0x9c6a50)); // 契约里没有 brickTexture，用带砖色的 concrete 贴图
  const metalTex = wrapped(metalTexture());
  const woodTex = wrapped(woodTexture());

  return {
    concreteFloor: new THREE.MeshStandardMaterial({
      map: concreteFloorTex,
      color: 0x66666a,
      roughness: 0.95,
      metalness: 0.03,
    }),
    concreteWall: new THREE.MeshStandardMaterial({
      map: concreteWallTex,
      color: 0x87888c,
      roughness: 0.92,
      metalness: 0.02,
    }),
    concreteCover: new THREE.MeshStandardMaterial({
      map: concreteCoverTex,
      color: 0x7d7c78,
      roughness: 0.88,
      metalness: 0.02,
    }),
    brick: new THREE.MeshStandardMaterial({
      map: brickTex,
      color: 0x8a5a44,
      roughness: 0.93,
      metalness: 0.02,
    }),
    metalStruct: new THREE.MeshStandardMaterial({
      map: metalTex,
      color: 0x6b737d,
      roughness: 0.5,
      metalness: 0.62,
    }),
    metalProp: new THREE.MeshStandardMaterial({
      map: metalTex,
      color: 0x54626a,
      roughness: 0.44,
      metalness: 0.7,
    }),
    wood: new THREE.MeshStandardMaterial({
      map: woodTex,
      color: 0x9a7b53,
      roughness: 0.9,
      metalness: 0.0,
    }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x9db9c4,
      roughness: 0.06,
      metalness: 0.0,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    puddle: new THREE.MeshStandardMaterial({
      color: 0x0d1015,
      roughness: 0.11,
      metalness: 0.4,
      polygonOffset: true, // 和地面只差 6mm，压掉 z-fighting
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  };
}

/**
 * 自发光装饰面（灯罩、窗内暖光、火焰、应急灯、招牌）。
 * toneMapped:false 让颜色绕过 ACES 直接进 Bloom；boost 把亮度推过
 * feelConfig.post.bloomThreshold(0.85)，否则暖橙色的亮度只有 0.7 左右，
 * 「暗巷里唯一的亮处」就发不起来。
 */
function emissiveMat(color: number, opacity = 1, boost = 1): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color,
    toneMapped: false,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    side: THREE.DoubleSide,
  });
  if (boost !== 1) m.color.multiplyScalar(boost);
  return m;
}

/**
 * 自发光面也要合并 —— 六个窗户各挂一个 Mesh 就是六次 draw call。
 * 按「会不会闪烁」分桶：静态的全部并成一个网格，会闪的（路灯 / 火）单独留。
 */
type GlowKey = 'window' | 'lamp' | 'fireCore' | 'fireOuter' | 'deckLamp' | 'cold';

function makeGlowMaterials(): Record<GlowKey, THREE.MeshBasicMaterial> {
  return {
    window: emissiveMat(0xffc48a, 1, 1.7),
    lamp: emissiveMat(0xffd8a6, 1, 2.0),
    fireCore: emissiveMat(0xffbe4a, 0.95, 2.2),
    fireOuter: emissiveMat(0xff6a1e, 0.5, 2.4),
    deckLamp: emissiveMat(0xffbe86, 1, 1.9),
    cold: emissiveMat(0x9fe6ff, 1, 1.55),
  };
}

class GlowBuilder {
  private buckets = new Map<GlowKey, THREE.BufferGeometry[]>();

  add(key: GlowKey, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    geo.applyMatrix4(m);
    let arr = this.buckets.get(key);
    if (arr === undefined) {
      arr = [];
      this.buckets.set(key, arr);
    }
    arr.push(geo);
  }

  flush(decor: THREE.Group, mats: Record<GlowKey, THREE.MeshBasicMaterial>): void {
    for (const [key, geos] of this.buckets) {
      if (geos.length === 0) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, mats[key]);
      mesh.name = `alley-glow-${key}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      decor.add(mesh);
    }
  }
}

// ---------------------------------------------------------------------------
// 地面
// ---------------------------------------------------------------------------

/** 四块地板拼成一个 L + T 形。彼此**相邻但不重叠** —— 共面重叠会 z-fighting。 */
function buildGround(b: Builder): void {
  const MX = HALF_W + WALL_T; // 主巷地板半宽 4.75（把两侧墙脚一起铺进去）
  const SX = SA_CX - WALL_T * 0.5; // 侧巷外缘 -8.5
  const TX = ST_CX + WALL_T * 0.5; // 楼梯间外缘  8.5

  // 主巷：z ∈ [-24.0, 21.9]
  b.slab('concreteFloor', MX * 2, Z_NEAR + 0.6 - Z_MOUTH, 0, 0, (Z_NEAR + 0.6 + Z_MOUTH) * 0.5, 0.6);
  // 小广场：z ∈ [-34.6, -24.0]
  b.slab('concreteFloor', PZ_HALF * 2 + WALL_T * 2, Z_MOUTH - (PZ_FAR - 0.6), 0, 0, (Z_MOUTH + PZ_FAR - 0.6) * 0.5, 0.6);
  // 侧巷环线：x ∈ [-8.5, -4.75]，三段共用一块，多出来的部分被墙压着看不见
  b.slab('concreteFloor', -MX - SX, SA_A_Z1 + 0.5 - (SA_C_Z - 0.5), (SX - MX) * 0.5, 0, (SA_A_Z1 + 0.5 + SA_C_Z - 0.5) * 0.5, 0.6);
  // 楼梯间竖井：x ∈ [4.75, 8.5]
  b.slab('concreteFloor', TX - MX, ST_Z1 + 0.5 - (ST_Z0 - 0.5), (MX + TX) * 0.5, 0, (ST_Z1 + 0.5 + ST_Z0 - 0.5) * 0.5, 0.6);
}

// ---------------------------------------------------------------------------
// 主巷两侧高墙
// ---------------------------------------------------------------------------

/** 一侧墙上的凹进门洞（1.8~2.2m 深）：后墙 + 两侧墙 + 顶 + 地。制造 90° 锐角。 */
function buildAlcove(b: Builder, side: 1 | -1, zc: number, depth: number): void {
  const s = side;
  const xIn = HALF_W * s; // 巷内一侧的开口面
  const xBack = (HALF_W + depth) * s; // 凹进底面
  const cx = (xIn + xBack) * 0.5;

  b.box('concreteWall', 0.4, 3.4, DOOR_W + 0.8, xBack + 0.2 * s, 1.7, zc); // 后墙
  // 两侧墙（这两面就是「切派」时要一点点吃掉的角）
  b.box('concreteWall', depth, 3.4, 0.4, cx, 1.7, zc - (DOOR_W * 0.5 + 0.2));
  b.box('concreteWall', depth, 3.4, 0.4, cx, 1.7, zc + (DOOR_W * 0.5 + 0.2));
  b.box('concreteWall', depth + 0.4, 0.3, DOOR_W + 0.8, cx + 0.2 * s, DOOR_H + 0.15, zc); // 顶
  // 地（比巷面高 6cm，一道小台阶，人形轮廓会被抬起来一点更好打）
  b.box('concreteFloor', depth + 0.4, 0.5, DOOR_W + 0.8, cx + 0.2 * s, -0.19, zc);
}

function buildMainWalls(b: Builder): void {
  const H = WALL_H;

  // ---- 右墙 (x = +4.25) ----------------------------------------------------
  // 洞：O1 = DOOR_R1 凹进(地面)，O2 = 楼梯间地面门(卷帘)，O3 = 楼梯间二层门
  const O1_A = DOOR_R1 - DOOR_W * 0.5; // -9.0
  const O1_B = DOOR_R1 + DOOR_W * 0.5; // -6.6
  const O2_A = DOOR_R2 - 1.0; // 5.6
  const O2_B = DOOR_R2 + 1.0; // 7.6

  for (const [z0, z1] of [
    [Z_MOUTH, O1_A],
    [O1_B, O2_A],
    [O2_B, Z_NEAR],
  ] as [number, number][]) {
    b.box('concreteWall', WALL_T, H, z1 - z0, WALL_CX, H * 0.5, (z0 + z1) * 0.5);
  }
  b.box('concreteWall', WALL_T, H - DOOR_H, DOOR_W, WALL_CX, (H + DOOR_H) * 0.5, DOOR_R1); // O1 过梁
  // O2 / O3 之间那条腰带（y 2.5~3.3；3.3~3.6 让给下面那块金属门槛板，避免共面 z-fighting）
  b.box(
    'concreteWall',
    WALL_T,
    Y2 - DECK_T - DOOR_H,
    O2_B - O2_A,
    WALL_CX,
    (Y2 - DECK_T + DOOR_H) * 0.5,
    DOOR_R2,
  );
  // O3 上方
  b.box('concreteWall', WALL_T, H - 5.7, O2_B - O2_A, WALL_CX, (H + 5.7) * 0.5, DOOR_R2);
  // 二层门洞的门槛板（把楼板接到楼梯间顶层平台上）
  b.slab('metalStruct', WALL_T, O2_B - O2_A, WALL_CX, Y2, DOOR_R2, DECK_T);

  // ---- 左墙 (x = -4.25) ----------------------------------------------------
  // 洞：P1 = 侧巷折回段汇入口，P2 = 侧巷入口，P3 = DOOR_L1 凹进
  const P3_A = DOOR_L1 - DOOR_W * 0.5;
  const P3_B = DOOR_L1 + DOOR_W * 0.5;
  for (const [z0, z1] of [
    [Z_MOUTH, SA_C_Z],
    [SA_B_Z, SA_A_Z0],
    [SA_A_Z1, P3_A],
    [P3_B, Z_NEAR],
  ] as [number, number][]) {
    b.box('concreteWall', WALL_T, H, z1 - z0, -WALL_CX, H * 0.5, (z0 + z1) * 0.5);
  }
  b.box('concreteWall', WALL_T, H - 3.0, SA_B_Z - SA_C_Z, -WALL_CX, (H + 3.0) * 0.5, (SA_C_Z + SA_B_Z) * 0.5); // P1 过梁
  b.box('concreteWall', WALL_T, H - 3.0, SA_A_Z1 - SA_A_Z0, -WALL_CX, (H + 3.0) * 0.5, (SA_A_Z0 + SA_A_Z1) * 0.5); // P2 过梁
  b.box('concreteWall', WALL_T, H - DOOR_H, DOOR_W, -WALL_CX, (H + DOOR_H) * 0.5, DOOR_L1); // P3 过梁

  // ---- 凹进 ----
  buildAlcove(b, 1, DOOR_R1, 2.2); // 深凹进：敌人点，必须切派才能清
  buildAlcove(b, -1, DOOR_L1, 1.8);

  // ---- 近端封口（玩家背后）----
  b.box('concreteWall', HALF_W * 2 + WALL_T * 2, H, 0.6, 0, H * 0.5, Z_NEAR + 0.3);

  // ---- 半降的铁皮卷帘门 —— 楼梯间的门 -------------------------------------
  // 典型陷阱：看着是一整面「墙」，其实穿透 0.55。下沿留 1.35m，
  // **必须蹲着（1.2m）才钻得进去** —— 争夺二楼视野的那两秒是全场最脆弱的时刻。
  b.box(
    'metalStruct',
    0.06,
    DOOR_H - SHUTTER_GAP,
    O2_B - O2_A - 0.08,
    HALF_W + 0.08,
    (DOOR_H + SHUTTER_GAP) * 0.5,
    DOOR_R2,
  );
  b.detail(() => {
    b.box('metalStruct', 0.11, 0.13, O2_B - O2_A, HALF_W + 0.08, SHUTTER_GAP, DOOR_R2); // 下沿加强梁
    b.box('metalStruct', 0.18, 0.22, O2_B - O2_A + 0.2, HALF_W + 0.08, DOOR_H + 0.12, DOOR_R2); // 卷帘箱
  });
  propDoorFrame(b, { z: DOOR_R2, width: O2_B - O2_A, height: DOOR_H, side: 1 });
  propDoorFrame(b, { z: DOOR_R1, width: DOOR_W, height: DOOR_H, side: 1 });
  propDoorFrame(b, { z: DOOR_L1, width: DOOR_W, height: DOOR_H, side: -1 });
}

// ---------------------------------------------------------------------------
// 侧巷环线（A 段东西向 → B 段南北向 → 木板围挡 → C 段折回主巷）
// ---------------------------------------------------------------------------

function buildSideAlley(b: Builder): void {
  const H = SIDE_H;

  // 外圈围墙。端墙从西缘 -8.5 一路砌到主巷左墙外皮 -4.0，中间不留缝。
  const SX = SA_CX - WALL_T * 0.5; // -8.5
  const endW = -HALF_W - SX; // 4.5
  const endCX = (SX - HALF_W) * 0.5; // -6.25
  b.box('concreteWall', WALL_T, H, SA_A_Z1 + 0.5 - (SA_C_Z - 0.5), SA_CX, H * 0.5, (SA_A_Z1 + 0.5 + SA_C_Z - 0.5) * 0.5); // 西
  b.box('concreteWall', endW, H, WALL_T, endCX, H * 0.5, SA_A_Z1 + WALL_T * 0.5); // A 段北
  b.box('concreteWall', endW, H, WALL_T, endCX, H * 0.5, SA_C_Z - WALL_T * 0.5); // C 段南

  // B 段与主巷之间的 1m 厚隔墙（主巷左墙 0.5 + 这一片 0.5）。
  // 落地窗 (z=-11.5) 就嵌在这堵厚墙里 —— 是一块发光的窗龛，不是真房间。
  b.box('concreteWall', WALL_T, H, SA_A_Z0 - SA_B_Z, SA_B_X + WALL_T * 0.5, H * 0.5, (SA_A_Z0 + SA_B_Z) * 0.5);

  // ---- 木板围挡（wood 0.75）：B 段死路的尽头 -------------------------------
  // 「需要开枪开路的侧翼」：子弹随便穿；人只能从 GATE_GAP 那道 1.5m 破口蹲着钻。
  // 逐块建板只为好看，碰撞用两块代理盒（把破口让出来）。
  {
    const rnd = mulberry32(0xa11e7);
    const x0 = SA_X;
    const x1 = SA_B_X;
    const pitch = 0.375;
    const count = Math.round((x1 - x0) / pitch);
    const TOP = 3.0; // 围挡总高：站姿视高 1.64m 完全看不过去
    b.detail(() => {
      for (let i = 0; i < count; i++) {
        const x = x0 + pitch * (i + 0.5);
        const broken = x >= GATE_GAP_X0 && x <= GATE_GAP_X1;
        const y0 = broken ? GATE_GAP_H : 0;
        const h = TOP - y0 + rnd() * 0.22;
        const tilt = (rnd() - 0.5) * 0.03;
        b.box('wood', 0.32, h, 0.05, x, y0 + h * 0.5, SA_B_Z, tilt * 0.5, tilt);
      }
      b.box('wood', x1 - x0, 0.13, 0.09, (x0 + x1) * 0.5, 2.78, SA_B_Z + 0.09); // 上横档
      b.box('wood', x1 - x0, 0.13, 0.09, (x0 + x1) * 0.5, 1.72, SA_B_Z + 0.09); // 下横档
      // 破口上沿那块钉歪的横板 —— 提示这里能钻
      b.box('wood', 1.24, 0.14, 0.05, -6.45, GATE_GAP_H + 0.09, SA_B_Z - 0.07, 0.05, 0.06);
    });
    // 碰撞：两侧实心，中间那块 1.0m × 1.5m 的破口留空 —— 只有蹲下（1.2m）才过得去
    b.proxy(GATE_GAP_X0 - x0, TOP, 0.2, (x0 + GATE_GAP_X0) * 0.5, TOP * 0.5, SA_B_Z);
    b.proxy(x1 - GATE_GAP_X1, TOP, 0.2, (GATE_GAP_X1 + x1) * 0.5, TOP * 0.5, SA_B_Z);
    b.proxy(
      GATE_GAP_X1 - GATE_GAP_X0,
      TOP - GATE_GAP_H,
      0.2,
      (GATE_GAP_X0 + GATE_GAP_X1) * 0.5,
      (TOP + GATE_GAP_H) * 0.5,
      SA_B_Z,
    );
  }

  // ---- 侧巷里的低掩体（两组，宜少不宜多）----------------------------------
  propCrate(b, { x: -6.9, y: 0, z: -4.2, size: 1.05, height: 0.95, rotY: 0.2 });
  propCrate(b, { x: -5.9, y: 0, z: -3.6, size: 0.8, height: 0.62, rotY: -0.35 });
  // 两只桶沿 z 错开 1.6m 摆（不是并排）：任何一个横截面都留得下 1.7m 净宽，
  // 但沿走廊看过去仍然是「一段需要绕」的掩体节奏 —— 交错优于并排。
  propBarrel(b, { x: -5.7, y: 0, z: -12.6 });
  propBarrel(b, { x: -7.45, y: 0, z: -14.2, height: 0.86 });
  propRubblePile(b, { x: -6.2, y: 0, z: -17.0, radius: 1.25, height: 0.75, seed: 0x5a1de });

  // ---- 细节 ----------------------------------------------------------------
  propAcUnit(b, { x: -7.62, y: 2.5, z: -8.4, side: -1 });
  propPipeRun(b, { x: -7.86, y: 4.2, z0: -14.6, z1: -6.0, radius: 0.055 });
  propLadder(b, { x: -7.82, z: -10.6, y0: 0.4, y1: 5.6 });
  b.detail(() => b.cyl('metalStruct', 0.065, 0.065, 5.4, 10, -5.14, 2.7, -8.0));
  propClothesLine(b, { x0: SA_X + 0.1, x1: SA_B_X - 0.1, y: 4.0, z: -9.5, sag: 0.3 });
  b.puddle(-6.5, -11.4, 1.15, 0.95, 0.4);
}

// ---------------------------------------------------------------------------
// 小广场
// ---------------------------------------------------------------------------

function buildPlaza(b: Builder): void {
  const H = PZ_H;

  // 两侧墙
  for (const s of [-1, 1] as const) {
    b.box('concreteWall', WALL_T, H, Z_MOUTH - (PZ_FAR - 0.5), PZ_CX * s, H * 0.5, (Z_MOUTH + PZ_FAR - 0.5) * 0.5);
    // 巷口两侧的「肩膀」：主巷 8m 宽 → 广场 16m 宽的过渡面，是标准的切派角
    b.box('concreteWall', PZ_CX + 0.25 - HALF_W, H, WALL_T, ((PZ_CX + 0.25 + HALF_W) * 0.5) * s, H * 0.5, Z_MOUTH - WALL_T * 0.5);
  }
  // 远端砖墙 —— 全场最大的一面 brick，穿透 0.25，教玩家「砖能穿但很亏」
  b.box('brick', PZ_HALF * 2 + WALL_T * 2, H, WALL_T, 0, H * 0.5, PZ_FAR - WALL_T * 0.5);
  b.box('brick', 0.55, H, 0.35, -5.2, H * 0.5, PZ_FAR + 0.17);
  b.box('brick', 0.55, H, 0.35, 5.2, H * 0.5, PZ_FAR + 0.17);

  // ---- 装卸台（concrete，真掩体 + 一点微垂直度）-----------------------------
  // 0.95m 高，跳一下就能上去；上去之后视野好但没有掩体 —— 典型的「风险换视野」。
  b.slab('concreteCover', 3.4, 5.2, PZ_HALF - 1.7, 0.95, -29.4, 0.95);
  b.detail(() => {
    b.box('concreteCover', 3.5, 0.12, 5.3, PZ_HALF - 1.7, 0.94, -29.4);
    for (let i = 0; i < 3; i++) {
      b.box('metalStruct', 0.9, 0.07, 0.14, PZ_HALF - 1.7, 0.99, -31.4 + i * 2.0);
    }
  });
  propRailing(b, 'z', PZ_HALF - 3.42, -31.9, -26.9, 0.95);

  // ---- 交错的低掩体（四组，全部可 360° 绕）---------------------------------
  propDumpster(b, { x: -5.3, y: 0, z: -26.9, width: 2.0, height: 1.12, rotY: 0.22 }); // 陷阱：metal
  b.box('concreteCover', 2.6, 1.0, 0.45, -1.6, 0.5, -30.6, -0.1); // 真掩体
  b.box('concreteCover', 0.9, 0.6, 0.45, -0.15, 0.3, -30.35, -0.1);
  propPalletStack(b, { x: 2.6, y: 0, z: -26.4, count: 5, rotY: -0.25 }); // 陷阱：wood
  propBarrel(b, { x: 3.6, y: 0, z: -27.2 });
  propRubblePile(b, { x: 5.9, y: 0, z: -32.2, radius: 1.7, height: 0.95, seed: 0x9c0de });

  // ---- 氛围 ----------------------------------------------------------------
  propAwning(b, { x: -PZ_HALF + 1.05, y: 3.1, z: -27.6, width: 2.1, depth: 3.2, side: -1 });
  propAcUnit(b, { x: -PZ_HALF + 0.42, y: 3.0, z: -31.6, side: -1 });
  propAcUnit(b, { x: PZ_HALF - 0.42, y: 4.4, z: -25.4, side: 1 });
  propPipeRun(b, { x: -PZ_HALF + 0.16, y: 5.1, z0: -33.4, z1: -25.2, radius: 0.06 });
  b.detail(() => {
    b.cyl('metalStruct', 0.075, 0.075, 6.4, 10, PZ_HALF - 0.16, 3.2, -32.4);
    b.cyl('metalStruct', 0.06, 0.06, 6.4, 10, -PZ_HALF + 0.16, 3.2, -26.2);
  });
  propBarrel(b, { x: -7.0, y: 0, z: -33.0, height: 0.88 });
  // 两段**装饰用**逃生梯（props.fireEscapeGeo）：广场两侧墙，纯剪影。
  // props 的下放梯刻意离地，爬不上去 —— 真正能走的两段在主巷右墙（buildFireEscape）。
  propFireEscapeDecor(b, -PZ_HALF, 3.0, -30.0, 2, 1);
  propFireEscapeDecor(b, PZ_HALF, 3.0, -26.4, 2, -1);
  b.puddle(-3.2, -27.4, 2.1, 1.5, 0.35);
  b.puddle(4.4, -31.0, 1.6, 1.15, -0.6);
}

// ---------------------------------------------------------------------------
// 楼梯间 —— 半降卷帘门后面的竖井，二楼视野的唯一室内通道
// ---------------------------------------------------------------------------

function buildStairwell(b: Builder): void {
  const H = 7.0;

  // 竖井三面墙（第四面是主巷右墙，门洞已经在 buildMainWalls 里挖好）
  b.box('concreteWall', WALL_T, H, ST_Z1 + 0.5 - (ST_Z0 - 0.5), ST_CX, H * 0.5, (ST_Z1 + 0.5 + ST_Z0 - 0.5) * 0.5);
  b.box('concreteWall', ST_X1 + 0.5 - HALF_W, H, WALL_T, (HALF_W + ST_X1 + 0.5) * 0.5, H * 0.5, ST_Z0 - 0.25);
  b.box('concreteWall', ST_X1 + 0.5 - HALF_W, H, WALL_T, (HALF_W + ST_X1 + 0.5) * 0.5, H * 0.5, ST_Z1 + 0.25);
  // 半边屋顶：南半边封住（这才叫「室内」），北半边留天井放光进来，
  // 否则整个梯间是纯黑的，而我只剩 2 盏 PointLight 的额度，得省着用。
  b.box('concreteWall', ST_X1 + 0.5 - HALF_W, 0.35, 4.7, (HALF_W + ST_X1 + 0.5) * 0.5, 6.68, 6.35);

  // 两跑折返。两跑都在 z=1.6 处交到中间平台的同一条边上，所以那条边不需要栏杆，
  // 走上去是连续的；只有顶层平台朝南那半边才是真正的坠落边。
  const LANE_W = 1.65;
  const W_CX = (ST_X0 + 6.2) * 0.5; // 西跑车道中心 5.35
  const E_CX = (6.3 + ST_X1) * 0.5; // 东跑车道中心 7.15

  // 第一跑：z 5.0 → 1.6，y 0 → 2.0（30.5°，单级升 0.18m）
  propStair(b, 'concreteCover', W_CX, LANE_W, 5.0, 0, 1.6, ST_MID_Y, 11);
  // 中间平台（底面 1.84m，站姿 1.8m 刚好过得去）。两跑都在 z=1.6 交到它身上，
  // 所以往南多压 LAND_OVER 把两条接缝一起盖掉。
  b.slab('concreteCover', ST_X1 - ST_X0, 1.0 + LAND_OVER * 2, (ST_X0 + ST_X1) * 0.5, ST_MID_Y, 1.1, 0.16);
  // 第二跑：z 1.6 → 5.6，y 2.0 → 3.6（21.8°）
  propStair(b, 'concreteCover', E_CX, LANE_W, 1.6, ST_MID_Y, 5.6, Y2, 11);
  // 顶层平台：z ∈ [5.6, 8.2]，和右墙二层门洞的门槛板接上
  b.slab('concreteCover', ST_X1 - ST_X0, ST_Z1 - 5.6 + LAND_OVER * 2, (ST_X0 + ST_X1) * 0.5, Y2, (5.6 + ST_Z1) * 0.5 - LAND_OVER, 0.2);

  // 顶层平台朝南那半边下面是 3.6m 的空井 —— 唯一需要栏杆的地方
  propRailing(b, 'x', 5.66, ST_X0 + 0.1, 6.3, Y2);

  // 细节
  propLadder(b, { x: ST_X1 - 0.2, z: 2.4, y0: Y2 + 0.3, y1: 6.4 });
  propPipeRun(b, { x: ST_X1 - 0.22, y: 5.6, z0: 1.0, z1: 7.8, radius: 0.05 });
  b.detail(() => {
    b.box('metalStruct', 0.7, 0.9, 0.06, ST_X1 - 0.28, 2.1, 3.6); // 配电箱
    b.box('metalStruct', 0.16, 0.16, 0.16, ST_X1 - 0.28, 2.72, 3.6);
  });
}

// ---------------------------------------------------------------------------
// 二层：三段走道 + 两段连桥 + 两段逃生梯
// ---------------------------------------------------------------------------

interface Deck {
  name: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const DECKS: Deck[] = [
  { name: 'A', x0: DECK_X_IN, x1: HALF_W, z0: A_Z0, z1: A_Z1 },
  { name: 'B', x0: -HALF_W, x1: -DECK_X_IN, z0: B_Z0, z1: B_Z1 },
  { name: 'C', x0: DECK_X_IN, x1: HALF_W, z0: C_Z0, z1: C_Z1 },
  { name: 'CW1', x0: -DECK_X_IN, x1: DECK_X_IN, z0: CW1_Z0, z1: CW1_Z1 },
];

function buildUpperLevel(b: Builder): void {
  // ---- 楼板 ---------------------------------------------------------------
  for (const d of DECKS) {
    b.slab(
      'metalStruct',
      d.x1 - d.x0,
      d.z1 - d.z0,
      (d.x0 + d.x1) * 0.5,
      Y2,
      (d.z0 + d.z1) * 0.5,
      DECK_T,
    );
  }

  // ---- 连桥 2：两根大管道 + 铺在上面的跳板（最窄、最没安全感的一段）--------
  {
    const cz = (CW2_Z0 + CW2_Z1) * 0.5;
    b.detail(() => {
      for (const dz of [-0.36, 0.36]) {
        b.rod(
          'metalStruct',
          new THREE.Vector3(-DECK_X_IN - 0.1, Y2 - 0.28, cz + dz),
          new THREE.Vector3(DECK_X_IN + 0.1, Y2 - 0.28, cz + dz),
          0.16,
          10,
        );
      }
      for (let i = 0; i < 11; i++) {
        const x = -DECK_X_IN + 0.06 + i * ((DECK_X_IN * 2 - 0.12) / 10);
        b.box('wood', 0.28, 0.06, 1.0, x, Y2 - 0.03, cz, 0, (i % 3) * 0.004);
      }
      // 一条勉强能扶的钢索
      b.rod(
        'metalStruct',
        new THREE.Vector3(-DECK_X_IN, Y2 + 0.95, cz - 0.55),
        new THREE.Vector3(DECK_X_IN, Y2 + 0.95, cz - 0.55),
        0.016,
        5,
      );
    });
    b.proxy(DECK_X_IN * 2 + 0.2, 0.22, CW2_Z1 - CW2_Z0, 0, Y2 - 0.11, cz);
  }

  // ---- 楼板边缘挡水台（0.25m）：防误滑落，但跳一下就能过去 -----------------
  // 缺口 = 逃生梯 / 连桥的接入口。
  const kerb = (axis: 'x' | 'z', c: number, a0: number, a1: number): void => {
    const len = Math.abs(a1 - a0);
    if (len < 0.25) return;
    const mid = (a0 + a1) * 0.5;
    const cy = Y2 + KERB_H * 0.5 - 0.075;
    if (axis === 'z') b.box('metalStruct', 0.14, KERB_H + 0.15, len, c, cy, mid);
    else b.box('metalStruct', len, KERB_H + 0.15, 0.14, mid, cy, c);
  };

  // 平台 A 内沿：让开连桥 1 (5.2~6.4) 和 FE1 顶平台 (7.6~8.4)
  kerb('z', DECK_X_IN, 6.4, 7.6);
  kerb('z', DECK_X_IN, 8.4, A_Z1);
  kerb('x', A_Z0, DECK_X_IN, HALF_W);
  kerb('x', A_Z1, DECK_X_IN, HALF_W);
  // 平台 B 内沿：让开连桥 2 (-3.0~-1.9) 和连桥 1 (5.2~6.4)
  kerb('z', -DECK_X_IN, CW2_Z1, CW1_Z0);
  kerb('x', B_Z0, -HALF_W, -DECK_X_IN);
  kerb('x', B_Z1, -HALF_W, -DECK_X_IN);
  // 平台 C 内沿：让开连桥 2 和 FE2 顶平台 (-12.2~-11.4)
  kerb('z', DECK_X_IN, C_Z0, -12.2);
  kerb('z', DECK_X_IN, -11.4, CW2_Z0);
  kerb('x', C_Z0, DECK_X_IN, HALF_W);
  kerb('x', C_Z1, DECK_X_IN, HALF_W);
  // 连桥 1 两侧（连桥 2 故意不做挡边 —— 那段就是要走得心里发毛）
  kerb('x', CW1_Z0, -DECK_X_IN, DECK_X_IN);
  kerb('x', CW1_Z1, -DECK_X_IN, DECK_X_IN);

  // ---- 栏杆（metal 半掩体，不进碰撞体）------------------------------------
  propRailing(b, 'z', DECK_X_IN - 0.02, 6.4, 7.6, Y2);
  propRailing(b, 'z', DECK_X_IN - 0.02, 8.4, A_Z1, Y2);
  propRailing(b, 'x', A_Z1 - 0.02, DECK_X_IN, HALF_W, Y2);
  propRailing(b, 'z', -DECK_X_IN + 0.02, CW2_Z1, CW1_Z0, Y2);
  propRailing(b, 'x', B_Z0 + 0.02, -HALF_W, -DECK_X_IN, Y2);
  propRailing(b, 'x', B_Z1 - 0.02, -HALF_W, -DECK_X_IN, Y2);
  propRailing(b, 'z', DECK_X_IN - 0.02, C_Z0, -12.2, Y2);
  propRailing(b, 'z', DECK_X_IN - 0.02, -11.4, CW2_Z0, Y2);
  propRailing(b, 'x', C_Z0 + 0.02, DECK_X_IN, HALF_W, Y2);
  propRailing(b, 'x', CW1_Z0 + 0.02, -DECK_X_IN, DECK_X_IN, Y2);
  propRailing(b, 'x', CW1_Z1 - 0.02, -DECK_X_IN, DECK_X_IN, Y2);

  // ---- 楼板托架（斜撑 + 牛腿），让二层读起来是「挂上去的」而不是浮着的 -----
  b.detail(() => {
    const brackets: [number, number][] = [
      [1, 6.4],
      [1, 9.8],
      [1, 12.8],
      [-1, -2.0],
      [-1, 1.4],
      [-1, 4.8],
      [1, -18.4],
      [1, -14.6],
      [1, -10.4],
      [1, -6.4],
      [1, -2.8],
    ];
    for (const [s, z] of brackets) {
      const wallX = HALF_W * s;
      b.rod(
        'metalStruct',
        new THREE.Vector3(wallX, Y2 - DECK_T - 1.15, z),
        new THREE.Vector3(wallX - DECK_D * 0.92 * s, Y2 - DECK_T + 0.02, z),
        0.05,
        6,
      );
      b.box('metalStruct', 0.24, 0.2, 0.2, wallX - 0.1 * s, Y2 - DECK_T - 1.15, z);
    }
    // 楼板外沿的主梁
    for (const d of DECKS) {
      if (d.name === 'CW1') continue;
      const outer = d.name === 'B' ? d.x1 : d.x0;
      b.box('metalStruct', 0.1, 0.26, d.z1 - d.z0, outer, Y2 - DECK_T - 0.1, (d.z0 + d.z1) * 0.5);
    }
  });

  // ---- 逃生梯 FE1：地面 z≈15.6 → 平台 A（两跑一平台，30~32°）--------------
  buildFireEscape(b, 15.6, 12.4, 11.2, 8.4, 7.6, 1);
  // ---- 逃生梯 FE2：地面 z≈-19.4 → 平台 C -----------------------------------
  buildFireEscape(b, -19.4, -16.2, -15.0, -12.2, -11.4, -1);
}

/**
 * 一段室外逃生梯：下跑 → 中平台 → 上跑 → 顶平台（接到二层楼板边缘）。
 * `dir` = +1 表示台阶随 z 减小而升高（近端那段），-1 反之。
 * 车道贴着走道外沿挂在巷子里（x ∈ [0.6, 1.7]），本身也是一组高低错落的掩体。
 */
function buildFireEscape(
  b: Builder,
  zGround: number,
  zLow1: number,
  zLow0: number,
  zTop: number,
  zTopEnd: number,
  _dir: 1 | -1,
): void {
  const cx = 1.15;
  const w = 1.1;
  const midY = 1.9;

  propStair(b, 'metalStruct', cx, w, zGround, 0.0, zLow1, midY, 10);
  b.slab('metalStruct', w, Math.abs(zLow1 - zLow0) + LAND_OVER * 2, cx, midY, (zLow1 + zLow0) * 0.5, 0.14);
  propStair(b, 'metalStruct', cx, w, zLow0, midY, zTop, Y2, 9);
  b.slab('metalStruct', w, Math.abs(zTop - zTopEnd) + LAND_OVER * 2, cx, Y2, (zTop + zTopEnd) * 0.5, 0.14);

  b.detail(() => {
    // 四根立柱（细，不进碰撞体，玩家可以贴着走）
    for (const z of [zLow1, zLow0]) {
      for (const dx of [-0.48, 0.48]) {
        b.box('metalStruct', 0.09, midY, 0.09, cx + dx, midY * 0.5, z + Math.sign(zLow0 - zLow1) * 0.06);
      }
    }
    for (const z of [zTop, zTopEnd]) {
      for (const dx of [-0.48, 0.48]) {
        b.box('metalStruct', 0.08, Y2, 0.08, cx + dx, Y2 * 0.5, z);
      }
    }
    // 拉回墙面的斜撑
    for (const z of [zLow0, zTopEnd]) {
      b.rod(
        'metalStruct',
        new THREE.Vector3(HALF_W, 2.4, z),
        new THREE.Vector3(cx + 0.5, 1.6, z),
        0.035,
        6,
      );
    }
  });

  const a = Math.min(zLow1, zLow0);
  const c = Math.max(zLow1, zLow0);
  propRailing(b, 'z', cx - 0.5, a, c, midY);
  propRailing(b, 'z', cx + 0.5, a, c, midY);
  const t0 = Math.min(zTop, zTopEnd);
  const t1 = Math.max(zTop, zTopEnd);
  propRailing(b, 'z', cx - 0.5, t0, t1, Y2);
}

// ---------------------------------------------------------------------------
// 地面层掩体骨架 —— 六组交错低掩体（原版验证过的布局，位置基本不动）
// ---------------------------------------------------------------------------

function buildCovers(b: Builder): void {
  // C1  z≈11.5 左侧 · 木箱堆（wood 0.75，几乎不挡子弹，但挡视线、能绕）
  propCrate(b, { x: -1.95, y: 0, z: 11.6, size: 1.15, height: 1.0, rotY: 0.12 });
  propCrate(b, { x: -0.9, y: 0, z: 11.2, size: 0.92, height: 0.78, rotY: -0.4 });
  propCrate(b, { x: -2.6, y: 0, z: 12.4, size: 0.85, height: 0.55, rotY: 0.25 });

  // C2  z≈+6.0 右侧 · 混凝土矮墙（真掩体，1.05m）+ 外露钢筋。正好在连桥 1 底下，
  //     抬头能看见桥上的人，桥上的人也能打你 —— 上下层的第一个交火点。
  {
    const ry = -0.14;
    b.box('concreteCover', 2.5, 1.05, 0.45, 1.15, 0.525, 6.0, ry);
    b.box('concreteCover', 0.75, 0.62, 0.45, -0.35, 0.31, 6.35, ry);
    b.detail(() => {
      for (let i = 0; i < 3; i++) {
        const [x, z] = offX(1.15, 6.0, ry, -0.7 + i * 0.7);
        b.rod(
          'metalStruct',
          new THREE.Vector3(x, 1.0, z),
          new THREE.Vector3(x + 0.09 * (i - 1), 1.42 + 0.1 * i, z + 0.06),
          0.018,
          6,
        );
      }
    });
  }

  // C3  z≈+1.2 左侧 · 大铁皮垃圾箱（**陷阱**：1.1m 高，看着完美，穿透 0.55）
  propDumpster(b, { x: -2.0, y: 0, z: 1.2, width: 2.0, height: 1.1, rotY: 0.09 });

  // C4  z≈-3.6 右侧 · 三合板隔断（**陷阱 2**：1.95m 全遮视线，穿透 0.75）
  {
    const ry = 0.11;
    b.box('wood', 2.9, 1.95, 0.05, 1.55, 0.98, -3.6, ry);
    b.detail(() => {
      b.box('wood', 2.9, 0.1, 0.09, 1.55, 1.92, -3.6, ry);
      b.box('wood', 2.9, 0.1, 0.09, 1.55, 0.28, -3.6, ry);
      for (const s of [-1, 1]) {
        const [x, z] = offX(1.55, -3.6, ry, 1.42 * s);
        b.box('wood', 0.1, 2.1, 0.1, x, 1.05, z, ry);
      }
      b.box('wood', 0.28, 1.7, 0.04, 0.3, 0.72, -3.05, 0.5, -0.55);
    });
  }

  // C5  z≈-9.0 左侧 · 断裂的混凝土残墙（真掩体，1.15m）
  {
    const ry = -0.07;
    b.box('concreteCover', 2.7, 1.15, 0.42, -1.75, 0.575, -9.0, ry);
    b.box('concreteCover', 0.95, 0.72, 0.42, -0.25, 0.36, -9.0, ry);
    b.box('concreteCover', 0.5, 0.34, 0.4, 0.45, 0.17, -8.7, 0.4);
    b.detail(() => {
      for (let i = 0; i < 4; i++) {
        const [x, z] = offX(-1.75, -9.0, ry, -0.9 + i * 0.6);
        b.rod(
          'metalStruct',
          new THREE.Vector3(x, 1.1, z),
          new THREE.Vector3(x + 0.05, 1.5 + 0.12 * (i % 2), z - 0.1 + 0.07 * i),
          0.016,
          6,
        );
      }
    });
  }

  // C6  z≈-14.2 右侧 · 木箱 + 铁桶（同一处掩体两种穿透，教玩家分辨）。
  //     正好在 FE2 上跑底下，蹲着能从楼梯下面钻过去。
  propCrate(b, { x: 2.35, y: 0, z: -14.2, size: 1.25, height: 1.05, rotY: 0.22 });
  propCrate(b, { x: 3.15, y: 0, z: -15.0, size: 0.8, height: 0.5, rotY: -0.3 });
  propBarrel(b, { x: 2.9, y: 0, z: -13.0 });

  // C7  z≈-21.5 右侧 · 砖砌矮台，贴着巷口，逆着广场的天光成剪影
  b.box('brick', 2.4, 1.1, 0.5, 1.9, 0.55, -21.5, 0.05);
  b.box('brick', 0.8, 0.55, 0.5, 0.45, 0.275, -21.3, 0.05);

  // C8  z≈-20.4 左侧 · 混凝土护栏（真掩体），和 C7 交错，中间留出清晰视线
  b.box('concreteCover', 2.3, 1.0, 0.42, -2.2, 0.5, -19.6, 0.08);
  propBarrel(b, { x: -3.3, y: 0, z: -21.4, height: 0.86 });
}

// ---------------------------------------------------------------------------
// 墙上的东西：雨棚、空调外机、管线、垃圾桶、招牌、晾衣绳
// ---------------------------------------------------------------------------

function buildProps(b: Builder): void {
  // ---- 雨棚（避开二层楼板：只在没有走道的 z 段挂）--------------------------
  propAwning(b, { x: 3.0, y: 3.05, z: 19.2, width: 2.0, depth: 3.0, side: 1 }); // 让开 z=15.8 那扇黑窗
  propAwning(b, { x: -3.0, y: 3.1, z: 8.6, width: 2.0, depth: 2.8, side: -1 });
  propAwning(b, { x: -3.0, y: 3.05, z: -13.0, width: 1.9, depth: 3.4, side: -1 });

  // ---- 招牌 ----------------------------------------------------------------
  propSignBoard(b, { x: 3.72, y: 5.35, z: 18.4, width: 2.6, height: 0.8, side: 1 });
  propSignBoard(b, { x: -3.72, y: 5.6, z: -6.6, width: 2.2, height: 0.7, side: -1 });

  // ---- 空调外机 ------------------------------------------------------------
  propAcUnit(b, { x: 3.58, y: 2.7, z: -5.5, side: 1 }); // 平台 C 底下
  propAcUnit(b, { x: 3.58, y: 5.3, z: -11.0, side: 1 }); // 平台 C 上方，二层的掩体参照
  propAcUnit(b, { x: 3.58, y: 4.1, z: 17.6, side: 1 });
  propAcUnit(b, { x: -3.6, y: 2.6, z: -6.5, side: -1 });
  propAcUnit(b, { x: -3.6, y: 5.2, z: -0.6, side: -1 }); // 平台 B 上方（避开 z=3.0 的敌人位）

  // ---- 立管 / 横管（贴墙，不挡路，不参与碰撞）-------------------------------
  b.detail(() => {
    b.cyl('metalStruct', 0.07, 0.07, 7.4, 10, 3.86, 3.7, -22.6);
    b.cyl('metalStruct', 0.07, 0.07, 7.4, 10, -3.86, 3.7, 15.0);
    b.cyl('metalStruct', 0.06, 0.06, 7.4, 10, 3.86, 3.7, 19.8);
    b.cyl('metalStruct', 0.06, 0.06, 5.0, 10, -3.86, 5.5, -9.6);
  });
  // 左墙高处两个挑出阳台（props.balconyGeo）：给没有走道的那一侧补上二层剪影。
  // 5.6m 高、够不着，所以不进碰撞体，纯粹是「这条巷子上面还有人住」的信息。
  b.detail(() => {
    b.geo('concreteCover', balconyGeo({ x: -HALF_W, y: 5.6, z: -8.0, w: 2.0, d: 1.1 }));
    b.geo('concreteCover', balconyGeo({ x: -HALF_W, y: 5.6, z: -14.5, w: 1.8, d: 1.05 }));
  });
  propPipeRun(b, { x: 3.9, y: 6.15, z0: -22.0, z1: 14.0, radius: 0.05 });
  propPipeRun(b, { x: -3.9, y: 6.5, z0: -17.0, z1: 12.0, radius: 0.045 });

  // ---- 晾衣绳（横跨巷子 —— 巷战最有辨识度的视觉符号）----------------------
  // 全部挂在**没有二层走道**的 z 段，免得玩家在楼板上穿模钻过衣服。
  propClothesLine(b, { x0: -HALF_W + 0.1, x1: HALF_W - 0.1, y: 4.7, z: 16.6, sag: 0.5 });
  propClothesLine(b, { x0: -HALF_W + 0.1, x1: HALF_W - 0.1, y: 4.4, z: -21.8, sag: 0.45 });

  // ---- 散落的圆垃圾桶 ------------------------------------------------------
  propBarrel(b, { x: -3.35, y: 0, z: 14.2, radius: 0.32, height: 0.95 });
  propBarrel(b, { x: 3.36, y: 0, z: 0.6, radius: 0.3, height: 0.9 });
  propBarrel(b, { x: 3.42, y: 0, z: -17.2, radius: 0.31, height: 0.92 });

  // ---- 燃烧的垃圾桶（远端左侧，火光的物理来源，z≈-17.5 —— 锚点，别动）------
  b.cyl('metalProp', 0.31, 0.29, 0.92, 14, -2.3, 0.46, -17.5);
  b.detail(() => {
    b.cyl('metalProp', 0.33, 0.33, 0.06, 14, -2.3, 0.9, -17.5);
    b.box('wood', 0.08, 0.9, 0.08, -2.15, 1.15, -17.35, 0.4, 0.35);
    b.box('wood', 0.07, 0.75, 0.07, -2.45, 1.05, -17.62, -0.6, -0.4);
  });

  // ---- 地面积水（dirt，穿透 0.35，弹着是泥花不是火花）----------------------
  b.puddle(1.3, 3.2, 1.7, 1.25, 0.3);
  b.puddle(-1.6, -16.2, 1.35, 1.05, -0.5);
  b.puddle(-0.5, -10.6, 0.95, 0.8, 0.9);
  b.puddle(0.9, -20.9, 1.5, 1.1, 0.2);
}

// ---------------------------------------------------------------------------
// 窗户（玻璃 + 框 + 窗内暖光面）
// ---------------------------------------------------------------------------

interface WindowSpec {
  side: 1 | -1;
  z: number;
  y: number;
  h: number;
  w: number;
  /** true = 窗内亮着；false = 黑窗（黑窗本身就是威胁感：里面可能有人） */
  lit: boolean;
}

const WINDOWS: WindowSpec[] = [
  { side: 1, z: -12.6, y: 2.5, h: 1.4, w: 1.7, lit: true }, // 平台 C 下方
  { side: -1, z: 4.6, y: 2.6, h: 1.3, w: 1.6, lit: true }, // 平台 B 下方
  { side: 1, z: 15.8, y: 3.1, h: 1.35, w: 1.6, lit: false }, // 黑窗：暗的那扇最吓人
  { side: -1, z: -11.5, y: 1.75, h: 1.5, w: 1.9, lit: true }, // 落地窗（锚点）
  { side: 1, z: -5.0, y: 5.15, h: 1.3, w: 1.6, lit: true }, // 二层：平台 C 的路标
  { side: -1, z: 1.4, y: 5.05, h: 1.2, w: 1.5, lit: false }, // 二层黑窗
];

/**
 * 窗户整套都不进碰撞体：玻璃和窗框都贴在实心墙面上，墙已经挡住玩家了，
 * 再让一堆细长窗棂进 Octree 只会白白炸出几千个节点。子弹照样能打中（在 hitMeshes 里）。
 */
function buildWindows(b: Builder, glow: GlowBuilder): void {
  b.detail(() => {
    for (const w of WINDOWS) {
      const s = w.side;
      const rotY = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      const xGlass = (HALF_W - 0.045) * s;
      const xGlow = (HALF_W - 0.012) * s;
      const xFrame = (HALF_W - 0.06) * s;

      // 玻璃（穿透 0.95 —— 打碎它等于永久改变一条视线）
      b.geo('glass', glassPaneGeo({ x: xGlass, y: w.y, z: w.z, w: w.w, h: w.h, rotY }));
      // 框（含中挺）
      b.geo('metalStruct', windowFrameGeo({ x: xFrame, y: w.y, z: w.z, w: w.w, h: w.h, rotY, mullions: 1 }));

      // 窗内暖光面（纯装饰，全部并进同一个 glow 网格 → 一次 draw call）
      if (w.lit) {
        glow.add(
          'window',
          new THREE.PlaneGeometry(w.w, w.h),
          xform(xGlow, w.y, w.z, s > 0 ? -Math.PI / 2 : Math.PI / 2),
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// InstancedMesh 小件 —— 重复度最高的两类，各一次 draw call
// ---------------------------------------------------------------------------

/** 碎砖 / 混凝土渣。太小，不进 hitMeshes（打它没有战术意义，只是视觉噪声）。 */
function buildRubbleInstances(mat: THREE.Material): THREE.InstancedMesh {
  const spots: [number, number, number][] = [
    [1.9, -21.5, 1.9],
    [-2.2, -19.6, 1.7],
    [5.9, -32.2, 2.4],
    [-6.2, -17.0, 1.8],
    [-1.6, -9.0, 1.4],
    [3.1, -14.6, 1.3],
    [-3.0, 12.2, 1.2],
    [0.6, -30.4, 2.0],
  ];
  const perSpot = 8;
  const count = spots.length * perSpot;
  const geo = new THREE.BoxGeometry(0.26, 0.17, 0.22);
  boxUV(geo, 0.26, 0.17, 0.22, TILE.brick);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const rnd = mulberry32(0x2b1c5);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  let i = 0;
  for (const [cx, cz, r] of spots) {
    for (let k = 0; k < perSpot; k++) {
      const a = rnd() * Math.PI * 2;
      const rr = r * Math.sqrt(rnd());
      const s = 0.55 + rnd() * 0.85;
      p.set(cx + Math.cos(a) * rr, 0.055 * s + rnd() * 0.03, cz + Math.sin(a) * rr);
      e.set((rnd() - 0.5) * 0.6, rnd() * 3.14, (rnd() - 0.5) * 0.6);
      q.setFromEuler(e);
      sc.set(s, s * (0.7 + rnd() * 0.6), s);
      mesh.setMatrixAt(i++, m.compose(p, q, sc));
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'alley-rubble-inst';
  mesh.castShadow = false; // 太碎，投影只会变成噪点
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  return mesh;
}

/** 晾衣绳上的衣物。整条巷子唯一的彩色物体 —— 冷灰基调里的一点人味。 */
function buildClothInstances(): THREE.InstancedMesh {
  // 三条绳：[x0, x1, y, z, sag]
  const lines: [number, number, number, number, number][] = [
    [-HALF_W + 0.1, HALF_W - 0.1, 4.7, 16.6, 0.5],
    [-HALF_W + 0.1, HALF_W - 0.1, 4.4, -21.8, 0.45],
    [SA_X + 0.1, SA_B_X - 0.1, 4.0, -9.5, 0.3],
  ];
  const per = 7;
  const count = lines.length * per;

  // 微微弯曲的布片，看起来才不像一张纸
  const geo = new THREE.PlaneGeometry(0.52, 0.72, 3, 1);
  {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, -0.09 * (1 - (x / 0.26) * (x / 0.26)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const palette = [0xb8c4cf, 0xc9a37a, 0x7f93a8, 0xd8d2c2, 0x8f6f68, 0xa8b49a, 0xcbbfae];
  const rnd = mulberry32(0x6c107);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  let i = 0;
  for (const [x0, x1, y, z, sag] of lines) {
    for (let k = 0; k < per; k++) {
      const t = (k + 0.5 + (rnd() - 0.5) * 0.4) / per;
      const yy = y - sag * 4 * t * (1 - t);
      const s = 0.8 + rnd() * 0.7;
      p.set(x0 + (x1 - x0) * t, yy - 0.36 * s, z + (rnd() - 0.5) * 0.06);
      e.set(0, (rnd() - 0.5) * 0.35, (rnd() - 0.5) * 0.16);
      q.setFromEuler(e);
      sc.set(s, s * (0.85 + rnd() * 0.5), 1);
      mesh.setMatrixAt(i, m.compose(p, q, sc));
      mesh.setColorAt(i, col.setHex(palette[(k + i) % palette.length]));
      i++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = 'alley-cloth-inst';
  mesh.castShadow = true; // 衣物在墙上的剪影是这条巷子最好看的一笔
  mesh.receiveShadow = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// 灯光
// ---------------------------------------------------------------------------

/**
 * 把平行光的正交阴影相机**恰好**收到关卡包围盒上。
 * 手填 left/right/top/bottom 必然会漏（光是斜着照的，包围盒在光空间里是歪的），
 * 这里把 8 个角点变换到光空间再取 min/max，一次算准，也不会浪费一格 shadow map。
 */
function fitShadowToBox(light: THREE.DirectionalLight, box: THREE.Box3, margin = 1.5): void {
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  const cam = light.shadow.camera;
  const toLight = cam.matrixWorldInverse;
  const v = new THREE.Vector3();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        v.set(x, y, z).applyMatrix4(toLight);
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
        minZ = Math.min(minZ, v.z);
        maxZ = Math.max(maxZ, v.z);
      }
    }
  }
  cam.left = minX - margin;
  cam.right = maxX + margin;
  cam.bottom = minY - margin;
  cam.top = maxY + margin;
  // 相机视空间里正前方是 -Z，所以距离 = -z
  cam.near = Math.max(0.1, -maxZ - margin);
  cam.far = -minZ + margin;
  cam.updateProjectionMatrix();
}

interface Flicker {
  light: THREE.PointLight;
  emissive?: THREE.MeshBasicMaterial;
  baseIntensity: number;
  baseColor: THREE.Color;
  home: THREE.Vector3;
  kind: 'fire' | 'lamp';
  seed: number;
}

function buildLights(
  group: THREE.Group,
  b: Builder,
  glow: GlowBuilder,
  glowMats: Record<GlowKey, THREE.MeshBasicMaterial>,
): Flicker[] {
  const flickers: Flicker[] = [];

  // ---- 基调：冷灰蓝 -------------------------------------------------------
  // 这六盏的 intensity 是在浏览器里做参数扫描实测标定出来的（见 docs/M0-验证记录.md）：
  // 8px 网格采样，目标 = 出生端 avg≈36 / 可见像素≈47%，中段 avg≈55 / 可见≈69%，过曝<1%。
  // **不要凭感觉改这六个数**。要调亮度先动 hemi/ambient，再动 sun。
  const hemi = new THREE.HemisphereLight(0x40536e, 0x0b0d11, 8.2);
  hemi.name = 'alley-hemi';
  hemi.position.set(0, 12, 0);
  group.add(hemi);

  const amb = new THREE.AmbientLight(0x121822, 4.2);
  amb.name = 'alley-ambient';
  group.add(amb);

  // ---- 主光：冷色平行光，只负责投出巷子的长影 ------------------------------
  const sun = new THREE.DirectionalLight(0x9db9e0, 9.9);
  sun.name = 'alley-sun';
  sun.position.set(16, 26, 11);
  sun.target.position.set(-1.5, 0, -3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.045;
  group.add(sun);
  group.add(sun.target);
  // 阴影相机严格收到关卡包围盒（含侧巷、楼梯间、广场）。
  // 2048 图铺在 ~57m 上 ≈ 36 texel/m，比扩建前的 40 略降，肉眼看不出来。
  fitShadowToBox(
    sun,
    new THREE.Box3(
      new THREE.Vector3(SA_CX - 0.4, -0.4, PZ_FAR - 0.9),
      new THREE.Vector3(ST_CX + 0.4, WALL_H, Z_NEAR + 0.9),
    ),
  );

  // ---- 暖橙人造光 1：巷子中段的壁挂路灯（z ≈ +2，右墙）--------------------
  // 全场最亮的一坨，也是最不该站的地方。二层走道刻意在 z ∈ [-1.9, 5.2] 断开，
  // 就是为了不把它罩住 —— 它得同时照到地面和两段连桥。
  {
    const z = 2.0;
    b.rod('metalStruct', new THREE.Vector3(HALF_W, 5.15, z), new THREE.Vector3(2.9, 4.98, z), 0.05, 8);
    b.rod('metalStruct', new THREE.Vector3(HALF_W, 5.75, z), new THREE.Vector3(3.25, 5.05, z), 0.032, 6);
    b.detail(() => {
      b.box('metalStruct', 0.64, 0.2, 0.36, 2.78, 4.88, z, 0, -0.06); // 灯罩
      b.box('metalStruct', 0.2, 0.3, 0.3, 3.28, 5.02, z); // 接线盒
    });

    const lens = new THREE.PlaneGeometry(0.5, 0.26);
    glow.add('lamp', lens, xform(2.78, 4.74, z, 0, 0, Math.PI / 2));

    const lamp = new THREE.PointLight(0xffb066, 220, 20, 2);
    lamp.name = 'alley-lamp';
    lamp.position.set(2.78, 4.66, z);
    group.add(lamp);
    flickers.push({
      light: lamp,
      emissive: glowMats.lamp,
      baseIntensity: 220,
      baseColor: glowMats.lamp.color.clone(),
      home: lamp.position.clone(),
      kind: 'lamp',
      seed: 11.3,
    });
  }

  // ---- 暖橙人造光 2：左墙落地窗透出来的光（z ≈ -11.5）---------------------
  // 光洒在地上，正好舔过 C5 混凝土残墙 —— 躲在真掩体后面反而被照亮，是个漂亮的两难。
  {
    const glowLight = new THREE.PointLight(0xffc98f, 90, 11, 2);
    glowLight.name = 'alley-window';
    glowLight.position.set(-3.3, 1.8, -11.5);
    group.add(glowLight);
  }

  // ---- 暖橙人造光 3：远端燃烧的垃圾桶（z ≈ -17.5）-------------------------
  {
    const fireCore = new THREE.CylinderGeometry(0.04, 0.24, 0.62, 8, 1, true);
    glow.add('fireCore', fireCore, xform(-2.3, 1.2, -17.5));
    const fireOuter = new THREE.CylinderGeometry(0.1, 0.34, 0.8, 8, 1, true);
    glow.add('fireOuter', fireOuter, xform(-2.3, 1.28, -17.5));

    const fire = new THREE.PointLight(0xff6a1e, 140, 15, 2);
    fire.name = 'alley-fire';
    fire.position.set(-2.3, 1.2, -17.5);
    group.add(fire);
    flickers.push({
      light: fire,
      emissive: glowMats.fireOuter,
      baseIntensity: 140,
      baseColor: glowMats.fireOuter.color.clone(),
      home: fire.position.clone(),
      kind: 'fire',
      seed: 57.9,
    });
    // 火焰内芯用另一条相位，只驱动自发光（baseIntensity=0 → 不再改这盏灯）
    flickers.push({
      light: fire,
      emissive: glowMats.fireCore,
      baseIntensity: 0,
      baseColor: glowMats.fireCore.color.clone(),
      home: fire.position.clone(),
      kind: 'fire',
      seed: 23.1,
    });
  }

  // ---- 新增 1/2：侧巷冷色应急灯（z ≈ -10.4）--------------------------------
  // 侧巷是唯一一处冷光源。冷 ≠ 安全：它同样是路标 + 危险位置，
  // 而且它把从主巷钻进来的人整个照亮，主巷这边看得一清二楚。
  {
    const em = new THREE.PointLight(0x8fd6ff, 110, 13, 2);
    em.name = 'alley-side-emergency';
    em.position.set(-5.6, 3.5, -10.4);
    group.add(em);
    b.detail(() => {
      b.box('metalStruct', 0.16, 0.3, 0.52, -5.22, 3.62, -10.4); // 灯壳
      b.box('metalStruct', 0.1, 0.1, 0.6, -5.22, 3.86, -10.4);
    });
    glow.add('cold', new THREE.PlaneGeometry(0.44, 0.2), xform(-5.38, 3.6, -10.4, Math.PI / 2));
    // 楼梯间里那块「出口」标识 —— 不发光照明，只是个亮点，指出室内通道在哪
    glow.add('cold', new THREE.PlaneGeometry(0.46, 0.18), xform(ST_X0 + 0.06, 4.9, 7.0, -Math.PI / 2));
    glow.add('cold', new THREE.PlaneGeometry(0.4, 0.16), xform(HALF_W - 0.02, 2.85, DOOR_R2, -Math.PI / 2));
  }

  // ---- 新增 2/2：二层走道的暖色壁灯（平台 C 上方，z ≈ -7.2）---------------
  // 二层俯射位有了光，就同时有了「被看见」的代价 —— 上面的人也不是白拿视野。
  {
    const deck = new THREE.PointLight(0xffa860, 130, 14, 2);
    deck.name = 'alley-deck-lamp';
    deck.position.set(2.55, 5.1, -7.2);
    group.add(deck);
    b.detail(() => {
      b.box('metalStruct', 0.46, 0.16, 0.3, 2.62, 5.3, -7.2, 0, 0.12);
      b.rod(
        'metalStruct',
        new THREE.Vector3(HALF_W, 5.6, -7.2),
        new THREE.Vector3(2.78, 5.36, -7.2),
        0.035,
        6,
      );
    });
    glow.add('deckLamp', new THREE.PlaneGeometry(0.36, 0.22), xform(2.6, 5.19, -7.2, 0, 0, Math.PI / 2));
  }

  return flickers;
}

/**
 * 灯光闪烁。**用 time.elapsed（unscaled）** —— 火焰和路灯不该被 hit-stop 冻住，
 * 冻住会让定帧读起来像「掉帧」而不是「打中了」。
 *
 * 纯函数式：只依赖 time.elapsed，重复调用幂等，所以既能被
 * setUnscaledTimeout 驱动，也能被 main.ts 每帧调用，不会打架。
 */
function makeLightUpdater(flickers: Flicker[]): () => void {
  return () => {
    const t = time.elapsed;
    for (const f of flickers) {
      let mul: number;
      if (f.kind === 'fire') {
        const n = fbmSigned(f.seed, t * 6.5, 3);
        const gust = noiseSigned(f.seed + 4.7, t * 1.3);
        mul = clamp(0.68 + 0.34 * n + 0.16 * gust, 0.35, 1.5);
      } else {
        const buzz = noiseSigned(f.seed + 3.1, t * 27);
        const fail = noiseSigned(f.seed, t * 2.7);
        mul = 1 + 0.035 * buzz;
        if (fail > 0.74) mul *= 0.42 + 0.34 * (buzz * 0.5 + 0.5);
      }
      if (f.baseIntensity > 0) {
        f.light.intensity = f.baseIntensity * mul;
        if (f.kind === 'fire') {
          f.light.position.set(
            f.home.x + 0.09 * noiseSigned(f.seed + 9.2, t * 3.4),
            f.home.y + 0.07 * noiseSigned(f.seed + 12.8, t * 4.1),
            f.home.z + 0.09 * noiseSigned(f.seed + 15.5, t * 3.1),
          );
        }
      }
      if (f.emissive !== undefined) {
        f.emissive.color.copy(f.baseColor).multiplyScalar(clamp(mul, 0.3, 1.6));
      }
    }
  };
}

// ---------------------------------------------------------------------------
// buildAlley
// ---------------------------------------------------------------------------

export function buildAlley(): LevelBuild {
  const group = new THREE.Group();
  group.name = 'alley';

  /** 全部实体渲染几何（同时就是 hitMeshes） */
  const solid = new THREE.Group();
  solid.name = 'alley-solid';
  /** 纯装饰（自发光面 + InstancedMesh 小件），不进 Octree、不进 hitMeshes */
  const decor = new THREE.Group();
  decor.name = 'alley-decor';
  group.add(solid, decor);

  const b = new Builder();
  const glow = new GlowBuilder();
  const glowMats = makeGlowMaterials();

  buildGround(b);
  buildMainWalls(b);
  buildSideAlley(b);
  buildPlaza(b);
  buildStairwell(b);
  buildUpperLevel(b);
  buildCovers(b);
  buildProps(b);
  buildWindows(b, glow);
  const flickers = buildLights(group, b, glow, glowMats);

  // ---- 合并 + 建 BVH ------------------------------------------------------
  const materials = makeMaterials();
  const hitMeshes: THREE.Mesh[] = [];

  for (const [key, geos] of b.entries()) {
    if (geos.length === 0) continue;
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) {
      for (const g of geos) g.dispose();
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    // three-mesh-bvh：给每个合并网格建一棵 BVH，hitscan 走 acceleratedRaycast
    merged.computeBoundsTree({ targetLeafSize: 8 });

    const mesh = new THREE.Mesh(merged, materials[key]);
    mesh.name = `alley-${key}`;
    mesh.userData.surface = KEY_SURFACE[key];
    mesh.castShadow = CASTS_SHADOW[key];
    mesh.receiveShadow = key !== 'glass';
    // 几何已经烘到世界坐标，网格本身永远是单位矩阵
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    hitMeshes.push(mesh);
    solid.add(mesh);
  }

  // ---- 自发光装饰（按材质合并，6 次 draw call）----------------------------
  glow.flush(decor, glowMats);

  // ---- InstancedMesh 小件 -------------------------------------------------
  // 刻意**不**进 hitMeshes：碎砖和衣服被打中没有战术意义，
  // 而且 hitMeshes 每多一个，weapon 的每次 hitscan 和 main 的每次视线判定都多一轮遍历。
  decor.add(buildRubbleInstances(materials.brick), buildClothInstances());

  // ---- 碰撞体：从简化的盒子 / 斜坡代理建，而不是从渲染几何建 ---------------
  const proxyMesh = new THREE.Mesh(b.colliderGeometry());
  proxyMesh.name = 'alley-collision-proxy';
  proxyMesh.visible = false;
  proxyMesh.matrixAutoUpdate = false;
  proxyMesh.updateMatrix();
  const collider = new Octree();
  collider.fromGraphNode(proxyMesh);
  // Octree 已经把三角形拷进自己的结构里了，代理网格本身不需要留在场景里
  proxyMesh.geometry.dispose();

  // ---- 灯光动画 ----------------------------------------------------------
  const updateLights = makeLightUpdater(flickers);
  const tick = (): void => {
    updateLights();
    setUnscaledTimeout(tick, 50);
  };
  setUnscaledTimeout(tick, 50);

  group.userData.updateLights = updateLights;
  // 给 main.ts 的建议值（不强制）。雾密度沿用标定时的 0.016：
  // 广场在 45~56m 外，正好被雾吃掉大半 —— 巷口那一头「看得见但看不清」是故意的。
  group.userData.suggestedFog = new THREE.FogExp2(0x0a0d13, 0.016);
  group.userData.suggestedBackground = new THREE.Color(0x090b10);

  // ---- 出生点 / 敌人点 ----------------------------------------------------
  // 玩家在近端（+Z），朝 -Z 看进巷子深处。y 是胶囊底部。**锚点，不动**。
  const spawnPoint = new THREE.Vector3(0, 0.1, 18.0);

  /**
   * 七个战术位：地面 4（含侧巷 1）+ 二层 3。
   * 覆盖四种「掩体教学」和一条完整的高度差对抗：
   *   #1 木头陷阱 / #2 真掩体 / #3 切派清角 / #4 侧翼（要么绕环线要么打穿围挡）
   *   #5 #6 二层俯射（地面必须找角度或上楼）/ #7 连桥端头（下面的人抬头就能看见）
   * 每个点都在楼板 / 地面之上，四周至少留 0.6m 净空，站得住也不卡几何。
   */
  const enemySpawns: THREE.Vector3[] = [
    new THREE.Vector3(1.6, 0, -4.7), // 三合板隔断后：看不见但打得穿（wood 0.75）
    new THREE.Vector3(-1.75, 0, -9.9), // 混凝土残墙后：真掩体，必须换角度
    new THREE.Vector3(5.1, 0.06, DOOR_R1), // 右墙深凹进（地面比巷面高 6cm）：只能靠切派清角
    new THREE.Vector3(-6.4, 0, -11.2), // 侧巷 B 段，冷色应急灯下：侧翼火力
    new THREE.Vector3(2.9, Y2, -16.6), // 二层平台 C 远端：俯射远段 + 盯着侧巷汇入口
    new THREE.Vector3(2.9, Y2, -6.0), // 二层平台 C 中段：俯射主巷中段（暖色壁灯正下方）
    new THREE.Vector3(-2.9, Y2, 3.0), // 二层平台 B：俯射路灯段与连桥 1
  ];

  return { group, collider, hitMeshes, spawnPoint, enemySpawns };
}

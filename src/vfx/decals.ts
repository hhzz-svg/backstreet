/**
 * 弹孔贴花系统（LRU）。
 *
 * 贴花是「我刚才打过这里」的唯一持久证据，也是玩家读地图和读交火的依据。
 * 但它是 M0 里唯一一个必须在运行时 new 几何的东西：DecalGeometry 要把目标
 * 网格的三角形裁进投影盒里，形状因命中位置而异，没法预生成。
 *
 * 因此这里做的池化是「除几何以外，全部预分配」：
 * - max 个 THREE.Mesh 在构造时建好，全部 visible=false 挂在场景里；
 * - max 个材质在构造时建好（每个贴花要独立 opacity 才能各自淡出，
 *   不能共享一个材质），材质配置完全一致 → three 仍然只编译一个 shader；
 * - add() 只 new 一个 DecalGeometry，退役时立即 dispose 掉。
 *
 * 材质必须：transparent:true, depthTest:true, depthWrite:false,
 * polygonOffset:true, polygonOffsetFactor:-4 —— 否则贴花和墙面 z-fighting，
 * 会在斜视角下闪成一片噪声。
 *
 * LRU 淡出：最老的一批（约 12%）会被持续压低 opacity，等真正需要腾槽位时
 * 它们已经几乎看不见了 —— 贴花「凭空消失」的突兀感就没了。
 *
 * 双时钟：update(dt) 的 dt 必须是 time.unscaledDelta。
 */

import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { expApproach, lerp } from '../core/time';
import { feelConfig, feelOn } from '../feel/config';
import { holeTexture } from './textures';

interface Slot {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  material: THREE.MeshBasicMaterial;
  /** 当前拥有的贴花几何（退役时 dispose） */
  geo: THREE.BufferGeometry | null;
  opacity: number;
  target: number;
  index: number;
}

// --- 模块级临时量 -----------------------------------------------------------
const _helper = new THREE.Object3D(); // 用 lookAt 求投影朝向
const _lookTarget = new THREE.Vector3();
const _size = new THREE.Vector3();
const _orientation = new THREE.Euler();

/** 空几何占位：未使用的槽位挂它，避免 mesh.geometry 为 null */
const EMPTY_GEO = new THREE.BufferGeometry();

export class DecalSystem {
  private readonly slots: Slot[] = [];
  /** 使用中的槽位，按加入顺序（下标 0 最老） */
  private readonly order: Slot[] = [];
  private readonly freeStack: Slot[] = [];
  private readonly fadeZone: number;

  /**
   * @param max 贴花上限。默认取 feelConfig.vfx.maxDecals。
   *            实际生效上限 = min(max, feelConfig.vfx.maxDecals)，
   *            所以 dev 面板把 maxDecals 调小会立刻生效（调大不超过 max）。
   */
  constructor(
    private readonly scene: THREE.Scene,
    max: number = feelConfig.vfx.maxDecals,
  ) {
    const n = Math.max(1, Math.floor(max));
    const map = holeTexture();

    for (let i = 0; i < n; i++) {
      const material = new THREE.MeshBasicMaterial({
        map,
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        side: THREE.FrontSide,
        fog: true,
      });
      const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(EMPTY_GEO, material);
      // DecalGeometry 输出的是世界空间顶点 → 贴花网格必须保持单位变换
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 1; // 不透明体之后、粒子之前
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      scene.add(mesh);

      const slot: Slot = { mesh, material, geo: null, opacity: 1, target: 1, index: i };
      this.slots.push(slot);
      this.freeStack.push(slot);
    }

    this.fadeZone = Math.max(1, Math.floor(n * 0.12));
  }

  get activeCount(): number {
    return this.order.length;
  }

  get capacity(): number {
    return this.slots.length;
  }

  /**
   * 在 mesh 表面投一枚贴花。
   *
   * @param mesh   命中的目标网格（必须有 position 属性；由 hitscan 层给出）
   * @param point  命中点（世界坐标）
   * @param normal 命中面法线（世界空间，指向射击者）
   * @param size   贴花直径（米），弹孔一般 0.08~0.16
   * @param color  贴花染色，取 SURFACES[kind].decalColor
   */
  add(
    mesh: THREE.Mesh,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    size: number,
    color: number,
  ): void {
    if (!feelOn(feelConfig.vfx.decals)) return;
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes.position) return;

    const cap = Math.min(this.slots.length, Math.max(0, Math.floor(feelConfig.vfx.maxDecals)));
    if (cap <= 0) return;

    // DecalGeometry 直接读 mesh.matrixWorld，先保证它是新的
    mesh.updateWorldMatrix(true, false);

    // 投影器朝向：站在命中点，看向法线方向；再绕视线轴随机自转，
    // 让连续几发的弹孔不会是同一个印章。
    _lookTarget.copy(point).add(normal);
    _helper.position.copy(point);
    _helper.up.set(0, 1, 0);
    // 法线接近竖直时 lookAt 会退化，换一个 up
    if (Math.abs(normal.y) > 0.99) _helper.up.set(0, 0, 1);
    _helper.lookAt(_lookTarget);
    _orientation.copy(_helper.rotation);
    _orientation.z = Math.random() * Math.PI * 2;

    // z 是投影盒厚度：太薄会漏掉曲面，太厚会穿到薄墙背面
    _size.set(size, size, size * 1.2);

    let geo: THREE.BufferGeometry;
    try {
      geo = new DecalGeometry(mesh, point, _orientation, _size);
    } catch {
      return; // 目标几何不受支持（比如没有 position），静默放弃
    }
    const posAttr = geo.attributes.position;
    if (!posAttr || posAttr.count === 0) {
      geo.dispose(); // 投影没切到任何三角形，别占槽位
      return;
    }

    // 先腾位置：满了就把最老的退役（它此时已经淡得差不多了）
    while (this.order.length >= cap) {
      const oldest = this.order.shift();
      if (!oldest) break;
      this.retire(oldest);
    }

    const slot = this.freeStack.pop();
    if (!slot) {
      geo.dispose();
      return;
    }

    slot.geo = geo;
    slot.mesh.geometry = geo;
    slot.material.color.setHex(color);
    slot.opacity = 1;
    slot.target = 1;
    slot.material.opacity = 1;
    slot.mesh.visible = true;
    this.order.push(slot);
  }

  private retire(slot: Slot): void {
    slot.mesh.visible = false;
    slot.mesh.geometry = EMPTY_GEO;
    if (slot.geo) {
      slot.geo.dispose();
      slot.geo = null;
    }
    slot.opacity = 1;
    slot.target = 1;
    slot.material.opacity = 1;
    this.freeStack.push(slot);
  }

  /**
   * @param dt 必须是 time.unscaledDelta
   *
   * 只处理最老的 fadeZone 个：贴花一旦排到队列前段就再也回不去，
   * 后面的永远是 opacity=1，不需要每帧访问。
   */
  update(dt: number): void {
    const n = this.order.length;
    if (n === 0) return;

    const zone = Math.min(this.fadeZone, n);
    const k = expApproach(5, dt);
    for (let i = 0; i < zone; i++) {
      const slot = this.order[i];
      // 越老目标越低：队首约 1/(zone+1)，队尾接近 1
      slot.target = (i + 1) / (this.fadeZone + 1);
      slot.opacity = lerp(slot.opacity, slot.target, k);
      slot.material.opacity = slot.opacity;
    }
  }

  /** 清空全部贴花（重开局 / 重建关卡时调用） */
  clear(): void {
    for (let i = 0; i < this.order.length; i++) this.retire(this.order[i]);
    this.order.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const slot of this.slots) {
      this.scene.remove(slot.mesh);
      slot.material.dispose();
    }
    this.slots.length = 0;
    this.freeStack.length = 0;
  }
}

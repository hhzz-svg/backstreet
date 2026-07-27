/**
 * 敌人 —— 会还击的靶子。
 *
 * M0 的敌人不需要寻路、不需要战术，它只需要三件事做对：
 * 1. **命中部位可分离**：头 / 躯干 / 四肢三种碰撞体，打哪儿是哪儿，爆头必须能被玩家「看出来」。
 * 2. **受击有反馈**：0.12s 闪白 + 受击位移 + 短硬直。没有这一层，射击就只是数字在跳。
 * 3. **会还击**：有 ~0.35s 反应延迟，然后按 1.2~1.8s 的节奏带散布地开火。
 *    反应延迟是「先手优势」的来源 —— 没有它，探头对枪就没有意义。
 *
 * 双时钟：`update(dt)` 用 **scaledDelta**。
 * 注意受击闪白也走 scaled —— 这是**故意**的：hit-stop 定帧期间白光会保持住，
 * 定帧结束才继续衰减，读起来就是「这一下砸实了」。走 unscaled 反而会在定帧里闪完。
 * 只有自动重生的 3s 计时走 `setUnscaledTimeout`（墙钟），否则慢镜里会拖长。
 *
 * 几何全部程序化生成，零外部资源。几何在模块级共享（含 BVH），材质每个实例独立
 * （闪白要按个体触发，共享材质会让整场敌人一起白）。
 */

import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';
import type { BodyPart, EnemyRef } from '../types';
import { expApproach, lerp, setUnscaledTimeout, type UnscaledTimer } from '../core/time';
import { randInDisk } from '../core/noise';

// three-mesh-bvh 安装到 three 原型上。重复安装是幂等的，
// 所以关卡层即使也装了一遍也不冲突（大家 import 的是同一个模块实例）。
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ---------------------------------------------------------------------------
// 调参常量
// ---------------------------------------------------------------------------

const MAX_HP = 100;

/** 看见玩家后的反应延迟（秒）—— 玩家的先手窗口 */
const REACTION_SEC = 0.35;
/** 丢失视野后仍保持警戒的时间（秒）；超时后要重新走一遍反应延迟 */
const MEMORY_SEC = 0.8;
/** 射击间隔区间（秒） */
const FIRE_MIN = 1.2;
const FIRE_MAX = 1.8;
/** 散布半角（度） */
const SPREAD_DEG = 2.5;
/** 单发伤害（打在无甲玩家身上） */
const DAMAGE = 14;

/** 转向刚度 */
const TURN_STIFF = 6.5;

/** 闪白时长（秒）与强度 */
const FLASH_SEC = 0.12;
const FLASH_INTENSITY = 1.5;
const FLASH_INTENSITY_HEAD = 2.4;

/** 受击位移最大值（米）与回弹刚度 */
const LURCH_MAX = 0.07;
const LURCH_STIFF = 14;
/** 受击硬直（秒）—— 期间不开枪、转向减慢 */
const STAGGER_SEC = 0.12;

/** 倒地动画时长（秒） */
const DEATH_SEC = 0.5;
/** 击杀后自动重生延迟（毫秒）—— M0 是打靶场，要能反复验证手感 */
const RESPAWN_MS = 3000;

/** 枪口相对脚底原点的局部偏移（面朝 -Z） */
const MUZZLE_LOCAL = new THREE.Vector3(0.16, 1.36, -0.32);

const DEG = Math.PI / 180;

// 复用临时对象
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// 共享几何（含 BVH）—— 只建一次，所有敌人复用
// ---------------------------------------------------------------------------

interface SharedGeo {
  head: THREE.SphereGeometry;
  torso: THREE.BoxGeometry;
  arm: THREE.BoxGeometry;
  leg: THREE.BoxGeometry;
  band: THREE.BoxGeometry;
  pad: THREE.BoxGeometry;
}

let sharedGeo: SharedGeo | null = null;

function getSharedGeo(): SharedGeo {
  if (sharedGeo) return sharedGeo;
  const head = new THREE.SphereGeometry(0.13, 16, 12);
  const torso = new THREE.BoxGeometry(0.44, 0.72, 0.26);
  const arm = new THREE.BoxGeometry(0.12, 0.58, 0.13);
  const leg = new THREE.BoxGeometry(0.16, 0.78, 0.18);
  const band = new THREE.BoxGeometry(0.46, 0.075, 0.285);
  const pad = new THREE.BoxGeometry(0.15, 0.07, 0.17);

  // 命中体建 BVH，和关卡走同一套加速结构（配合 raycaster.firstHitOnly）
  head.computeBoundsTree();
  torso.computeBoundsTree();
  arm.computeBoundsTree();
  leg.computeBoundsTree();

  sharedGeo = { head, torso, arm, leg, band, pad };
  return sharedGeo;
}

type AIState = 'idle' | 'alert' | 'engage';

export class Enemy implements EnemyRef {
  // ---- 契约字段 ---------------------------------------------------------
  id: number;
  alive = true;
  hp = MAX_HP;
  maxHp = MAX_HP;
  readonly object: THREE.Group;
  /** 头 / 躯干 / 四肢命中体。`userData.part` + `userData.surface='flesh'` + `userData.enemy=this` */
  readonly hitParts: THREE.Mesh[] = [];
  onShoot?: (origin: THREE.Vector3, dir: THREE.Vector3, damage: number) => void;

  // ---- 附加公开字段（契约外，集成时可调） -------------------------------
  /** 单发伤害，main 可以按难度改 */
  damage = DAMAGE;
  /**
   * 瞄准点在 `playerPos` 之上的额外抬高（米）。
   * 契约没说 `playerPos` 传的是眼睛还是脚底，所以下面 `aimPoint()` 里做了兜底：
   * 如果传进来的点低于敌人脚底 1m，就当作脚底坐标自动抬到胸口高度。
   */
  aimOffsetY = 0;
  /** 死亡后是否自动重生（M0 打靶场默认开） */
  autoRespawn = true;
  /** 死亡回调，供音频 / 计分用 */
  onDeath?: (id: number) => void;

  // ---- 内部状态 ---------------------------------------------------------
  private readonly scene: THREE.Scene;
  private readonly body = new THREE.Group();
  private readonly spawnPos = new THREE.Vector3();

  private readonly clothMat: THREE.MeshStandardMaterial;
  private readonly skinMat: THREE.MeshStandardMaterial;
  private readonly accentMat: THREE.MeshStandardMaterial;
  private readonly ownMaterials: THREE.Material[] = [];

  private yaw = 0;
  private state: AIState = 'idle';
  private seeT = 0;
  private lostT = 0;
  private fireTimer = 0;
  private staggerT = 0;

  private flashT = 0;
  private flashPeak = 0;
  private readonly lurch = new THREE.Vector3();

  private deathT = 0;
  private readonly fallAxis = new THREE.Vector3(1, 0, 0);
  private respawnTimer: UnscaledTimer | null = null;

  /** 待机呼吸相位，用 id 错开，免得一排敌人整齐划一地喘气 */
  private phase: number;
  private clock = 0;

  constructor(scene: THREE.Scene, pos: THREE.Vector3, id: number) {
    this.scene = scene;
    this.id = id;
    this.phase = (id * 1.7) % (Math.PI * 2);
    this.spawnPos.copy(pos);

    const geo = getSharedGeo();

    // 暗巷配色：深蓝灰的衣服（不出戏），暖橙识别带（自发光，暗处也认得出）
    this.clothMat = new THREE.MeshStandardMaterial({
      color: 0x2c313a,
      roughness: 0.86,
      metalness: 0.05,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    this.skinMat = new THREE.MeshStandardMaterial({
      color: 0x9a7358,
      roughness: 0.72,
      metalness: 0,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: 0xff8a2b,
      roughness: 0.5,
      metalness: 0.1,
      emissive: 0xff6a10,
      emissiveIntensity: 0.55, // 微微发光，让它在暗巷里被看见（bloom 阈值 0.85 以下，不会糊）
    });
    this.ownMaterials.push(this.clothMat, this.skinMat, this.accentMat);

    this.object = new THREE.Group();
    this.object.name = `enemy_${id}`;
    this.object.position.copy(pos);
    this.object.add(this.body);

    // --- 命中体 ---------------------------------------------------------
    // 站姿总高约 1.75m：腿 0.01~0.79，躯干 0.79~1.51，头心 1.64
    this.addPart(geo.head, this.skinMat, 'head', 0, 1.64, 0);
    this.addPart(geo.torso, this.clothMat, 'torso', 0, 1.15, 0);
    this.addPart(geo.arm, this.clothMat, 'limb', -0.28, 1.18, 0);
    this.addPart(geo.arm, this.clothMat, 'limb', 0.28, 1.18, 0);
    this.addPart(geo.leg, this.clothMat, 'limb', -0.115, 0.4, 0);
    this.addPart(geo.leg, this.clothMat, 'limb', 0.115, 0.4, 0);

    // --- 装饰（不参与命中判定，故意挂在 body 下而不是命中体的子节点）-------
    this.addDeco(geo.band, 1.34, 0);
    this.addDeco(geo.pad, 1.42, -0.28);
    this.addDeco(geo.pad, 1.42, 0.28);

    scene.add(this.object);
  }

  // -------------------------------------------------------------------------
  // 构建
  // -------------------------------------------------------------------------

  private addPart(
    geometry: THREE.BufferGeometry,
    material: THREE.MeshStandardMaterial,
    part: BodyPart,
    x: number,
    y: number,
    z: number,
  ): void {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.userData.part = part;
    mesh.userData.surface = 'flesh';
    mesh.userData.enemy = this;
    mesh.userData.enemyId = this.id;

    // 死亡后尸体不再参与射线：直接短路 raycast。
    // 这里刻意走 `THREE.Mesh.prototype.raycast`（而不是构造时缓存原函数），
    // 这样无论谁在什么时候装了 acceleratedRaycast，都能用上 BVH。
    mesh.raycast = (raycaster, intersects) => {
      if (!this.alive) return;
      THREE.Mesh.prototype.raycast.call(mesh, raycaster, intersects);
    };

    this.body.add(mesh);
    this.hitParts.push(mesh);
  }

  private addDeco(geometry: THREE.BufferGeometry, y: number, x: number): void {
    const mesh = new THREE.Mesh(geometry, this.accentMat);
    mesh.position.set(x, y, 0);
    mesh.castShadow = false;
    this.body.add(mesh);
  }

  // -------------------------------------------------------------------------
  // 伤害
  // -------------------------------------------------------------------------

  /**
   * `amount` 已经是**最终伤害**（部位倍率 / 距离衰减 / 穿透衰减由武器层算完），
   * 这里不再乘 `PART_MULTIPLIER`。`part` 只用来决定反馈强度。
   * `fromDir` 是子弹飞行方向（射手 → 敌人）。
   */
  applyDamage(amount: number, part: BodyPart, fromDir: THREE.Vector3): void {
    if (!this.alive) return;

    this.hp -= amount;

    // 闪白
    this.flashT = FLASH_SEC;
    this.flashPeak = part === 'head' ? FLASH_INTENSITY_HEAD : FLASH_INTENSITY;

    // 受击位移：沿子弹方向推一下，头/躯干推得多，四肢轻一点
    const push = part === 'head' ? LURCH_MAX : part === 'torso' ? LURCH_MAX * 0.8 : LURCH_MAX * 0.45;
    _v1.set(fromDir.x, 0, fromDir.z);
    if (_v1.lengthSq() > 1e-8) {
      _v1.normalize().multiplyScalar(push);
      this.lurch.add(_v1);
      if (this.lurch.length() > LURCH_MAX) this.lurch.setLength(LURCH_MAX);
    }

    // 硬直：打断当前射击节奏，给玩家「压制住了」的手感
    this.staggerT = STAGGER_SEC;
    this.fireTimer = Math.max(this.fireTimer, STAGGER_SEC);

    if (this.hp <= 0) {
      this.hp = 0;
      this.die(fromDir);
    }
  }

  private die(fromDir: THREE.Vector3): void {
    this.alive = false;
    this.deathT = 0;
    this.state = 'idle';
    this.seeT = 0;

    // 顺着子弹方向倒下：绕「上 × 子弹水平方向」这根轴转 90°，像树一样从脚踝倒。
    _v1.set(fromDir.x, 0, fromDir.z);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, -1);
    _v1.normalize();
    _axis.copy(UP).cross(_v1).normalize();
    // object 只有 Y 旋转，把世界轴转进 body 的局部空间
    _axis.applyAxisAngle(UP, -this.yaw);
    this.fallAxis.copy(_axis);

    this.onDeath?.(this.id);

    if (this.autoRespawn) {
      this.respawnTimer?.cancel();
      // 用墙钟：慢镜/定帧不该把重生等待一起拉长
      this.respawnTimer = setUnscaledTimeout(() => {
        this.respawnTimer = null;
        this.respawn(this.spawnPos);
      }, RESPAWN_MS);
    }
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  /**
   * dt 用 **scaledDelta** —— AI / 动画都属于玩法时间，定帧和慢镜要吃到。
   * `canSee` 由外部做视线检测（射线打世界几何）后传进来。
   */
  update(dt: number, playerPos: THREE.Vector3, canSee: boolean): void {
    if (dt <= 0) return;
    this.clock += dt;

    this.updateFlash(dt);

    if (!this.alive) {
      this.updateDeath(dt);
      return;
    }

    // 受击位移回弹
    this.lurch.multiplyScalar(1 - expApproach(LURCH_STIFF, dt));
    this.staggerT = Math.max(0, this.staggerT - dt);

    // 待机呼吸：极轻微的上下起伏，让它不像个静止的箱子
    const breathe = Math.sin(this.clock * 1.6 + this.phase) * 0.012;
    this.body.position.set(this.lurch.x, breathe + this.lurch.y, this.lurch.z);

    this.updateAI(dt, playerPos, canSee);
  }

  private updateAI(dt: number, playerPos: THREE.Vector3, canSee: boolean): void {
    // --- 感知 -----------------------------------------------------------
    if (canSee) {
      this.lostT = 0;
      this.seeT += dt;
      // 反应延迟走完就进 engage。fireTimer 在待机期间一直在减，
      // 所以进 engage 的那一帧它必然 <= 0 —— 第一发紧跟反应延迟打出，之后才进入正常节奏。
      this.state = this.seeT >= REACTION_SEC ? 'engage' : 'alert';
    } else {
      this.lostT += dt;
      if (this.lostT > MEMORY_SEC) {
        this.state = 'idle';
        this.seeT = 0; // 重新露头要重新走一遍反应延迟
      } else if (this.state === 'engage') {
        this.state = 'alert';
      }
    }

    // --- 转向 -----------------------------------------------------------
    if (this.state !== 'idle') {
      const dx = playerPos.x - this.object.position.x;
      const dz = playerPos.z - this.object.position.z;
      if (dx * dx + dz * dz > 1e-6) {
        // 模型正面朝 -Z（和相机默认前向一致）
        const target = Math.atan2(-dx, -dz);
        let diff = target - this.yaw;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        const stiff = this.staggerT > 0 ? TURN_STIFF * 0.35 : TURN_STIFF;
        this.yaw += diff * expApproach(stiff, dt);
      }
    } else {
      // 待机：缓慢摆回原朝向 + 轻微左右张望
      const idleYaw = Math.sin(this.clock * 0.35 + this.phase) * 0.35;
      this.yaw = lerp(this.yaw, idleYaw, expApproach(1.2, dt));
    }
    this.object.rotation.y = this.yaw;

    // --- 射击 -----------------------------------------------------------
    this.fireTimer -= dt;
    if (this.state === 'engage' && this.staggerT <= 0 && this.fireTimer <= 0) {
      this.shoot(playerPos);
      this.fireTimer = FIRE_MIN + Math.random() * (FIRE_MAX - FIRE_MIN);
    }
  }

  private shoot(playerPos: THREE.Vector3): void {
    if (!this.onShoot) {
      this.fireTimer = FIRE_MIN;
      return;
    }

    // 枪口世界坐标：本帧刚改过 rotation.y，先把矩阵刷出来
    this.object.updateMatrixWorld(true);
    const origin = this.object.localToWorld(_v2.copy(MUZZLE_LOCAL)).clone();

    this.aimPoint(playerPos, _aim);
    _dir.copy(_aim).sub(origin);
    if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();

    // 圆盘采样散布 —— 两个独立均匀数会往中心堆，必须用 randInDisk
    _right.copy(UP).cross(_dir);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.copy(_dir).cross(_right).normalize();
    const t = Math.tan(SPREAD_DEG * DEG);
    const [rx, ry] = randInDisk();
    _dir.addScaledVector(_right, rx * t).addScaledVector(_up, ry * t).normalize();

    this.onShoot(origin, _dir.clone(), this.damage);
  }

  /**
   * 兜底：契约没规定 `playerPos` 是眼睛还是脚底。
   * 若传进来的点比敌人脚底高不到 1m，就当成脚底坐标，自动抬到胸口高度，
   * 否则敌人会对着地板开枪。想精确控制就设 `aimOffsetY`。
   */
  private aimPoint(playerPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(playerPos);
    if (out.y - this.object.position.y < 1.0) out.y += 1.35;
    out.y += this.aimOffsetY;
    return out;
  }

  private updateFlash(dt: number): void {
    if (this.flashT <= 0) return;
    this.flashT = Math.max(0, this.flashT - dt);
    const k = (this.flashT / FLASH_SEC) * this.flashPeak;
    this.clothMat.emissiveIntensity = k;
    this.skinMat.emissiveIntensity = k;
  }

  private updateDeath(dt: number): void {
    if (this.deathT >= 1) return;
    this.deathT = Math.min(1, this.deathT + dt / DEATH_SEC);
    // easeOutCubic：起手快、落地慢，像被打倒而不是被吹倒
    const e = 1 - Math.pow(1 - this.deathT, 3);
    this.body.quaternion.setFromAxisAngle(this.fallAxis, e * Math.PI * 0.5);
    // 绕脚底转 90° 后模型会稍微陷进地面，往上抬一点点补偿
    this.body.position.set(0, 0.06 * e, 0);
  }

  // -------------------------------------------------------------------------
  // 重生 / 清理
  // -------------------------------------------------------------------------

  respawn(pos: THREE.Vector3): void {
    this.respawnTimer?.cancel();
    this.respawnTimer = null;

    this.spawnPos.copy(pos);
    this.object.position.copy(pos);
    this.object.visible = true;

    this.alive = true;
    this.hp = this.maxHp;

    this.deathT = 0;
    this.body.quaternion.identity();
    this.body.position.set(0, 0, 0);
    this.lurch.set(0, 0, 0);

    this.flashT = 0;
    this.flashPeak = 0;
    this.clothMat.emissiveIntensity = 0;
    this.skinMat.emissiveIntensity = 0;

    this.state = 'idle';
    this.seeT = 0;
    this.lostT = 0;
    this.staggerT = 0;
    this.fireTimer = 0;
    this.yaw = 0;
    this.object.rotation.y = 0;
  }

  /** 从场景摘除并释放本实例独有的材质（几何是模块级共享的，不能在这里 dispose） */
  dispose(): void {
    this.respawnTimer?.cancel();
    this.respawnTimer = null;
    this.scene.remove(this.object);
    for (const m of this.ownMaterials) m.dispose();
    this.hitParts.length = 0;
  }
}

/** 释放模块级共享几何。整个应用退出时才需要调；单个敌人 dispose 不碰它。 */
export function disposeEnemyGeometry(): void {
  const g = sharedGeo;
  if (!g) return;
  g.head.disposeBoundsTree();
  g.torso.disposeBoundsTree();
  g.arm.disposeBoundsTree();
  g.leg.disposeBoundsTree();
  const all: THREE.BufferGeometry[] = [g.head, g.torso, g.arm, g.leg, g.band, g.pad];
  for (const geo of all) geo.dispose();
  sharedGeo = null;
}

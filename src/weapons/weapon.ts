/**
 * Weapon —— hitscan 射击、散布、穿透、伤害结算、换弹、ADS。
 *
 * 这是打击感的**发起点**：一次扣扳机在同一帧内点燃全部反馈层
 * （枪口火光 / 曳光弹 / 后坐 / 屏幕震动 / 枪声 / 枪模动画 / 弹药 -1），
 * 命中时再点燃第二批（弹着特效 / 弹着音 / 命中提示音 / hit-stop / 慢镜）。
 * 任何一层被推迟到下一帧，读起来就散了 —— 所以下面不用任何 await/定时器
 * 来分散开火帧的工作。
 *
 * 双时钟：
 *  · update(dt) 的 dt 用 **scaledDelta** —— 射速受 hit-stop / 慢镜影响，
 *    定帧时枪应该"停住"，这符合直觉（契约 G 节明确要求）。
 *  · adsT 过渡与准星散布插值内部改用 **unscaledDelta** —— 它们是玩家意图的
 *    即时反馈和 UI 层数据，被定帧冻住会让瞄准手感发黏。
 *  · 换弹计时一律走 setUnscaledTimeout（真实墙钟），timeScale=0 时不会冻死。
 *
 * ---------------------------------------------------------------------------
 * 集成须知（main.ts）：
 *  · deps.hitMeshes 里的 geometry 需要先建好 BVH（关卡模块负责）。没建也能跑，
 *    acceleratedRaycast 会自动回退到 three 原生 raycast，只是慢。
 *  · 本模块在加载时把 THREE.Mesh.prototype.raycast 换成 acceleratedRaycast
 *    （幂等，重复安装无副作用）。
 *  · WeaponDeps 在契约基础上多了两个**可选**字段：viewmodel、getPlayerArmor。
 *    不传也能跑。
 *  · 每帧顺序建议：player.update → viewModel.update → weapon.update
 *    → postfx.setADS(weapon.adsT) → hud.setSpread(weapon.currentSpread)。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';

import { clamp01, expApproach, lerp, setUnscaledTimeout, time } from '../core/time';
import type { UnscaledTimer } from '../core/time';
import { randInDisk } from '../core/noise';
import { feelConfig, feelOn } from '../feel/config';
import { PART_MULTIPLIER, surfaceOf } from '../level/materials';
import { falloffMul, fireInterval } from './defs';
import { hitStop, killSlowMo } from '../feel/hitstop';
import { audio } from '../audio/engine';

import type { BodyPart, DamageResult, SurfaceKind, WeaponDef } from '../types';
import type { Recoil } from '../feel/recoil';
import type { TraumaShake } from '../feel/trauma';
import type { MuzzleFx } from '../vfx/muzzle';
import type { TracerFx } from '../vfx/tracer';
import type { ImpactFx } from '../vfx/impact';
import type { Enemy } from '../entities/enemy';

// 一次性安装 BVH 加速 raycast。没有 boundsTree 的网格会自动走 three 原生路径，
// 所以对敌人部位盒（不建 BVH）也是安全的。
let raycastPatched = false;
function installAcceleratedRaycast(): void {
  if (raycastPatched) return;
  raycastPatched = true;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
}

// ---------------------------------------------------------------------------
// 调参常量（弹道/流程参数，非打击感反馈强度，故不进 feelConfig）
// ---------------------------------------------------------------------------

/** 射线最大距离（米）。相机 far=200，取 150 足够覆盖 40m 的巷子 */
const MAX_RANGE = 150;
/** 穿透后射线起点沿弹道前移的距离（米），避免自相交 */
const PEN_STEP = 0.06;
/** 水平速度超过这个值算"移动射击"，用 spreadMove */
const MOVE_SPREAD_SPEED = 1.2;
/** 散布插值刚度：准星张合的跟随速度 */
const SPREAD_STIFFNESS = 14;
/** ADS 过渡刚度：1-e^(-18*0.18) ≈ 0.96，约 0.18s 完成 ease-out */
const ADS_STIFFNESS = 18;
/** 低帧率补偿：单帧最多补几发，避免掉帧时射速被吞 */
const MAX_SHOTS_PER_FRAME = 3;
/** 默认备弹 = 6 个弹匣 */
const DEFAULT_RESERVE_MAGS = 6;

/** 换弹三段音的时间点（占总时长比例）。空仓多一段拉栓。 */
const RELOAD_STAGE_EJECT = 0.1;
const RELOAD_STAGE_INSERT = 0.5;
const RELOAD_STAGE_BOLT = 0.8;
const RELOAD_STAGE_CHARGE = 0.93; // 仅空仓换弹

// ---------------------------------------------------------------------------

export interface WeaponDeps {
  camera: THREE.PerspectiveCamera;
  /** 世界几何（已建 BVH），每个 mesh.userData.surface: SurfaceKind */
  hitMeshes: THREE.Mesh[];
  enemies: Enemy[];
  muzzle: MuzzleFx;
  tracer: TracerFx;
  impact: ImpactFx;
  recoil: Recoil;
  shake: TraumaShake;
  onDamage: (r: DamageResult) => void;
  /** 枪模枪口的世界坐标，曳光弹/火光从这里出 */
  getMuzzleWorld: () => THREE.Vector3;

  // --- 以下为契约之外的可选扩展，不传也能跑 ---
  /** 第一人称枪模。传了就在开火/换弹时驱动它的动画（结构化类型，便于测试替身） */
  viewmodel?: { onFire(): void; onReload(sec: number): void };
}

/** 有甲时的伤害倍率（契约 G 节）。EnemyRef 没有 armor 字段，
 *  所以这条规则只对**玩家**生效 —— 由 Player.takeDamage 调用下面的 helper，
 *  数值放在这里是为了让「伤害公式」只有一个真源。 */
export const ARMOR_DAMAGE_MUL = 0.6;

/** armor > 0 时把伤害打成 60%。供 Player.takeDamage 使用。 */
export function armoredDamage(amount: number, armor: number): number {
  return armor > 0 ? amount * ARMOR_DAMAGE_MUL : amount;
}

export class Weapon {
  readonly def: WeaponDef;

  private readonly deps: WeaponDeps;

  private _ammo: number;
  private _reserve: number;
  private _reloading = false;
  private _adsT = 0;
  private _spread: number;

  private triggerDown = false;
  private adsDown = false;
  /** 射击冷却累加器。允许为负 —— 负值是"欠下的时间"，下一发提前补回来，
   *  这样平均射速与 rpm 严格一致（用 setTimeout 排队做不到这一点）。 */
  private cooldown = 0;
  /** 曳光弹计数器：递减到 0 就发一条，然后重置为 tracerEvery */
  private tracerCountdown = 1;

  private reloadTimers: UnscaledTimer[] = [];

  // --- 复用的射线/临时对象，运行时零分配 ---
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly targets: THREE.Object3D[] = [];
  private readonly partOwner = new Map<THREE.Object3D, Enemy>();
  private readonly normalMat = new THREE.Matrix3();

  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly camRight = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly camQuat = new THREE.Quaternion();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly endPoint = new THREE.Vector3();
  private readonly muzzlePos = new THREE.Vector3();

  /**
   * @param reserve 初始备弹。不传则给 6 个弹匣（M0 是靶场，够打一轮）。
   */
  constructor(def: WeaponDef, deps: WeaponDeps, reserve?: number) {
    installAcceleratedRaycast();
    this.def = def;
    this.deps = deps;
    this._ammo = def.magSize;
    this._reserve = reserve ?? def.magSize * DEFAULT_RESERVE_MAGS;
    this._spread = def.spreadStand;

    // BVH 的核心开关：只要最近的那个交点，命中即终止遍历。
    // 不开它，每条射线都会把整棵树遍历完，穿透循环下开销翻数倍。
    this.raycaster.firstHitOnly = true;
    this.raycaster.near = 0;
  }

  // -------------------------------------------------------------------------
  // 只读状态
  // -------------------------------------------------------------------------

  get ammo(): number {
    return this._ammo;
  }
  get reserve(): number {
    return this._reserve;
  }
  get reloading(): boolean {
    return this._reloading;
  }
  /** 0..1 机瞄过渡 */
  get adsT(): number {
    return this._adsT;
  }
  /** 弹匣容量 —— HUD 的 setAmmo(ammo, mag, reserve) 要用 */
  get magSize(): number {
    return this.def.magSize;
  }
  /**
   * 当前散布**半角（度）**。契约里没写，这里补上：
   * HUD 准星要按它张开（hud.setSpread(deg)），不然准星和真实弹道对不上，
   * 玩家学不会"停下来再打"这条核心节奏。
   */
  get currentSpread(): number {
    return this._spread;
  }

  // -------------------------------------------------------------------------
  // 输入
  // -------------------------------------------------------------------------

  setTrigger(down: boolean): void {
    this.triggerDown = down;
  }

  setADS(down: boolean): void {
    this.adsDown = down;
  }

  /** 换弹。已满 / 无备弹 / 换弹中都直接忽略。 */
  reload(): void {
    if (this._reloading) return;
    if (this._reserve <= 0) return;
    if (this._ammo >= this.def.magSize) return;

    const empty = this._ammo <= 0;
    const sec = empty ? this.def.reloadEmptySec : this.def.reloadSec;

    this._reloading = true;
    this.deps.viewmodel?.onReload(sec);

    // 分段机械音：退弹匣 → 插弹匣 → 复进（空仓再多一次拉栓）。
    // 全部走 setUnscaledTimeout：timeScale=0 的定帧期间也照常推进，
    // 否则换弹会被 hit-stop 卡死在半途。
    this.clearReloadTimers();
    this.scheduleReloadStage('eject', sec * RELOAD_STAGE_EJECT);
    this.scheduleReloadStage('insert', sec * RELOAD_STAGE_INSERT);
    this.scheduleReloadStage('bolt', sec * RELOAD_STAGE_BOLT);
    if (empty) this.scheduleReloadStage('bolt', sec * RELOAD_STAGE_CHARGE);

    this.reloadTimers.push(
      setUnscaledTimeout(() => {
        const need = this.def.magSize - this._ammo;
        const take = Math.min(need, this._reserve);
        this._ammo += take;
        this._reserve -= take;
        this._reloading = false;
        this.reloadTimers.length = 0;
      }, sec * 1000),
    );
  }

  /** 中断换弹（重生 / 切武器 / 关卡重置）。契约外的补充。 */
  cancelReload(): void {
    if (!this._reloading) return;
    this.clearReloadTimers();
    this._reloading = false;
  }

  /** 打靶场用：弹药回满 */
  refill(): void {
    this.cancelReload();
    this._ammo = this.def.magSize;
    this._reserve = this.def.magSize * DEFAULT_RESERVE_MAGS;
  }

  private scheduleReloadStage(stage: 'eject' | 'insert' | 'bolt', sec: number): void {
    this.reloadTimers.push(
      setUnscaledTimeout(() => {
        if (this.audioOn) audio.reloadClick(stage);
      }, sec * 1000),
    );
  }

  private clearReloadTimers(): void {
    for (const t of this.reloadTimers) t.cancel();
    this.reloadTimers.length = 0;
  }

  private get audioOn(): boolean {
    return feelOn(feelConfig.audio.enabled);
  }

  // -------------------------------------------------------------------------
  // 每帧
  // -------------------------------------------------------------------------

  /**
   * @param dt 用 **time.scaledDelta**（射速受慢镜影响）
   * @param playerSpeed 玩家水平速度 m/s（Player.speed）
   * @param onGround 是否着地（Player.onGround）
   */
  update(dt: number, playerSpeed: number, onGround: boolean): void {
    // ADS 与散布是"意图/UI"层，用 unscaled，定帧时不发黏
    const du = time.unscaledDelta;
    this.updateADS(du);
    this.updateSpread(du, playerSpeed, onGround);

    const interval = fireInterval(this.def);
    // 冷却累加器：负值 = 上一帧"欠下"的时间，下一发提前补回来，平均射速严格等于 rpm。
    // 下界钳在 -interval，避免长时间不开火攒出一堆欠账导致连喷。
    this.cooldown -= dt;
    if (this.cooldown < -interval) this.cooldown = -interval;

    if (!this.triggerDown || this._reloading) {
      // 松开扳机 / 换弹中：清掉负欠账，下一次扣扳机第一发立刻出膛且只出一发
      if (this.cooldown < 0) this.cooldown = 0;
      return;
    }

    if (this._ammo <= 0) {
      // 空仓扣扳机自动换弹 —— 靶场里手动按 R 太打断节奏
      this.reload();
      return;
    }

    let shots = 0;
    while (this.cooldown <= 0 && this._ammo > 0 && shots < MAX_SHOTS_PER_FRAME) {
      this.fireOnce();
      this.cooldown += interval;
      shots++;
    }
  }

  /** ease-out 逼近目标；dt 用 unscaledDelta */
  private updateADS(dt: number): void {
    const target = this.adsDown ? 1 : 0;
    this._adsT = clamp01(lerp(this._adsT, target, expApproach(ADS_STIFFNESS, dt)));
  }

  /**
   * 散布半角（度）。姿态优先级：离地 > 移动 > 站定，然后按 adsT 插值到 ADS 值。
   * 用插值而不是硬切，是为了让"抬枪的过程"本身就在收拢准星 —— 玩家能看见
   * 自己的精度在变好，这条反馈比数值本身更重要。
   */
  private updateSpread(dt: number, playerSpeed: number, onGround: boolean): void {
    const d = this.def;
    const stance = !onGround
      ? d.spreadAir
      : playerSpeed > MOVE_SPREAD_SPEED
        ? d.spreadMove
        : d.spreadStand;
    const target = lerp(stance, d.spreadADS, clamp01(this._adsT));
    this._spread = lerp(this._spread, target, expApproach(SPREAD_STIFFNESS, dt));
  }

  // -------------------------------------------------------------------------
  // 开火
  // -------------------------------------------------------------------------

  private fireOnce(): void {
    const def = this.def;
    const cam = this.deps.camera;

    this._ammo--;

    cam.updateWorldMatrix(true, false);
    cam.getWorldPosition(this.camPos);
    cam.getWorldQuaternion(this.camQuat);
    this.camFwd.set(0, 0, -1).applyQuaternion(this.camQuat);
    this.camRight.set(1, 0, 0).applyQuaternion(this.camQuat);
    this.camUp.set(0, 1, 0).applyQuaternion(this.camQuat);

    this.muzzlePos.copy(this.deps.getMuzzleWorld());

    // ——— 同一帧内点燃全部"开火"反馈层 ———
    this.deps.muzzle.fire(this.muzzlePos, this.camFwd);
    this.deps.recoil.kick(def);
    this.deps.shake.add(def.trauma);
    if (this.audioOn) audio.gunshot(def.audio);
    this.deps.viewmodel?.onFire();

    // 目标集合：世界几何 + 存活敌人的部位盒。每发重建（几十个元素，零分配复用数组）
    this.rebuildTargets();

    const tracerDue = --this.tracerCountdown <= 0;
    if (tracerDue) this.tracerCountdown = Math.max(1, def.tracerEvery);

    for (let p = 0; p < def.pellets; p++) {
      this.spreadDirection(this.rayDir);
      this.traceBullet(this.rayDir);
      // 多弹丸时只给第一颗画曳光弹，否则霰弹会变成一把光扇
      if (tracerDue && p === 0) {
        this.deps.tracer.spawn(this.muzzlePos, this.endPoint);
      }
    }
  }

  /**
   * 锥内均匀采样。用 randInDisk() 取圆盘上的均匀点再投影到单位距离的平面上，
   * 而不是两个独立均匀数 —— 后者会让弹着点堆在锥心，实测手感是"莫名其妙准"。
   */
  private spreadDirection(out: THREE.Vector3): THREE.Vector3 {
    const t = Math.tan(THREE.MathUtils.degToRad(this._spread));
    const [dx, dy] = randInDisk();
    return out
      .copy(this.camFwd)
      .addScaledVector(this.camRight, dx * t)
      .addScaledVector(this.camUp, dy * t)
      .normalize();
  }

  private rebuildTargets(): void {
    this.targets.length = 0;
    this.partOwner.clear();

    const meshes = this.deps.hitMeshes;
    for (let i = 0; i < meshes.length; i++) this.targets.push(meshes[i]);

    const enemies = this.deps.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue; // 尸体不挡子弹（M0 是靶场，3 秒就重生）
      const parts = e.hitParts;
      for (let j = 0; j < parts.length; j++) {
        this.targets.push(parts[j]);
        this.partOwner.set(parts[j], e);
      }
    }
  }

  /**
   * 单颗弹丸的完整弹道：命中 → 结算 → 若表面可穿透则继续，最多 maxPenetrations 层。
   * 结束时 this.endPoint 是弹道终点（曳光弹画到这里）。
   */
  private traceBullet(dir: THREE.Vector3): void {
    const def = this.def;
    this.rayOrigin.copy(this.camPos);
    this.endPoint.copy(this.camPos).addScaledVector(dir, MAX_RANGE);

    let remaining = MAX_RANGE;
    let travelled = 0;
    let damageMul = 1;
    let penetrated = 0;

    for (;;) {
      this.raycaster.set(this.rayOrigin, dir);
      this.raycaster.far = remaining;
      this.hits.length = 0;
      this.raycaster.intersectObjects(this.targets, false, this.hits);

      const hit = this.hits[0];
      if (!hit) {
        this.endPoint.copy(this.rayOrigin).addScaledVector(dir, remaining);
        return;
      }

      this.hitPoint.copy(hit.point);
      this.endPoint.copy(this.hitPoint);
      this.resolveNormal(hit, dir, this.hitNormal);

      const owner = this.partOwner.get(hit.object) ?? null;
      const kind: SurfaceKind = owner
        ? 'flesh'
        : ((hit.object.userData.surface as SurfaceKind | undefined) ?? 'concrete');
      const surf = surfaceOf(kind);
      const distance = travelled + hit.distance;

      // ——— 每一层都要出弹着反馈，穿透才读得出来 ———
      // 第 4 个参数是命中网格：DecalGeometry 必须有投影目标，不传就没有弹孔
      // （不会报错，只是安静地缺失 —— 见 docs/M0-模块契约.md B 节第 1 条）。
      // 第 5 个参数是弹道方向，决定血雾往哪喷。
      this.deps.impact.play(
        this.hitPoint,
        this.hitNormal,
        kind,
        hit.object as THREE.Mesh,
        dir,
      );
      if (this.audioOn) audio.impact(kind, distance);

      if (owner) {
        this.applyEnemyHit(owner, hit.object, dir, distance, damageMul);
      }

      penetrated++;
      if (surf.penetration <= 0 || penetrated > def.maxPenetrations) return;

      damageMul *= surf.penetration;
      const step = hit.distance + PEN_STEP;
      remaining -= step;
      if (remaining <= 0) return;
      travelled += step;
      this.rayOrigin.copy(this.hitPoint).addScaledVector(dir, PEN_STEP);
    }
  }

  /**
   * three 与 three-mesh-bvh 给出的 normal / face.normal 都是**物体局部空间**的，
   * 直接拿去摆贴花会在旋转过的墙上歪掉。这里统一转到世界空间并保证背向弹道。
   */
  private resolveNormal(
    hit: THREE.Intersection,
    dir: THREE.Vector3,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const local = hit.normal ?? hit.face?.normal;
    if (!local) return out.copy(dir).negate();
    this.normalMat.getNormalMatrix(hit.object.matrixWorld);
    out.copy(local).applyNormalMatrix(this.normalMat).normalize();
    if (out.dot(dir) > 0) out.negate();
    return out;
  }

  private applyEnemyHit(
    enemy: Enemy,
    partMesh: THREE.Object3D,
    dir: THREE.Vector3,
    distance: number,
    damageMul: number,
  ): void {
    if (!enemy.alive) return;

    const def = this.def;
    const part = (partMesh.userData.part as BodyPart | undefined) ?? 'torso';
    const headshot = part === 'head';

    // 伤害 = 基础 × 部位倍率 × 距离衰减 × 累积穿透衰减
    const raw = def.damage * PART_MULTIPLIER[part] * falloffMul(def, distance) * damageMul;
    const amount = Math.max(1, Math.round(raw));

    const wasAlive = enemy.alive;
    // fromDir 传弹道方向（由射手指向目标），敌人用它决定被击退/倒地的方向
    enemy.applyDamage(amount, part, dir);
    const killed = wasAlive && !enemy.alive;

    if (this.audioOn) audio.hitTick(headshot);

    // 定帧帧数：头/躯干/击杀用武器自带值（每把枪的手感不同），
    // 四肢 WeaponDef 里没有，退回 feelConfig.hitstop.framesLimb。
    const stopFrames =
      part === 'head'
        ? def.hitstopHead
        : part === 'torso'
          ? def.hitstopNormal
          : feelConfig.hitstop.framesLimb;
    hitStop(stopFrames);

    if (killed) {
      hitStop(def.hitstopKill);
      killSlowMo();
      if (this.audioOn) audio.killTone();
    }

    const result: DamageResult = {
      amount,
      part,
      killed,
      headshot,
      // clone：临时向量下一发就会被复写，伤害数字要持有它到生命周期结束
      worldPos: this.hitPoint.clone(),
    };
    this.deps.onDamage(result);
  }
}

/**
 * 玩家 —— Octree + Capsule 方案（参照 three.js examples/games_fps.html）。
 *
 * 设计要点：
 * 1. 胶囊碰撞：站立 1.8m / 蹲下 1.2m，半径 0.35m。每帧分 4 个子步推进，
 *    每步用 `Octree.capsuleIntersect` 求交后沿法线推出 —— 子步是防穿墙的关键，
 *    高速冲刺 + 低帧率时单步位移会超过墙厚。
 * 2. 速度控制用「目标速度 + expApproach 逼近」而不是 games_fps 的阻尼累加，
 *    好处是最高速度精确等于设定值（走 3.2 / 冲刺 5.6 / 蹲 1.6），调参直观。
 * 3. 探头 lean 是巷战的灵魂：横移 ±0.35m + roll ∓12°，并做侧向射线检测，
 *    贴墙时自动收窄偏移，避免把相机探进墙里看见背面。
 *
 * 双时钟纪律：
 * - `update(dt)`            → **scaledDelta**（角色移动是玩法逻辑，hit-stop 该冻住）
 * - `applyCameraOffsets(dt)`→ **unscaledDelta**（震动/后坐/落地下沉是表现层，定帧期间必须继续走）
 *
 * 输入分工：键盘（WASD / Space / Shift / Ctrl / Q / E）由本类自己监听；
 * 鼠标由外部通过 `look(dx, dy)` 喂进来，ADS 由武器层调 `setADS()`。
 * 契约里没有输入模块，所以键盘归玩家自己管；`dispose()` 会摘掉监听。
 */

import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import type { Octree } from 'three/examples/jsm/math/Octree.js';
import { clamp, clamp01, expApproach, lerp } from '../core/time';

/**
 * 与 `feel/trauma.ts` 的 `ShakeOffset` 结构一致（三个角度，单位 **度**）。
 * 这里做结构化声明而不是 import，是为了让本模块不对并行开发中的 feel 层产生编译期依赖；
 * TypeScript 是结构类型，真正的 `ShakeOffset` 可以直接传进来。
 */
export interface ShakeOffsetLike {
  pitch: number;
  yaw: number;
  roll: number;
}

// ---------------------------------------------------------------------------
// 调参常量（都是移动手感，不属于 feelConfig 的打击感范畴，故留在本文件）
// ---------------------------------------------------------------------------

const RADIUS = 0.35;
const HEIGHT_STAND = 1.8;
const HEIGHT_CROUCH = 1.2;
/** 眼睛比头顶低多少（米）。站立视高 1.64，蹲下 1.04 */
const EYE_DROP = 0.16;

const SPEED_WALK = 3.2;
const SPEED_SPRINT = 5.6;
const SPEED_CROUCH = 1.6;
const SPEED_ADS = 2.0;

/** 地面加速刚度（1/s）。14 ≈ 0.16s 达到 90% 目标速度 */
const ACCEL_GROUND = 14;
/** 空中控制力：明显减弱，但不为 0，保留一点微调余地 */
const ACCEL_AIR = 2.6;

const GRAVITY = 24;
/** 起跳初速 → 跳高约 1.02m */
const JUMP_SPEED = 7.0;
/** 土狼时间：离开地面后仍可起跳的宽限 */
const COYOTE = 0.12;
/** 跳跃缓冲：落地前按下的跳跃在落地瞬间生效 */
const JUMP_BUFFER = 0.12;

/** 蹲/站高度过渡刚度 */
const HEIGHT_STIFF = 13;

const LEAN_OFFSET = 0.35; // 米
const LEAN_ROLL_DEG = 12; // 度
const LEAN_STIFF = 12;
/** 贴墙时可用余量的平滑刚度（避免射线抖动导致相机抽搐） */
const LEAN_CLEAR_STIFF = 18;

/** 冲刺结束后举枪耗时（秒）—— 契约要求 0.18s */
const RAISE_UP_SEC = 0.18;
/** 起跑时放下枪耗时（秒），比举起快，避免起步就卡住射击手感 */
const RAISE_DOWN_SEC = 0.1;

/** 落地下沉最大幅度（米）与恢复刚度 */
const LAND_DIP_MAX = 0.12;
const LAND_DIP_STIFF = 9;

const MAX_HP = 100;
const MAX_ARMOR = 50;

/** 碰撞子步数 */
const SUBSTEPS = 4;

const DEG = Math.PI / 180;
const PITCH_LIMIT = 89 * DEG;

// 复用的临时对象，避免每帧 new
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _ray = new THREE.Ray();
const _rayDir = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _probe = new THREE.Vector3();

interface KeyState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  leanL: boolean;
  leanR: boolean;
}

export class Player {
  // ---- 契约字段 ---------------------------------------------------------
  /** 胶囊底部（脚底）世界坐标。**这是权威值**：外部直接写它等于瞬移，update 会同步给胶囊 */
  position = new THREE.Vector3(0, 0.5, 0);
  hp = MAX_HP;
  armor = MAX_ARMOR;
  readonly velocity = new THREE.Vector3();

  // ---- 附加公开字段（契约外，集成时可用） -------------------------------
  /** 掉出世界或调 respawn() 无参时回到这里 */
  readonly spawnPoint = new THREE.Vector3(0, 0.5, 0);
  /**
   * 受击回调。`dmg` 是**实际扣血量**（已算过护甲减免），
   * `angleRad` 是伤害来源相对视线的屏幕方位角（0=正前，+ 为右侧），可直接喂给 `Hud.hurt()`。
   */
  onHurt?: (dmg: number, fromDir: THREE.Vector3, angleRad: number, dead: boolean) => void;
  /** 脚步回调。表面材质由外部决定（玩家不认识关卡），这里只报「迈了一步」 */
  onFootstep?: () => void;
  /** 跳跃 / 落地回调，供音频与镜头层用 */
  onJump?: () => void;
  onLand?: (impactSpeed: number) => void;

  // ---- 内部状态 ---------------------------------------------------------
  private readonly camera: THREE.PerspectiveCamera;
  private readonly collider: Octree;

  private readonly capsule = new Capsule(
    new THREE.Vector3(0, RADIUS, 0),
    new THREE.Vector3(0, HEIGHT_STAND - RADIUS, 0),
    RADIUS,
  );

  private yaw = 0;
  private pitch = 0;

  private height = HEIGHT_STAND;
  private crouching = false;
  private _onGround = false;
  private _isADS = false;
  private sprinting = false;

  private coyoteT = 0;
  private jumpBufferT = 0;
  private jumpLatch = false; // 防止按住空格连跳

  /** 平滑后的 lean（-1 左 / +1 右） */
  private leanCur = 0;
  /** 侧向可用余量 0..1（1 = 无遮挡） */
  private leanClear = 1;

  private _raiseT = 1;
  private landDip = 0;
  private stepDist = 0;

  private readonly keys: KeyState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    crouch: false,
    leanL: false,
    leanR: false,
  };

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onBlur: () => void;

  constructor(camera: THREE.PerspectiveCamera, collider: Octree) {
    this.camera = camera;
    this.collider = collider;
    // YXZ：先 yaw 再 pitch 最后 roll —— FPS 相机唯一正确的顺序，
    // 用默认 XYZ 会在抬头时把 yaw 拧成斜的。
    this.camera.rotation.order = 'YXZ';

    this.syncCapsuleFromPosition();

    this.onKeyDown = (e) => this.handleKey(e, true);
    this.onKeyUp = (e) => this.handleKey(e, false);
    this.onBlur = () => this.clearKeys();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  // -------------------------------------------------------------------------
  // 只读查询
  // -------------------------------------------------------------------------

  get onGround(): boolean {
    return this._onGround;
  }

  get isADS(): boolean {
    return this._isADS;
  }

  /** 当前水平速度（m/s），供枪模 bob 用 */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * 举枪进度 0..1。冲刺时降到 0（枪放下），停止冲刺后 0.18s 内升回 1。
   * 武器层应在 `raiseT < 1` 时禁止开火 —— 契约里没写这个字段，属于本模块的补充导出。
   */
  get raiseT(): number {
    return this._raiseT;
  }

  /** `raiseT >= 1` 的语法糖，武器层直接查这个即可 */
  get canFire(): boolean {
    return this._raiseT >= 1;
  }

  /** 平滑后的探头量 -1..1，枪模也可以跟着歪一点 */
  get lean(): number {
    return this.leanCur;
  }

  get isCrouching(): boolean {
    return this.crouching;
  }

  get isSprinting(): boolean {
    return this.sprinting;
  }

  /** 当前胶囊高度（蹲/站过渡中是中间值） */
  get capsuleHeight(): number {
    return this.height;
  }

  /** 眼睛（相机）离脚底的高度 */
  get eyeHeight(): number {
    return this.height - EYE_DROP;
  }

  /** 水平朝向角（弧度），敌人 AI / HUD 可能要用 */
  get facing(): number {
    return this.yaw;
  }

  // -------------------------------------------------------------------------
  // 外部输入
  // -------------------------------------------------------------------------

  /** 鼠标增量（弧度）。dx 右为正、dy 下为正，内部取负得到常规 FPS 手感 */
  look(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch -= dy;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    // yaw 折回 ±π，长时间转圈不会让浮点精度退化
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** 由武器层调用（右键机瞄）。ADS 会限速并禁止冲刺 */
  setADS(down: boolean): void {
    this._isADS = down;
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  /** dt 用 **scaledDelta** —— 移动是玩法逻辑，hit-stop / 慢镜期间应当一起被冻住 */
  update(dt: number): void {
    if (dt <= 0) return;

    this.updateStance(dt);
    this.updateRaise(dt);
    this.updateLean(dt);

    // 外部可能直接改了 position（瞬移 / 调试），先让胶囊跟上
    this.syncCapsuleFromPosition();

    const step = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.integrate(step);
      this.collide();
    }

    this.syncPositionFromCapsule();

    // 掉出世界兜底
    if (this.position.y < -25) this.respawn(this.spawnPoint);

    this.updateFootsteps(dt);

    // 即使外部没调 applyCameraOffsets，相机也要跟上身体
    this.writeCamera(0, 0, 0, 0, 0);
  }

  /**
   * 把 shake 与 recoil **叠加**到瞄准旋转之上 —— 注意是叠加不是替换：
   * 相机最终 = 玩家 yaw/pitch + 后坐 + 震动，任何一层单独抖动都不会丢失瞄准方向。
   * dt 用 **unscaledDelta**（落地下沉属于表现层，定帧期间要继续恢复）。
   *
   * 单位：shakeOffset 与 recoil **都已经是弧度**。
   * （feelConfig.shake.maxPitch/maxYaw/maxRoll 写的是度，但 TraumaShake.update()
   *  内部已经乘过 π/180 —— 这里再转一次会把震动缩小 57 倍，等于没有震动。）
   */
  applyCameraOffsets(
    shakeOffset: ShakeOffsetLike,
    recoilPitch: number,
    recoilYaw: number,
    dt: number,
  ): void {
    this.landDip = lerp(this.landDip, 0, expApproach(LAND_DIP_STIFF, dt));
    this.writeCamera(
      shakeOffset.pitch,
      shakeOffset.yaw,
      shakeOffset.roll,
      recoilPitch,
      recoilYaw,
    );
  }

  // -------------------------------------------------------------------------
  // 伤害 / 重生
  // -------------------------------------------------------------------------

  /**
   * `fromDir` 约定为**子弹飞行方向**（射手 → 玩家）的单位向量。
   * 护甲规则：有甲时 hp 只吃 60% 伤害，护甲按原伤害的 50% 掉。
   */
  takeDamage(amount: number, fromDir: THREE.Vector3): void {
    if (amount <= 0 || this.hp <= 0) return;

    let toHp = amount;
    if (this.armor > 0) {
      toHp = amount * 0.6;
      this.armor = Math.max(0, this.armor - amount * 0.5);
    }
    this.hp = Math.max(0, this.hp - toHp);

    // 伤害来源方位角：0 = 正前方，+ = 右侧。源方向 = -飞行方向
    const sx = -fromDir.x;
    const sz = -fromDir.z;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const angle = Math.atan2(sx * rx + sz * rz, sx * fx + sz * fz);

    this.onHurt?.(toHp, fromDir, angle, this.hp <= 0);
  }

  respawn(at: THREE.Vector3): void {
    this.spawnPoint.copy(at);
    this.position.copy(at);
    this.velocity.set(0, 0, 0);
    this.hp = MAX_HP;
    this.armor = MAX_ARMOR;
    this.height = HEIGHT_STAND;
    this.crouching = false;
    this.sprinting = false;
    this.leanCur = 0;
    this.leanClear = 1;
    this._raiseT = 1;
    this.landDip = 0;
    this.stepDist = 0;
    this.coyoteT = 0;
    this.jumpBufferT = 0;
    this._onGround = false;
    this.syncCapsuleFromPosition();
    this.writeCamera(0, 0, 0, 0, 0);
  }

  /** 摘掉键盘监听。切场景 / 热重载时调用 */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  // -------------------------------------------------------------------------
  // 内部：姿态（蹲/站）
  // -------------------------------------------------------------------------

  private updateStance(dt: number): void {
    const wantCrouch = this.keys.crouch;
    let target = wantCrouch ? HEIGHT_CROUCH : HEIGHT_STAND;

    // 想站起来但头顶有东西 → 保持当前高度（不要硬顶进天花板）
    if (!wantCrouch && this.height < HEIGHT_STAND - 1e-3 && !this.hasHeadroom(HEIGHT_STAND)) {
      target = this.height;
    }
    this.crouching = target < HEIGHT_STAND - 1e-3;

    this.height = lerp(this.height, target, expApproach(HEIGHT_STIFF, dt));
    if (Math.abs(this.height - target) < 1e-3) this.height = target;
  }

  /** 从脚底往上打一条射线，看有没有站起来的空间 */
  private hasHeadroom(wanted: number): boolean {
    _rayOrigin.copy(this.position);
    _rayOrigin.y += 0.15;
    _rayDir.set(0, 1, 0);
    _ray.set(_rayOrigin, _rayDir);
    const hit = this.collider.rayIntersect(_ray);
    if (!hit) return true;
    return hit.distance > wanted - 0.15 + 0.03;
  }

  // -------------------------------------------------------------------------
  // 内部：举枪延迟
  // -------------------------------------------------------------------------

  private updateRaise(dt: number): void {
    if (this.sprinting) {
      this._raiseT = clamp01(this._raiseT - dt / RAISE_DOWN_SEC);
    } else {
      this._raiseT = clamp01(this._raiseT + dt / RAISE_UP_SEC);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：探头 lean
  // -------------------------------------------------------------------------

  private updateLean(dt: number): void {
    // 冲刺时不能探头（动作上说不通，也会让镜头太乱）
    let target = 0;
    if (!this.sprinting) {
      if (this.keys.leanL) target -= 1;
      if (this.keys.leanR) target += 1;
    }

    this.leanCur = lerp(this.leanCur, target, expApproach(LEAN_STIFF, dt));
    if (Math.abs(this.leanCur) < 1e-4) this.leanCur = 0;

    // 侧向墙壁检测：以当前实际探头方向打一条水平射线，
    // 墙近了就按剩余空间收窄偏移量，避免相机穿墙看见背面。
    const side = this.leanCur !== 0 ? Math.sign(this.leanCur) : Math.sign(target);
    let clear = 1;
    if (side !== 0) {
      this.horizontalBasis();
      _rayDir.set(_right.x * side, 0, _right.z * side).normalize();
      _rayOrigin.copy(this.position);
      _rayOrigin.y += this.eyeHeight;
      _ray.set(_rayOrigin, _rayDir);
      const hit = this.collider.rayIntersect(_ray);
      if (hit) {
        const usable = hit.distance - RADIUS - 0.05;
        clear = clamp01(usable / LEAN_OFFSET);
      }
    }
    this.leanClear = lerp(this.leanClear, clear, expApproach(LEAN_CLEAR_STIFF, dt));
  }

  // -------------------------------------------------------------------------
  // 内部：移动积分与碰撞
  // -------------------------------------------------------------------------

  private integrate(dt: number): void {
    this.horizontalBasis();

    // 输入 → 期望方向
    _wish.set(0, 0, 0);
    if (this.keys.forward) _wish.add(_fwd);
    if (this.keys.back) _wish.sub(_fwd);
    if (this.keys.right) _wish.add(_right);
    if (this.keys.left) _wish.sub(_right);
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) _wish.normalize();

    // 冲刺条件：按住 Shift + 有前进意图 + 在地面 + 没蹲 + 没机瞄
    this.sprinting =
      this.keys.sprint &&
      this.keys.forward &&
      !this.keys.back &&
      this._onGround &&
      !this.crouching &&
      !this._isADS &&
      moving;

    let maxSpeed: number;
    if (this.crouching) maxSpeed = SPEED_CROUCH;
    else if (this.sprinting) maxSpeed = SPEED_SPRINT;
    else if (this._isADS) maxSpeed = SPEED_ADS;
    else maxSpeed = SPEED_WALK;

    const stiff = this._onGround ? ACCEL_GROUND : ACCEL_AIR;
    const a = expApproach(stiff, dt);
    const targetX = _wish.x * maxSpeed;
    const targetZ = _wish.z * maxSpeed;
    this.velocity.x = lerp(this.velocity.x, targetX, a);
    this.velocity.z = lerp(this.velocity.z, targetZ, a);

    // 重力 + 跳跃
    this.coyoteT = this._onGround ? COYOTE : Math.max(0, this.coyoteT - dt);
    this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);
    if (this.keys.jump && !this.jumpLatch) {
      this.jumpLatch = true;
      this.jumpBufferT = JUMP_BUFFER;
    }
    if (!this.keys.jump) this.jumpLatch = false;

    if (this.jumpBufferT > 0 && this.coyoteT > 0) {
      this.velocity.y = JUMP_SPEED;
      this.jumpBufferT = 0;
      this.coyoteT = 0;
      this._onGround = false;
      this.onJump?.();
    }

    if (!this._onGround) {
      this.velocity.y -= GRAVITY * dt;
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }

    this.capsule.translate(_probe.copy(this.velocity).multiplyScalar(dt));
    // 胶囊高度可能刚变过，end 要跟着走
    this.capsule.end.y = this.capsule.start.y + this.height - RADIUS * 2;
  }

  private collide(): void {
    const wasGround = this._onGround;
    const fallSpeed = -this.velocity.y;

    const result = this.collider.capsuleIntersect(this.capsule);
    this._onGround = false;

    if (result) {
      // normal.y > 0 表示被地面往上顶 → 站在地上
      this._onGround = result.normal.y > 0;
      if (!this._onGround) {
        // 撞墙/天花板：把速度里朝向墙的分量削掉，贴墙滑行而不是被弹回来
        this.velocity.addScaledVector(result.normal, -result.normal.dot(this.velocity));
      }
      if (result.depth >= 1e-10) {
        this.capsule.translate(result.normal.multiplyScalar(result.depth));
      }
    }

    if (!wasGround && this._onGround && fallSpeed > 1.5) {
      // 落地下沉：越重摔越明显。用 unscaled 恢复（见 applyCameraOffsets）
      this.landDip = Math.min(LAND_DIP_MAX, (fallSpeed / 12) * LAND_DIP_MAX);
      this.onLand?.(fallSpeed);
    }
  }

  private updateFootsteps(dt: number): void {
    if (!this._onGround) {
      this.stepDist = 0;
      return;
    }
    const sp = this.speed;
    if (sp < 0.4) {
      this.stepDist = 0;
      return;
    }
    this.stepDist += sp * dt;
    const stride = this.crouching ? 1.05 : this.sprinting ? 1.9 : 1.45;
    if (this.stepDist >= stride) {
      this.stepDist -= stride;
      this.onFootstep?.();
    }
  }

  // -------------------------------------------------------------------------
  // 内部：相机写入
  // -------------------------------------------------------------------------

  /** shake 参数单位是弧度（调用方已从度转过） */
  private writeCamera(
    shakePitch: number,
    shakeYaw: number,
    shakeRoll: number,
    recoilPitch: number,
    recoilYaw: number,
  ): void {
    this.horizontalBasis();

    const off = this.leanCur * LEAN_OFFSET * this.leanClear;
    this.camera.position.set(
      this.position.x + _right.x * off,
      this.position.y + this.eyeHeight - this.landDip,
      this.position.z + _right.z * off,
    );

    // roll 取负号：向右探头（lean > 0）时画面应逆时针转，头才是「往右歪」的。
    // 如果实机看着方向反了，只改这里的符号即可。
    const leanRoll = -this.leanCur * LEAN_ROLL_DEG * DEG * (0.5 + 0.5 * this.leanClear);

    this.camera.rotation.set(
      this.pitch + recoilPitch + shakePitch,
      this.yaw + recoilYaw + shakeYaw,
      leanRoll + shakeRoll,
      'YXZ',
    );
  }

  // -------------------------------------------------------------------------
  // 内部：工具
  // -------------------------------------------------------------------------

  /** 水平前向 / 右向。俯仰不参与移动，抬头看天时前进方向仍在水平面上 */
  private horizontalBasis(): void {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    _fwd.set(-s, 0, -c);
    _right.set(c, 0, -s);
  }

  private syncCapsuleFromPosition(): void {
    this.capsule.start.set(this.position.x, this.position.y + RADIUS, this.position.z);
    this.capsule.end.set(this.position.x, this.position.y + this.height - RADIUS, this.position.z);
    this.capsule.radius = RADIUS;
  }

  private syncPositionFromCapsule(): void {
    this.position.set(
      this.capsule.start.x,
      this.capsule.start.y - RADIUS,
      this.capsule.start.z,
    );
  }

  private handleKey(e: KeyboardEvent, down: boolean): void {
    // lil-gui 的输入框在聚焦时不能被我们抢键
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    }

    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.back = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = down;
        break;
      case 'Space':
        this.keys.jump = down;
        e.preventDefault(); // 否则会滚页面
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.sprint = down;
        break;
      case 'ControlLeft':
      case 'KeyC':
        this.keys.crouch = down;
        break;
      case 'KeyQ':
        this.keys.leanL = down;
        break;
      case 'KeyE':
        this.keys.leanR = down;
        break;
      default:
        break;
    }
  }

  private clearKeys(): void {
    this.keys.forward = false;
    this.keys.back = false;
    this.keys.left = false;
    this.keys.right = false;
    this.keys.jump = false;
    this.keys.sprint = false;
    this.keys.crouch = false;
    this.keys.leanL = false;
    this.keys.leanR = false;
    this.jumpLatch = false;
  }
}

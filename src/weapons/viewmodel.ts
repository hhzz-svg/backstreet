/**
 * 第一人称枪模（ViewModel）—— 全程序化几何，零外部模型 / 零外部贴图。
 *
 * 设计原则（Mark Brown《枪的手感》/ COD 视觉语法）：
 * 枪模本身不产生伤害，它产生**重量感**。三条曲线合成这份重量：
 *   1. sway  —— 转视角时枪跟不上，反向滞后再弹回（惯性）
 *   2. bob   —— 走路时的正弦摆动，幅度随速度缩放（体感）
 *   3. recoil—— 开火瞬间的后缩 + 上抬弹簧脉冲（冲击）
 * 三者互不相关，因此叠加起来读上去像"手在拿枪"而不是"贴图在飘"。
 *
 * 双时钟：本文件所有 update 一律用 **unscaledDelta**（枪模是表现层，
 * hit-stop 期间必须继续走，否则定帧读起来是"卡了"而不是"打中了"）。
 *
 * ---------------------------------------------------------------------------
 * 集成须知（main.ts）：
 *  · ViewModel 把自己挂在 camera 下（camera.add(root)），所以 **camera 必须被
 *    加进 scene**（scene.add(camera)），否则枪模不会被渲染。
 *  · 抛壳需要世界空间父节点，构造时相机可能还没进场景，因此**首次抛壳时**
 *    才沿 camera.parent 链找根节点（通常就是 scene）。只要开火前
 *    scene.add(camera) 已经执行过就没问题。
 *  · 抛壳落地高度用 `viewModel.floorY`（默认 0）。巷子地面不在 y=0 时改它。
 *  · muzzleWorld 每帧在 update() 末尾刷新，所以调用顺序必须是
 *    player.update → viewModel.update → weapon.update，
 *    否则 weapon 拿到的是上一帧的枪口位置（快速转身时曳光弹会歪）。
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import { clamp, clamp01, expApproach, lerp } from '../core/time';
import { randSigned } from '../core/noise';
import { feelConfig, feelOn } from '../feel/config';

// ---------------------------------------------------------------------------
// 调参常量
//
// 说明：这些是**枪模姿态**参数（几何/位置/弹簧刚度），不是打击感反馈强度，
// 所以按契约不放进 feelConfig（feelConfig 管的是"能不能单独关掉的反馈层"）。
// 真正的反馈量（trauma / recoil / hitstop）全部由外部传进来。
// ---------------------------------------------------------------------------

/** 腰射姿态：屏幕右下，略微内倾 */
const HIP_POS = new THREE.Vector3(0.19, -0.19, -0.3);
const HIP_ROT = new THREE.Euler(0.03, -0.085, 0.045);

/** 铁瞄准线高度（准星柱/照门缺口）—— 现在只用来摆铁瞄几何本身。 */
const SIGHT_LINE_Y = 0.1;

/**
 * 红点镜的光轴高度（枪模局部空间）。镜子架在导轨上，比铁瞄高一截，
 * 这是真实 AR 装镜后的「镜高」。
 *
 * ADS 时把枪整体**下移这么多**，光轴就正好过相机原点
 * （= 屏幕中心 = 弹道方向），红点自然落在准星位置上。
 * ⚠ 改镜子的 Y 位置就必须同步改这里，否则红点会和实际弹着偏开。
 */
const DOT_AXIS_Y = 0.126;

/**
 * 红点开始淡入的 ADS 进度。低于这个值完全不亮 —— 腰射时镜片里看不到红点，
 * 也不该拿它瞄。取 0.45 让红点在举枪过半、快贴腮时才亮起来。
 */
const DOT_FADE_START = 0.45;

const ADS_POS = new THREE.Vector3(0, -DOT_AXIS_Y, -0.3);
const ADS_ROT = new THREE.Euler(0, 0, 0);

/** sway：鼠标增量 → 反向位移/旋转的增益，以及各自的上限 */
const SWAY_POS_GAIN = 0.85; // 米 / 弧度
const SWAY_ROT_GAIN = 1.5; // 弧度 / 弧度
const SWAY_POS_MAX = 0.038; // 米
const SWAY_ROT_MAX = 0.1; // 弧度
const SWAY_RETURN = 9.0; // 弹回刚度
const SWAY_ADS_MUL = 0.3; // ADS 时压缩到 30%

/** bob：相位推进速度与幅度。BOB_REF_SPEED 是"正常跑速"参考值 */
const BOB_REF_SPEED = 5.0; // m/s
const BOB_RATE = 9.2; // rad/s（在参考速度下）
const BOB_AMP_X = 0.016;
const BOB_AMP_Y = 0.013;
const BOB_AMP_ROLL = 0.014;
const BOB_BLEND = 12.0; // bob 目标值的跟随刚度（起步/停步不突变）

/** 开火弹簧脉冲（在外部 Recoil 之上再加一层，让枪模比准星更"脆"） */
const KICK_IMPULSE_Z = 1.35; // m/s，向后（+Z）
const KICK_IMPULSE_PITCH = 3.6; // rad/s，枪口上抬
const KICK_STIFFNESS = 300;
const KICK_DAMPING = 24;
const KICK_ADS_MUL = 0.55; // ADS 时后坐视觉压制（贴腮更稳）

/** 抛壳池。700rpm ≈ 11.7 发/秒 × SHELL_LIFE，取 24 保证连发扫射时不会提前回收 */
const SHELL_COUNT = 24;
const SHELL_LIFE = 1.8; // 秒
const SHELL_GRAVITY = -11.5; // m/s²，比真实重力略猛，抛物线更利落
const SHELL_DRAG = 1.4;

/** 换弹动画：下沉 + 倾斜的姿态偏移量 */
const RELOAD_DIP_Y = -0.11;
const RELOAD_DIP_Z = 0.06;
const RELOAD_TILT_X = 0.34;
const RELOAD_TILT_Z = 0.3;
const RELOAD_TILT_Y = 0.2;
/** 进入/退出下沉各占总时长的比例 */
const RELOAD_IN = 0.16;
const RELOAD_OUT = 0.2;

// ---------------------------------------------------------------------------

export interface ViewModelUpdateOpts {
  /** 玩家水平速度 m/s */
  speed: number;
  onGround: boolean;
  /** 0..1 机瞄过渡，由 Weapon.adsT 传入 */
  adsT: number;
  /** Recoil.pitch + Recoil.climb（弧度），枪口上抬 */
  recoilPitch: number;
  /** Recoil.kickZ（米），枪模后缩 */
  recoilKick: number;
  /** 本帧鼠标增量（弧度），与 Player.look 的入参同源 */
  lookDx: number;
  lookDy: number;
}

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export class ViewModel {
  /** 枪口世界坐标 —— 每帧 update() 末尾刷新。曳光弹/枪口火光必须用它。 */
  readonly muzzleWorld = new THREE.Vector3();
  /** 枪口朝向（世界，单位向量）—— 附赠，MuzzleFx 需要方向时可用 */
  readonly muzzleDir = new THREE.Vector3(0, 0, -1);

  /** 抛壳落地高度。M0 巷子地面在 y=0，如果关卡地面不在 0 请由 main 改这个值。 */
  floorY = 0;

  private readonly camera: THREE.PerspectiveCamera;
  /** 挂在相机下的容器；所有姿态变换都写在 gun 上 */
  private readonly gun = new THREE.Group();
  private readonly muzzlePoint = new THREE.Object3D();
  private readonly ejectPort = new THREE.Object3D();

  // --- 红点镜（在 buildGun 里创建）---
  private dot!: THREE.Mesh;
  private dotGlow!: THREE.Mesh;
  private dotMat!: THREE.MeshBasicMaterial;
  private dotGlowMat!: THREE.MeshBasicMaterial;

  // --- sway 状态 ---
  private swayPos = new THREE.Vector2(0, 0);
  private swayRot = new THREE.Vector2(0, 0); // x = pitch, y = yaw

  // --- bob 状态 ---
  private bobPhase = 0;
  private bobX = 0;
  private bobY = 0;
  private bobRoll = 0;

  // --- 开火弹簧 ---
  private kickZ = 0;
  private kickZVel = 0;
  private kickPitch = 0;
  private kickPitchVel = 0;
  private kickYaw = 0;
  private kickYawVel = 0;

  // --- 换弹动画 ---
  private reloadT = 0;
  private reloadDur = 0;

  // --- 抛壳池（预分配，运行时绝不 new 网格）---
  private readonly shells: THREE.Mesh[] = [];
  private readonly shellVel: THREE.Vector3[] = [];
  private readonly shellSpin: THREE.Vector3[] = [];
  private readonly shellLife = new Float32Array(SHELL_COUNT);
  private readonly shellBounced = new Uint8Array(SHELL_COUNT);
  private shellCursor = 0;
  private shellParent: THREE.Object3D | null = null;

  // --- 复用临时对象 ---
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;

    this.buildGun();
    this.gun.position.copy(HIP_POS);
    this.gun.rotation.copy(HIP_ROT);
    camera.add(this.gun);

    this.buildShellPool();
  }

  // -------------------------------------------------------------------------
  // 几何构建 —— 只在构造时跑一次
  // -------------------------------------------------------------------------

  private buildGun(): void {
    // 深色金属 + 少量暖色细节：巷子整体冷灰蓝，枪身上的暖橙件是唯一的暖色锚点。
    // 各材质带一点极弱的冷色自发光 —— 巷子很暗，纯 PBR 会让枪模在无灯区糊成
    // 一团黑，读不出轮廓。这是"保底可读性"，不是发光效果，别调大。
    const steel = new THREE.MeshStandardMaterial({
      color: 0x24272c,
      metalness: 0.9,
      roughness: 0.38,
      emissive: 0x0a0d12,
    });
    const polymer = new THREE.MeshStandardMaterial({
      color: 0x1d1f22,
      metalness: 0.05,
      roughness: 0.88,
      emissive: 0x080a0d,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x121417,
      metalness: 0.6,
      roughness: 0.5,
      emissive: 0x05070a,
    });
    // 暖色细节：拉机柄 / 弹匣底板 / 保险柄。带一点自发光，暗巷里也能读出轮廓
    const accent = new THREE.MeshStandardMaterial({
      color: 0x8f5522,
      metalness: 0.75,
      roughness: 0.4,
      emissive: 0x2a1206,
      emissiveIntensity: 1,
    });

    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      rx = 0,
      ry = 0,
      rz = 0,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      // 枪模永远在相机前方，不需要参与剔除/阴影（省一次 shadow pass 的绘制）
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      this.gun.add(m);
      return m;
    };

    const B = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
    const C = (r: number, h: number, seg = 12) => new THREE.CylinderGeometry(r, r, h, seg);
    const HALF = Math.PI / 2; // 圆柱默认沿 Y 轴，转 90° 让它沿 Z（枪管方向）

    // ——— 机匣 ———
    add(B(0.07, 0.072, 0.3), polymer, 0, 0.002, 0.02); // 下机匣
    add(B(0.068, 0.052, 0.34), steel, 0, 0.05, -0.02); // 上机匣
    add(B(0.03, 0.01, 0.3), dark, 0, 0.079, -0.02); // 顶部导轨
    add(B(0.006, 0.026, 0.055), dark, 0.037, 0.046, 0.028); // 抛壳口盖板
    add(B(0.052, 0.012, 0.03), accent, 0, 0.072, 0.15); // 拉机柄（暖色）
    add(B(0.018, 0.014, 0.01), accent, -0.04, 0.014, 0.062); // 保险柄（暖色）

    // ——— 护木 + 枪管 ———
    add(B(0.056, 0.058, 0.26), polymer, 0, 0.042, -0.28);
    // 护木散热槽：三条压暗的横条，纯几何细节，成本可忽略
    for (let i = 0; i < 3; i++) {
      add(B(0.058, 0.008, 0.03), dark, 0, 0.042, -0.2 - i * 0.07);
    }
    add(C(0.0115, 0.34), steel, 0, 0.042, -0.46, HALF); // 枪管
    add(B(0.028, 0.034, 0.05), dark, 0, 0.054, -0.41); // 导气箍
    add(C(0.017, 0.05, 10), dark, 0, 0.042, -0.615, HALF); // 枪口制退器

    // ——— 弹匣 / 握把 / 扳机护圈 ———
    add(B(0.03, 0.155, 0.07), polymer, 0, -0.088, 0.02, 0.13);
    add(B(0.034, 0.012, 0.074), accent, 0, -0.166, 0.031, 0.13); // 弹匣底板（暖色）
    add(B(0.036, 0.105, 0.052), polymer, 0, -0.078, 0.115, -0.3); // 握把
    add(B(0.02, 0.008, 0.055), dark, 0, -0.042, 0.056); // 扳机护圈下缘
    add(B(0.008, 0.022, 0.008), dark, 0, -0.03, 0.05); // 扳机

    // ——— 枪托 ———
    add(C(0.019, 0.16, 10), steel, 0, 0.042, 0.25, HALF); // 缓冲管
    add(B(0.048, 0.085, 0.15), polymer, 0, 0.022, 0.27);
    add(B(0.052, 0.096, 0.016), dark, 0, 0.02, 0.346); // 托底板

    // ——— 铁瞄：准星（前）+ 照门（后），准线高度 = SIGHT_LINE_Y ———
    // 装了红点镜之后铁瞄就是备用件，保留它是因为真枪也这么放（而且侧面轮廓好看）
    add(B(0.02, 0.03, 0.014), dark, 0, 0.083, -0.4); // 准星座
    add(B(0.004, 0.022, 0.004), dark, 0, SIGHT_LINE_Y - 0.001, -0.4); // 准星柱
    add(B(0.034, 0.008, 0.02), dark, 0, 0.084, 0.055); // 照门座

    // ——— 红点镜 ———
    // 一个方形镜筒架在导轨上：底座 + 四根立柱围出镜框 + 前后两片玻璃。
    // 镜框刻意做成「框」而不是实心块，玩家透过它看目标，边框只占视野一小圈。
    const DOT_Z = -0.03; // 镜子在枪上的前后位置（导轨中段）
    const FRAME = 0.052; // 镜框内框边长
    const H = FRAME / 2;
    const WALL = 0.005; // 边框厚度
    const LEN = 0.062; // 镜筒长度

    // 底座 + 导轨夹
    add(B(0.03, 0.016, 0.05), dark, 0, 0.09, DOT_Z);
    add(B(0.042, 0.008, 0.016), accent, 0, 0.086, DOT_Z + 0.03); // 调节旋钮（暖色）

    // 镜框四边（上/下/左/右），中间留空 = 可视窗口
    const fy = DOT_AXIS_Y;
    add(B(FRAME + WALL * 2, WALL, LEN), dark, 0, fy + H, DOT_Z); // 上
    add(B(FRAME + WALL * 2, WALL, LEN), dark, 0, fy - H, DOT_Z); // 下
    add(B(WALL, FRAME, LEN), dark, -H - WALL / 2, fy, DOT_Z); // 左
    add(B(WALL, FRAME, LEN), dark, H + WALL / 2, fy, DOT_Z); // 右

    // 镜片：极淡的青色玻璃，双面可见。真红点镜的镀膜就是偏青的。
    const glass = new THREE.MeshBasicMaterial({
      color: 0x8fb4c4,
      transparent: true,
      opacity: 0.14,
      depthWrite: false, // 别写深度，否则会挡住后面的红点
      side: THREE.DoubleSide,
    });
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(FRAME, FRAME), glass);
    lens.position.set(0, fy, DOT_Z - LEN / 2 + 0.004);
    lens.frustumCulled = false;
    this.gun.add(lens);

    // ——— 红点本体 ———
    // 关键：additive + depthTest:false，让红点永远浮在最前面（真红点是投在
    // 镜片上的虚像，不会被镜框或枪身遮住）。挂在 gun 下 → 后坐/sway 带着它跳。
    this.dotMat = new THREE.MeshBasicMaterial({
      color: 0xff2b18,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.0016, 12), this.dotMat);
    // 放在镜筒中段的光轴上
    this.dot.position.set(0, fy, DOT_Z);
    this.dot.frustumCulled = false;
    this.dot.renderOrder = 999; // 最后画，保证盖在玻璃和镜框之上
    this.gun.add(this.dot);

    // 红点外面一圈很淡的光晕 —— 真红点在暗处会有辉光，也让它在暗巷里更好读
    this.dotGlowMat = new THREE.MeshBasicMaterial({
      color: 0xff5533,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.dotGlow = new THREE.Mesh(new THREE.CircleGeometry(0.0044, 14), this.dotGlowMat);
    this.dotGlow.position.copy(this.dot.position);
    this.dotGlow.frustumCulled = false;
    this.dotGlow.renderOrder = 998;
    this.gun.add(this.dotGlow);

    // ——— 空点：枪口 / 抛壳口 ———
    // 枪口点必须落在**枪管末端**（制退器出口），不能用相机中心，
    // 否则近距离射击时曳光弹会从玩家脸上射出来。
    this.muzzlePoint.position.set(0, 0.042, -0.645);
    this.gun.add(this.muzzlePoint);

    this.ejectPort.position.set(0.045, 0.05, 0.03);
    this.gun.add(this.ejectPort);
  }

  private buildShellPool(): void {
    const geo = new THREE.CylinderGeometry(0.0045, 0.005, 0.024, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc39a4e,
      metalness: 0.95,
      roughness: 0.3,
    });
    for (let i = 0; i < SHELL_COUNT; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.castShadow = false;
      m.frustumCulled = true;
      this.shells.push(m);
      this.shellVel.push(new THREE.Vector3());
      this.shellSpin.push(new THREE.Vector3());
      this.shellLife[i] = 0;
    }
  }

  /**
   * 抛壳需要挂在世界空间（不能挂相机，否则壳会跟着玩家平移）。
   * 构造时相机可能还没 add 进 scene，所以延迟到第一次抛壳再解析根节点。
   */
  private ensureShellParent(): THREE.Object3D {
    if (this.shellParent) return this.shellParent;
    let root: THREE.Object3D = this.camera;
    while (root.parent) root = root.parent;
    // 相机还没进场景时退化成挂相机（只影响观感，不会崩）
    this.shellParent = root === this.camera ? this.camera : root;
    for (const s of this.shells) this.shellParent.add(s);
    return this.shellParent;
  }

  // -------------------------------------------------------------------------
  // 每帧更新 —— dt 必须传 time.unscaledDelta
  // -------------------------------------------------------------------------

  update(dt: number, opts: ViewModelUpdateOpts): void {
    const ads = clamp01(opts.adsT);
    const adsEase = smoothstep01(ads);

    // 红点镜：红点亮度随开镜淡入。红点本身是**挂在枪上的 3D 物体**，
    // 所以后坐/sway 会自然带着它跳 —— 打击感就在这里，不要把它做成 HUD 元素
    // （屏幕元素永远死在正中，反而会把后坐力的意义抹掉）。
    this.updateDot(ads);

    this.updateSway(dt, opts.lookDx, opts.lookDy, ads);
    this.updateBob(dt, opts.speed, opts.onGround, ads);
    this.updateKick(dt);

    // ——— 基础姿态：腰射 ←→ 机瞄插值 ———
    const px = lerp(HIP_POS.x, ADS_POS.x, adsEase);
    const py = lerp(HIP_POS.y, ADS_POS.y, adsEase);
    const pz = lerp(HIP_POS.z, ADS_POS.z, adsEase);
    const rx = lerp(HIP_ROT.x, ADS_ROT.x, adsEase);
    const ry = lerp(HIP_ROT.y, ADS_ROT.y, adsEase);
    const rz = lerp(HIP_ROT.z, ADS_ROT.z, adsEase);

    // ——— 叠加 sway / bob / 后坐 ———
    // recoilKick 沿 +Z（朝相机）后缩；recoilPitch 抬枪口（绕 X 负方向）
    const adsKickMul = lerp(1, KICK_ADS_MUL, adsEase);
    let x = px + this.swayPos.x + this.bobX;
    let y = py + this.swayPos.y + this.bobY;
    let z = pz + (opts.recoilKick + this.kickZ) * adsKickMul;
    let ex = rx + this.swayRot.x - (opts.recoilPitch + this.kickPitch) * adsKickMul;
    let ey = ry + this.swayRot.y + this.kickYaw * adsKickMul;
    let ez = rz + this.bobRoll;

    // ——— 换弹动画：下沉 + 三轴倾斜，覆盖在最上层 ———
    if (this.reloadDur > 0) {
      this.reloadT += dt;
      const p = this.reloadT / this.reloadDur;
      if (p >= 1) {
        this.reloadDur = 0;
      } else {
        // 快速下沉 → 保持 → 快速复位
        const dip =
          p < RELOAD_IN
            ? smoothstep01(p / RELOAD_IN)
            : p > 1 - RELOAD_OUT
              ? 1 - smoothstep01((p - (1 - RELOAD_OUT)) / RELOAD_OUT)
              : 1;
        y += RELOAD_DIP_Y * dip;
        z += RELOAD_DIP_Z * dip;
        ex += RELOAD_TILT_X * dip;
        ey += RELOAD_TILT_Y * dip;
        ez += RELOAD_TILT_Z * dip;
        // 换弹中段轻微抖动，读起来像手在动而不是刚体插值
        x += Math.sin(this.reloadT * 26) * 0.004 * dip;
      }
    }

    this.gun.position.set(x, y, z);
    this.gun.rotation.set(ex, ey, ez);

    // ——— 刷新枪口世界坐标 ———
    // updateWorldMatrix(true, true)：先把祖先（相机）的世界矩阵刷新，再刷子树。
    // 不这么做的话，本帧刚转过的视角要下一帧才反映到枪口位置上。
    this.gun.updateWorldMatrix(true, true);
    this.muzzlePoint.getWorldPosition(this.muzzleWorld);
    this.muzzlePoint.getWorldQuaternion(this.tmpQ);
    this.muzzleDir.set(0, 0, -1).applyQuaternion(this.tmpQ);

    this.updateShells(dt);
  }

  /**
   * 红点亮度。腰射时不亮（看不见镜片里的点，也不该用它瞄），
   * 开镜过程中淡入 —— 用 ads 的高次幂，让它在举枪快到位时才亮起来，
   * 而不是一按右键就凭空点亮。
   */
  private updateDot(ads: number): void {
    // 先把 ads 重映射到 [DOT_FADE_START, 1] → [0, 1]，再取平方。
    // 直接用 ads^3 不行：adsT 是指数逼近的，永远只是趋近 1 而到不了 1
    // （实测 0.97），红点会卡在 0.59 亮度上，永远读不出「点亮了」。
    const k = Math.pow(clamp01((ads - DOT_FADE_START) / (1 - DOT_FADE_START)), 2);
    this.dotMat.opacity = k;
    this.dotGlowMat.opacity = k * 0.5;
    // 完全不亮时干脆不画，省两个 draw call（腰射是常态）
    this.dot.visible = k > 0.01;
    this.dotGlow.visible = k > 0.01;
  }

  /**
   * sway：视角转多少，枪就往**反**方向甩多少（惯性），再指数弹回原位。
   * 弹回而不是硬跟随，是"重量"的全部来源。
   */
  private updateSway(dt: number, lookDx: number, lookDy: number, ads: number): void {
    const mul = lerp(1, SWAY_ADS_MUL, ads);

    this.swayPos.x = clamp(
      this.swayPos.x - lookDx * SWAY_POS_GAIN * mul,
      -SWAY_POS_MAX,
      SWAY_POS_MAX,
    );
    this.swayPos.y = clamp(
      this.swayPos.y - lookDy * SWAY_POS_GAIN * mul,
      -SWAY_POS_MAX,
      SWAY_POS_MAX,
    );
    this.swayRot.x = clamp(
      this.swayRot.x - lookDy * SWAY_ROT_GAIN * mul,
      -SWAY_ROT_MAX,
      SWAY_ROT_MAX,
    );
    this.swayRot.y = clamp(
      this.swayRot.y - lookDx * SWAY_ROT_GAIN * mul,
      -SWAY_ROT_MAX,
      SWAY_ROT_MAX,
    );

    const a = expApproach(SWAY_RETURN, dt);
    this.swayPos.x = lerp(this.swayPos.x, 0, a);
    this.swayPos.y = lerp(this.swayPos.y, 0, a);
    this.swayRot.x = lerp(this.swayRot.x, 0, a);
    this.swayRot.y = lerp(this.swayRot.y, 0, a);
  }

  /**
   * bob：x = sin(phase)，y = -|sin(phase)|（取负号让枪在落脚瞬间下沉，
   * 与脚步声对齐）。幅度随速度缩放，ADS / 静止 / 离地时关掉。
   */
  private updateBob(dt: number, speed: number, onGround: boolean, ads: number): void {
    const norm = clamp01(speed / BOB_REF_SPEED);
    const active = onGround && speed > 0.4;
    if (active) {
      this.bobPhase += dt * BOB_RATE * lerp(0.65, 1.25, norm);
      if (this.bobPhase > Math.PI * 2000) this.bobPhase -= Math.PI * 2000;
    }

    const amp = active ? norm * (1 - ads) : 0;
    const tx = Math.sin(this.bobPhase) * BOB_AMP_X * amp;
    const ty = -Math.abs(Math.sin(this.bobPhase)) * BOB_AMP_Y * amp;
    const tr = Math.sin(this.bobPhase) * BOB_AMP_ROLL * amp;

    const a = expApproach(BOB_BLEND, dt);
    this.bobX = lerp(this.bobX, tx, a);
    this.bobY = lerp(this.bobY, ty, a);
    this.bobRoll = lerp(this.bobRoll, tr, a);
  }

  /**
   * 开火脉冲弹簧：半隐式欧拉，刚度高、阻尼大 → 瞬间弹开、快速收敛。
   *
   * ⚠ 必须定长子步进。显式积分这个弹簧的稳定上限约 dt < 2/KICK_DAMPING ≈ 0.083s，
   * 而 core/time.ts 的 MAX_FRAME_DT 钳位是 0.1s —— 只要出现一次超过 83ms 的卡顿
   * （切标签页、GC、着色器编译、断点），弹簧就会发散，而且因为是自激的，
   * 之后**永远回不来**：枪模会飞到 1e24 之外，muzzleWorld 跟着变成天文数字，
   * 曳光弹和枪口火光全部失效。实测确认过。
   *
   * 定长子步进既保住了原有手感（刚度/阻尼参数不变），又让它在任意帧时长下无条件稳定。
   */
  private updateKick(dt: number): void {
    const MAX_SUB = 1 / 240; // 远小于 2/KICK_DAMPING，留足裕量
    const steps = Math.min(32, Math.max(1, Math.ceil(dt / MAX_SUB)));
    const h = dt / steps;

    for (let i = 0; i < steps; i++) {
      this.kickZVel += (-KICK_STIFFNESS * this.kickZ - KICK_DAMPING * this.kickZVel) * h;
      this.kickZ += this.kickZVel * h;
      this.kickPitchVel +=
        (-KICK_STIFFNESS * this.kickPitch - KICK_DAMPING * this.kickPitchVel) * h;
      this.kickPitch += this.kickPitchVel * h;
      this.kickYawVel += (-KICK_STIFFNESS * this.kickYaw - KICK_DAMPING * this.kickYawVel) * h;
      this.kickYaw += this.kickYawVel * h;
    }

    // 兜底：任何来源的 NaN/Inf 都不允许污染枪模变换（会顺着 muzzleWorld 扩散出去）
    if (!Number.isFinite(this.kickZ + this.kickPitch + this.kickYaw)) {
      this.kickZ = this.kickPitch = this.kickYaw = 0;
      this.kickZVel = this.kickPitchVel = this.kickYawVel = 0;
    }
  }

  private updateShells(dt: number): void {
    if (!this.shellParent) return;
    for (let i = 0; i < SHELL_COUNT; i++) {
      if (this.shellLife[i] <= 0) continue;
      this.shellLife[i] -= dt;
      const m = this.shells[i];
      if (this.shellLife[i] <= 0) {
        m.visible = false;
        continue;
      }
      const v = this.shellVel[i];
      const spin = this.shellSpin[i];

      v.y += SHELL_GRAVITY * dt;
      const drag = Math.max(0, 1 - SHELL_DRAG * dt);
      v.x *= drag;
      v.z *= drag;
      m.position.addScaledVector(v, dt);
      m.rotation.x += spin.x * dt;
      m.rotation.y += spin.y * dt;
      m.rotation.z += spin.z * dt;

      // 落地：第一次弹一下，第二次躺平（M0 巷子是平地，floorY 可由 main 改）
      const rest = this.floorY + 0.006;
      if (m.position.y <= rest && v.y < 0) {
        m.position.y = rest;
        if (this.shellBounced[i] === 0) {
          this.shellBounced[i] = 1;
          v.y *= -0.32;
          v.x *= 0.45;
          v.z *= 0.45;
          spin.multiplyScalar(0.35);
        } else {
          v.set(0, 0, 0);
          spin.set(0, 0, 0);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /** 开火：后坐弹簧脉冲 + 抛壳。由 Weapon 在开火那一帧同步调用。 */
  onFire(): void {
    this.kickZVel += KICK_IMPULSE_Z;
    this.kickPitchVel += KICK_IMPULSE_PITCH * (0.85 + Math.random() * 0.3);
    this.kickYawVel += randSigned() * KICK_IMPULSE_PITCH * 0.22;
    this.ejectShell();
  }

  /** 换弹：在 sec 秒内做一次下沉 + 倾斜再复位 */
  onReload(sec: number): void {
    this.reloadT = 0;
    this.reloadDur = Math.max(0.05, sec);
  }

  /** 强制回到静止姿态（重生 / 关卡重置时用） */
  reset(): void {
    this.swayPos.set(0, 0);
    this.swayRot.set(0, 0);
    this.bobPhase = 0;
    this.bobX = this.bobY = this.bobRoll = 0;
    this.kickZ = this.kickZVel = 0;
    this.kickPitch = this.kickPitchVel = 0;
    this.kickYaw = this.kickYawVel = 0;
    this.reloadDur = 0;
    for (let i = 0; i < SHELL_COUNT; i++) {
      this.shellLife[i] = 0;
      this.shells[i].visible = false;
    }
  }

  private ejectShell(): void {
    if (!feelOn(feelConfig.vfx.shell)) return;

    const parent = this.ensureShellParent();
    const i = this.shellCursor;
    this.shellCursor = (this.shellCursor + 1) % SHELL_COUNT;

    const m = this.shells[i];
    this.ejectPort.getWorldPosition(m.position);
    // 转到父节点局部空间。父节点通常是 scene（单位变换，这一步是空操作）；
    // 只有"相机还没进场景"的退化路径才会有偏差，且只影响观感。
    parent.worldToLocal(m.position);

    this.gun.getWorldQuaternion(this.tmpQ);
    // 局部方向：主要向右（+X）、略向上、略向后 —— AR 的标准抛壳轨迹
    this.tmpV
      .set(1, 0.55, 0.18)
      .normalize()
      .applyQuaternion(this.tmpQ)
      .multiplyScalar(1.9 + Math.random() * 0.7);
    // 叠一点随机扰动，连发时壳不会排成一条直线
    this.tmpV2.set(randSigned() * 0.35, randSigned() * 0.3, randSigned() * 0.35);
    this.shellVel[i].copy(this.tmpV).add(this.tmpV2);

    this.shellSpin[i].set(randSigned() * 26, randSigned() * 18, randSigned() * 26);
    m.quaternion.copy(this.tmpQ);
    m.rotation.z += Math.PI / 2; // 圆柱默认沿 Y，转成横躺
    this.shellLife[i] = SHELL_LIFE;
    this.shellBounced[i] = 0;
    m.visible = true;
  }
}

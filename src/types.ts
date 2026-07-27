/**
 * 全局共享契约。所有子系统都对着这里编码。
 */

import type * as THREE from 'three';

// ---------------------------------------------------------------------------
// 表面材质 —— 决定穿透、弹着特效、音效
// ---------------------------------------------------------------------------

export type SurfaceKind =
  | 'concrete' // 混凝土 / 承重墙：唯一的真掩体
  | 'brick' // 薄砖：能穿但代价大
  | 'metal' // 铁皮 / 广告牌：看着像掩体，其实是陷阱
  | 'wood' // 木板 / 三合板：几乎挡不住子弹
  | 'glass' // 玻璃：碎了永久改变视线
  | 'dirt' // 泥土 / 积水
  | 'flesh'; // 人体

export interface SurfaceDef {
  kind: SurfaceKind;
  /** 穿透系数 0..1。0 = 不可穿透；子弹每穿一层，伤害 ×= 此值 */
  penetration: number;
  /** 弹着火花数量（0 = 无火花） */
  sparks: number;
  /** 火花颜色 */
  sparkColor: number;
  /** 尘烟数量 */
  dust: number;
  /** 尘烟颜色 */
  dustColor: number;
  /** 是否留弹孔贴花 */
  decal: boolean;
  /** 贴花颜色 */
  decalColor: number;
  /** 弹着音的基频（Hz）与衰减，供程序化音频用 */
  impactTone: number;
  impactDecay: number;
}

// ---------------------------------------------------------------------------
// 命中信息
// ---------------------------------------------------------------------------

export type BodyPart = 'head' | 'torso' | 'limb';

export interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceKind;
  /** 命中的敌人（若命中的是世界几何则为 null） */
  enemy: EnemyRef | null;
  part: BodyPart | null;
  /** 已穿透的层数（0 = 直接命中） */
  penetrated: number;
}

export interface EnemyRef {
  id: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  object: THREE.Object3D;
  /** 由 damage 系统调用 */
  applyDamage(amount: number, part: BodyPart, fromDir: THREE.Vector3): void;
}

// ---------------------------------------------------------------------------
// 伤害结算结果 —— 打击感栈的输入
// ---------------------------------------------------------------------------

export interface DamageResult {
  amount: number;
  part: BodyPart;
  killed: boolean;
  headshot: boolean;
  /** 世界坐标，伤害数字在这里冒出来 */
  worldPos: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// 武器定义 —— 数据驱动，改数值不改代码
// ---------------------------------------------------------------------------

export interface WeaponDef {
  id: string;
  name: string;
  /** 单发基础伤害 */
  damage: number;
  /** 每分钟射速 */
  rpm: number;
  /** 每次扣扳机发射的弹丸数（霰弹 > 1） */
  pellets: number;
  magSize: number;
  reloadSec: number;
  reloadEmptySec: number;
  /** 散布半角（度） */
  spreadStand: number;
  spreadMove: number;
  spreadADS: number;
  spreadAir: number;
  /** 后坐力 */
  recoilVert: number; // 度，每发抬枪口
  recoilHoriz: number; // 度，每发左右随机幅度
  recoilKick: number; // 米，枪模后缩
  /** 打击感 */
  trauma: number; // 开火时注入的 trauma
  hitstopNormal: number; // 帧
  hitstopHead: number; // 帧
  hitstopKill: number; // 帧
  /** 距离衰减 */
  falloffStart: number; // 米
  falloffEnd: number;
  falloffMinMul: number;
  /** 穿透力：子弹最多穿几层 */
  maxPenetrations: number;
  /** 每 N 发一条曳光弹（1 = 每发都有） */
  tracerEvery: number;
  /**
   * 瞄准镜倍率。ADS 时相机 FOV 线性插值到 BASE_FOV / scopeZoom。
   * 1 = 不放大（纯机瞄/红点），>1 = 倍镜。这是核心瞄准功能，不受
   * feelConfig.master 打击感总开关影响。
   */
  scopeZoom: number;
  /** 音频 */
  audio: WeaponAudioDef;
}

export interface WeaponAudioDef {
  /** 主体爆响的基频 */
  bodyFreq: number;
  /** 主体时长（秒） */
  bodyDecay: number;
  /** 次低频冲击的频率与时长 */
  subFreq: number;
  subDecay: number;
  /** 机械拟音的亮度 */
  mechBright: number;
  /** 尾音时长 */
  tailDecay: number;
}

// ---------------------------------------------------------------------------
// 打击感反馈事件 —— feel 层的统一入口
// ---------------------------------------------------------------------------

export interface FeedbackHit {
  worldPos: THREE.Vector3;
  screenNormal: THREE.Vector3;
  damage: number;
  part: BodyPart;
  killed: boolean;
}

// ---------------------------------------------------------------------------
// 子系统统一生命周期
// ---------------------------------------------------------------------------

export interface System {
  /** dt 是 unscaled 还是 scaled 由各系统自行决定并在实现中注明 */
  update(dt: number): void;
}

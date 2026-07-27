/**
 * 打击感参数中心 —— 唯一的调参真源。
 *
 * lil-gui 面板直接绑定这个对象；每一层反馈都能独立开关，外加一个总开关
 * 用于 A/B 对比。Vlambeer《The Art of Screenshake》全部的说服力，就来自
 * 每个技巧都能单独开关 —— 这个面板不是锦上添花，它是打击感能不能调出来
 * 的前提。
 *
 * 约定：任何模块读参数都从这里读，不要在自己文件里写死数值。
 */

export const feelConfig = {
  /** 总开关。关掉 = 所有打击感层旁路，只剩裸射击。用于 A/B 演示。 */
  master: true,

  /**
   * 操作手感 —— **不是打击感层**，所以不走 feelOn()，master 关掉时依然生效。
   * 放在这里只是因为它需要能在同一个面板里实时调（灵敏度必须边动边试）。
   */
  input: {
    /** 鼠标灵敏度：弧度 / 像素。0.0038 ≈ 0.22°/px */
    lookSens: 0.0038,
    /**
     * 开镜时的灵敏度倍率。倍镜放大了画面，同样的鼠标位移在屏幕上跨过更多角度，
     * 所以要压一点才瞄得住；但不做成 1/zoom 的完全补偿，那样会黏得难受。
     */
    adsSensMul: 0.7,
    /** 右键开镜是否为「切换」模式。true = 按一下开、再按一下关（不用一直按住）。 */
    adsToggle: true,
  },

  shake: {
    enabled: true,
    /** trauma 每秒衰减量。1.2 → 满值约 0.83s 归零 */
    decay: 1.2,
    /** 噪声采样频率 Hz */
    freq: 22,
    /** 幂次。2 = trauma²，让小 trauma 几乎不动、大 trauma 猛砸 */
    exponent: 2,
    maxPitch: 2.5, // 度
    maxYaw: 2.0,
    maxRoll: 3.5, // roll 给最大：最有劲，最不晕
    /** 受击时额外注入的 trauma */
    traumaOnHurt: 0.35,
  },

  hitstop: {
    enabled: true,
    /** 定帧时 timeScale 降到多少。0 = 全冻 */
    scale: 0.0,
    /** 各事件的帧数（60fps 下 1 帧 ≈ 16.7ms） */
    framesLimb: 1,
    framesTorso: 2,
    framesHead: 5,
    framesKill: 7,
  },

  slowmo: {
    enabled: true,
    /** 击杀后的慢镜 */
    scale: 0.35,
    durationMs: 400,
    /** 恢复到 1.0 的缓动时长 */
    recoverMs: 260,
  },

  recoil: {
    enabled: true,
    /** current 追 target 的刚度 —— 越大越脆 */
    snappiness: 18,
    /** target 回落到 0 的速度 —— 越小余味越长 */
    returnSpeed: 8,
    /** 全局倍率，方便整体调强弱 */
    scale: 1.0,
  },

  /** 视觉层，每层独立开关 */
  vfx: {
    muzzleFlash: true,
    muzzleLight: true,
    tracer: true,
    shell: true,
    impactSparks: true,
    impactDust: true,
    decals: true,
    bloodMist: true,
    /** 动态点光源池上限 —— 最贵的一项 */
    maxDynamicLights: 4,
    /** 贴花池上限（LRU） */
    maxDecals: 256,
  },

  /** UI 反馈层 */
  ui: {
    hitmarker: true,
    damageNumbers: true,
    hurtVignette: true,
    /** hitmarker 显示时长 ms */
    hitmarkerMs: 70,
    /** 伤害数字生命 s */
    damageTextLife: 0.7,
  },

  audio: {
    enabled: true,
    masterVolume: 0.5,
    /** 分层枪声各层开关 —— 用来听出每层贡献 */
    layerBody: true,
    layerSub: true,
    layerMech: true,
    layerTail: true,
    /** 低血量耳鸣 + 低通 */
    lowHealthFilter: true,
  },

  /** 手柄震动 */
  rumble: {
    enabled: true,
    scale: 1.0,
  },

  /** 后处理 */
  post: {
    enabled: true,
    bloom: true,
    bloomIntensity: 0.6,
    bloomThreshold: 0.85,
    vignette: true,
    vignetteDarkness: 0.35,
    chromatic: true,
    chromaticOffset: 0.0015,
    noise: true,
    noiseOpacity: 0.03,
  },

  /** 调试可视化 */
  debug: {
    showColliders: false,
    showHitscanRays: false,
    showStats: true,
  },
};

export type FeelConfig = typeof feelConfig;

/** 总开关的语义：关掉时所有反馈层都视为关闭。 */
export function feelOn(layer: boolean): boolean {
  return feelConfig.master && layer;
}

const FRAME_MS = 1000 / 60;

/** 帧数 → 毫秒 */
export function frames(n: number): number {
  return n * FRAME_MS;
}

/**
 * 程序化音频引擎 —— 零音频文件，全部 WebAudio 合成。
 *
 * 四层模型（Mark Kilborn / Call of Duty 音频总监的枪声分层法）：
 *   1. Transient / Body  —— 噪声爆冲 + 扫频低通，定义这把枪的主体爆响
 *   2. Sub / LFE         —— 低频下滑冲击，给「重量」，是你胸口感觉到的那一下
 *   3. Mechanical        —— 枪机/抛壳/弹簧的机械拟音，让枪像一台机器而不是一个音效
 *   4. Tail              —— 环境尾音，卖的是空间：窄巷 = 短促密集的多次反射，不是长混响
 *
 * 每层都有多个变体（噪声 seed / 频率微扰 ±8% / 时长抖动 ±15% / 缓冲区随机偏移），
 * 每次开火随机重组 —— 4 body × 2 sub × 3 mech × 4 tail = 96 种组合，扫射听不出重复。
 *
 * ── 时钟纪律 ────────────────────────────────────────────────────────────────
 * 本模块**完全不使用** time.scaledDelta / time.unscaledDelta / setUnscaledTimeout。
 * 所有调度都走 AudioContext.currentTime —— 它是采样精确的墙钟，天然 unscaled。
 * 这正是我们要的：hit-stop 定帧期间枪声必须照常响完，否则定帧读起来就是「卡了」。
 * （契约要求「禁止裸 setTimeout」；这里一个定时器都没有，全部交给音频线程。）
 *
 * ── 节点管理（本模块最重要的工程点）────────────────────────────────────────
 * 700 RPM 连射 ≈ 每秒 11.7 次开火 × 每次约 25 个节点 = 每秒 300 个节点。
 * 若不回收，几秒内就会把音频线程拖死。策略：
 *   · 每次发声的所有节点装进一个 Voice；
 *   · 最后一个 source 的 onended 触发整个 Voice 的 disconnect；
 *   · 额外有一道基于 ctx.currentTime 的清扫（onended 万一没触发时兜底）；
 *   · 再加一道硬上限，超了就强制回收最老的（应急阀，正常不会走到）。
 */

import type { SurfaceKind, WeaponAudioDef } from '../types';
import { surfaceOf } from '../level/materials';
import { feelConfig } from '../feel/config';
import { clamp, clamp01 } from '../core/time';
import { mulberry32, randSigned } from '../core/noise';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 同时存活的 Voice 硬上限。超了强制回收最早结束的那些。 */
const MAX_VOICES = 220;
/** exponentialRampToValueAtTime 不能取 0，用这个当「静音」 */
const EPS = 1e-4;
/** 预生成的白噪声条数（body / mech / impact 用，单声道） */
const WHITE_COUNT = 4;
/** 白噪声单条长度（秒）。短脉冲从随机偏移处取，等效于无限变体。 */
const WHITE_SEC = 0.8;
/** 尾音噪声条数（立体声，去相关左右声道 → 天然宽度） */
const TAIL_COUNT = 3;
const TAIL_SEC = 1.2;

// ---------------------------------------------------------------------------
// 分层变体表
// ---------------------------------------------------------------------------

interface BodyVariant {
  /** 噪声播放速率 —— 改变噪声的「颗粒感」 */
  rate: number;
  /** 相对 bodyFreq 的整体音高偏移 */
  freqMul: number;
  /** 扫频低通的谐振 */
  q: number;
  /** 低通起点 / 终点（bodyFreq 的倍数）—— 从明亮塌到低频，这是「爆响」的核心 */
  startMul: number;
  endMul: number;
  /** 共振峰增益 dB，给这把枪一个可辨认的音高 */
  peakDb: number;
  /** 是否过软削波（增加谐波密度，听起来更「炸」） */
  drive: boolean;
  /** 「撕裂」瞬态（高通噪声）的强度与转折频率 */
  crack: number;
  crackHz: number;
  level: number;
  decayMul: number;
  send: number;
}

const BODY_VARIANTS: BodyVariant[] = [
  { rate: 1.0, freqMul: 1.0, q: 6, startMul: 42, endMul: 3.0, peakDb: 7, drive: true, crack: 0.5, crackHz: 2600, level: 0.9, decayMul: 1.0, send: 0.9 },
  { rate: 1.15, freqMul: 0.94, q: 9, startMul: 34, endMul: 3.6, peakDb: 9, drive: false, crack: 0.4, crackHz: 2150, level: 0.86, decayMul: 1.12, send: 1.0 },
  { rate: 0.87, freqMul: 1.08, q: 12, startMul: 55, endMul: 2.4, peakDb: 5, drive: true, crack: 0.62, crackHz: 3300, level: 0.95, decayMul: 0.86, send: 0.8 },
  { rate: 1.06, freqMul: 0.9, q: 4.5, startMul: 28, endMul: 4.2, peakDb: 11, drive: false, crack: 0.33, crackHz: 1900, level: 0.82, decayMul: 1.26, send: 1.1 },
];

interface SubVariant {
  type: OscillatorType;
  /** 相对 subFreq 的起止音高 —— 下滑越深越「重」 */
  startMul: number;
  endMul: number;
  /** 音高下滑占 subDecay 的比例 */
  glideRatio: number;
  level: number;
  decayMul: number;
  /** 低通截止，防止 triangle 的高次谐波污染中频 */
  lp: number;
}

const SUB_VARIANTS: SubVariant[] = [
  { type: 'sine', startMul: 2.6, endMul: 0.62, glideRatio: 0.45, level: 0.8, decayMul: 1.0, lp: 220 },
  { type: 'triangle', startMul: 2.0, endMul: 0.72, glideRatio: 0.6, level: 0.66, decayMul: 1.18, lp: 180 },
];

interface MechClick {
  /** 相对开火时刻的偏移（秒） */
  at: number;
  /** 中心频率（会再乘 mechBright 映射出来的亮度系数） */
  f: number;
  q: number;
  decay: number;
  level: number;
}
interface MechVariant {
  clicks: MechClick[];
  /** 弹壳金属余振：短促的三角波 ping */
  ring: { at: number; f: number; decay: number; level: number } | null;
}

const MECH_VARIANTS: MechVariant[] = [
  // 单响：枪机复进到位
  { clicks: [{ at: 0.004, f: 2100, q: 3.0, decay: 0.03, level: 1.0 }], ring: null },
  // 双响：抽壳 + 复进
  {
    clicks: [
      { at: 0.003, f: 2650, q: 4.0, decay: 0.022, level: 0.9 },
      { at: 0.031, f: 1700, q: 3.0, decay: 0.028, level: 0.68 },
    ],
    ring: null,
  },
  // 单响 + 弹壳翻滚的金属 ping
  { clicks: [{ at: 0.005, f: 1900, q: 2.6, decay: 0.034, level: 0.95 }], ring: { at: 0.02, f: 3400, decay: 0.1, level: 0.26 } },
];

interface TailVariant {
  /** 预延迟：直达声与尾音之间的空隙，越大空间感越「远」 */
  pre: number;
  /** 尾音带通中心 */
  f: number;
  q: number;
  decayMul: number;
  level: number;
  send: number;
  rate: number;
}

const TAIL_VARIANTS: TailVariant[] = [
  { pre: 0.012, f: 900, q: 0.7, decayMul: 1.0, level: 0.4, send: 1.0, rate: 1.0 },
  { pre: 0.02, f: 650, q: 0.9, decayMul: 1.25, level: 0.34, send: 1.2, rate: 0.92 },
  { pre: 0.008, f: 1300, q: 0.6, decayMul: 0.8, level: 0.46, send: 0.8, rate: 1.1 },
  { pre: 0.026, f: 480, q: 1.1, decayMul: 1.45, level: 0.29, send: 1.35, rate: 0.86 },
];

/** 脚步声按材质换音色。scuff = 鞋底摩擦的沙沙；ring = 空腔共振（铁皮/木板） */
const FOOTSTEP: Record<SurfaceKind, { freq: number; q: number; decay: number; level: number; scuff: number; ring: number }> = {
  concrete: { freq: 470, q: 1.1, decay: 0.085, level: 0.3, scuff: 0.1, ring: 0 },
  brick: { freq: 420, q: 1.0, decay: 0.09, level: 0.28, scuff: 0.1, ring: 0 },
  metal: { freq: 880, q: 3.2, decay: 0.18, level: 0.3, scuff: 0.06, ring: 1500 },
  wood: { freq: 320, q: 2.2, decay: 0.13, level: 0.3, scuff: 0.05, ring: 620 },
  glass: { freq: 1400, q: 1.4, decay: 0.11, level: 0.26, scuff: 0.18, ring: 2900 },
  dirt: { freq: 260, q: 0.8, decay: 0.105, level: 0.26, scuff: 0.14, ring: 0 },
  flesh: { freq: 190, q: 0.9, decay: 0.075, level: 0.24, scuff: 0.03, ring: 0 },
};

// ---------------------------------------------------------------------------
// Voice —— 一次发声所拥有的全部节点，生命周期自管理
// ---------------------------------------------------------------------------

class Voice {
  /** 在 AudioEngine.voices 里的下标，用于 O(1) swap-remove */
  idx = -1;
  /** 本 Voice 最后一个 source 的计划停止时刻（AudioContext 时间轴） */
  stopAt = 0;

  private readonly nodes: AudioNode[] = [];
  private pending = 0;
  private disposed = false;

  constructor(private readonly onDone: (v: Voice) => void) {}

  /** 登记一个非 source 节点（filter / gain / shaper …） */
  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** 登记并启动一个 source。最后一个结束时整个 Voice 自毁。 */
  play<T extends AudioScheduledSourceNode>(s: T, start: number, stop: number, offset?: number): T {
    this.nodes.push(s);
    this.pending++;
    if (stop > this.stopAt) this.stopAt = stop;
    s.onended = () => {
      this.pending--;
      if (this.pending <= 0) this.dispose();
    };
    if (offset !== undefined) (s as unknown as AudioBufferSourceNode).start(start, offset);
    else s.start(start);
    s.stop(stop);
    return s;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) {
      const s = n as Partial<AudioScheduledSourceNode>;
      // 先摘掉回调，避免强制回收时再触发一次 dispose
      if (typeof s.stop === 'function') s.onended = null;
      try {
        n.disconnect();
      } catch {
        /* 已经断开：忽略 */
      }
    }
    this.nodes.length = 0;
    this.onDone(this);
  }
}

// ---------------------------------------------------------------------------
// 图
// ---------------------------------------------------------------------------

interface AudioGraph {
  ctx: AudioContext;
  /** 场景内发声（枪声/弹着/脚步/换弹）—— 受低血量低通影响 */
  dry: GainNode;
  /** 非场景内的 UI 反馈（hitmarker）—— 绕过低通，濒死时也必须听得清 */
  ui: GainNode;
  healthLP: BiquadFilterNode;
  limiter: DynamicsCompressorNode;
  master: GainNode;
  /** 窄巷混响：短、密、带 flutter 的早期反射 */
  alley: ConvolverNode;
  alleyWet: GainNode;
  /** 稍长稍暗的房间混响，只给击杀音这类需要「留白」的事件 */
  room: ConvolverNode;
  roomWet: GainNode;
  /** 耳鸣：两个常驻正弦，平时增益 0 */
  tinA: OscillatorNode;
  tinB: OscillatorNode;
  tinGain: GainNode;
  white: AudioBuffer[];
  tails: AudioBuffer[];
  /** 用 WaveShaperNode 自己的曲线类型，避开 TS 5.7+ TypedArray 的 ArrayBufferLike 泛型收窄 */
  satCurve: SatCurve;
}

type SatCurve = NonNullable<WaveShaperNode['curve']>;

type Bus = 'dry' | 'ui';
type Verb = 'alley' | 'room';

interface BurstOpts {
  /** 不给就随机挑一条预生成白噪声 */
  buf?: AudioBuffer;
  type?: BiquadFilterType;
  freq: number;
  q?: number;
  attack?: number;
  decay: number;
  level: number;
  rate?: number;
  /** 额外的空气吸收低通（距离衰减用） */
  lp?: number;
  send?: number;
  bus?: Bus;
  rev?: Verb;
  /** 相对基准时刻的起始偏移 */
  delay?: number;
  /** 过软削波 */
  drive?: boolean;
  /** 扫频低通：从 freq*sweepFrom 塌到 freq*sweepTo，占 decay 的 sweepRatio */
  sweepFrom?: number;
  sweepTo?: number;
  sweepRatio?: number;
  /** 共振峰 dB（0 = 不加） */
  peakDb?: number;
}

interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  /** 不给就不滑音 */
  f1?: number;
  glide?: number;
  attack?: number;
  decay: number;
  level: number;
  lp?: number;
  send?: number;
  bus?: Bus;
  rev?: Verb;
  delay?: number;
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

export class AudioEngine {
  private g: AudioGraph | null = null;
  private voices: Voice[] = [];

  /** 上次实际写进 master 的音量，用于轮询 feelConfig 的改动 */
  private appliedVolume = -1;
  private appliedLowHealth = true;
  private health = 1;
  private lastSweep = 0;

  // 各层「上一次用的变体」，用来保证连续两发不同
  private lastBody = -1;
  private lastSub = -1;
  private lastMech = -1;
  private lastTail = -1;

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 必须在用户手势里调用（浏览器不允许在手势外创建/恢复 AudioContext）。
   * 重复调用是安全的：已初始化时只做一次 resume。
   * 无 WebAudio 的环境静默降级 —— 所有发声方法此后安静返回，不抛错。
   */
  init(): void {
    if (this.g) {
      void this.g.ctx.resume();
      return;
    }

    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }

    // ---- 输出链 -----------------------------------------------------------
    // dry ─┐
    //      ├→ healthLP ─┐
    // wet ─┘             ├→ limiter → master → destination
    // ui  ───────────────┤
    // tin ───────────────┘
    const master = ctx.createGain();
    master.gain.value = clamp01(feelConfig.audio.masterVolume);
    master.connect(ctx.destination);

    // 安全限幅器。扫射时四层叠加瞬时峰值会超 1，没有它会削出难听的数字失真。
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(master);

    const healthLP = ctx.createBiquadFilter();
    healthLP.type = 'lowpass';
    healthLP.frequency.value = 19000;
    healthLP.Q.value = 0.7;
    healthLP.connect(limiter);

    const dry = ctx.createGain();
    dry.gain.value = 0.9;
    dry.connect(healthLP);

    const ui = ctx.createGain();
    ui.gain.value = 0.9;
    ui.connect(limiter);

    // ---- 混响：程序化脉冲响应 ---------------------------------------------
    // 窄巷 = 两面近距离平行硬墙 → 密集 flutter echo。所以早期反射多、间隔小、
    // 整体很短（0.45s）。这比一条长混响更能读出「我在一条窄巷里」。
    // normalize=true 是必须的：一条 0.45s 噪声 IR 做原始卷积会累积出 +20dB 左右的
    // 增益（输出 RMS ≈ IR_RMS × √有效长度）。交给浏览器做功率补偿，湿量由下面的
    // wet gain 单独控制，这样 alley / room 两条混响的相对响度才可控。
    const alley = ctx.createConvolver();
    alley.normalize = true;
    alley.buffer = this.makeImpulse(ctx, 0.45, 11, 14, 0.009, 0.62, 0.28, 1337);
    const alleyWet = ctx.createGain();
    alleyWet.gain.value = 0.55;
    alley.connect(alleyWet);
    alleyWet.connect(healthLP);

    const room = ctx.createConvolver();
    room.normalize = true;
    room.buffer = this.makeImpulse(ctx, 1.25, 4.0, 8, 0.022, 0.88, 0.5, 90210);
    const roomWet = ctx.createGain();
    roomWet.gain.value = 0.5;
    room.connect(roomWet);
    roomWet.connect(healthLP);

    // ---- 耳鸣（常驻，平时增益 0）------------------------------------------
    const tinGain = ctx.createGain();
    tinGain.gain.value = 0;
    tinGain.connect(limiter);
    const tinA = ctx.createOscillator();
    tinA.type = 'sine';
    tinA.frequency.value = 4200;
    tinA.connect(tinGain);
    tinA.start();
    const tinB = ctx.createOscillator();
    tinB.type = 'sine';
    tinB.frequency.value = 6350;
    const tinBGain = ctx.createGain();
    tinBGain.gain.value = 0.35;
    tinB.connect(tinBGain);
    tinBGain.connect(tinGain);
    tinB.start();

    // ---- 预生成噪声缓冲（init 期一次性，绝不在开火时生成）------------------
    const white: AudioBuffer[] = [];
    for (let i = 0; i < WHITE_COUNT; i++) white.push(this.makeNoise(ctx, WHITE_SEC, 1, 7717 + i * 131));
    const tails: AudioBuffer[] = [];
    for (let i = 0; i < TAIL_COUNT; i++) tails.push(this.makeNoise(ctx, TAIL_SEC, 2, 4211 + i * 977));

    this.g = {
      ctx,
      dry,
      ui,
      healthLP,
      limiter,
      master,
      alley,
      alleyWet,
      room,
      roomWet,
      tinA,
      tinB,
      tinGain,
      white,
      tails,
      satCurve: makeSatCurve(2048, 2.2),
    };
    this.appliedVolume = feelConfig.audio.masterVolume;
    this.appliedLowHealth = feelConfig.audio.lowHealthFilter;

    // 把 init 之前调用过的 setHealthRatio 补上
    this.applyHealth(this.g);

    void ctx.resume();
  }

  get ready(): boolean {
    return this.g !== null && this.g.ctx.state === 'running';
  }

  // -------------------------------------------------------------------------
  // 枪声 —— 四层随机重组
  // -------------------------------------------------------------------------

  /**
   * @param envReverb 环境混响量 0..1。窄巷 0.6~0.8，开阔处 0.25。默认 0.55。
   */
  gunshot(def: WeaponAudioDef, envReverb = 0.55): void {
    const g = this.begin();
    if (!g) return;

    const A = feelConfig.audio;
    // feelConfig.master 关闭 = 打击感 A/B 对照组。全静音会让对照失去参照，
    // 所以这里只剥掉 sub/mech/tail 和混响，留干爆响 —— 正好演示「四层叠加」的差别。
    const bare = !feelConfig.master;
    const send = bare ? 0 : clamp01(envReverb);

    const t0 = g.ctx.currentTime + 0.001; // 1ms 前瞻，保证参数自动化落在未来
    const v = this.newVoice();

    const bi = this.pick(BODY_VARIANTS.length, this.lastBody);
    const si = this.pick(SUB_VARIANTS.length, this.lastSub);
    const mi = this.pick(MECH_VARIANTS.length, this.lastMech);
    const ti = this.pick(TAIL_VARIANTS.length, this.lastTail);
    this.lastBody = bi;
    this.lastSub = si;
    this.lastMech = mi;
    this.lastTail = ti;

    const fJit = 1 + randSigned() * 0.08; // ±8% 频率微扰
    const dJit = 1 + randSigned() * 0.15; // ±15% 时长抖动

    // ---- 1. Body / Transient ----------------------------------------------
    if (A.layerBody) {
      const P = BODY_VARIANTS[bi];
      const f = Math.max(30, def.bodyFreq * P.freqMul * fJit);
      const dur = Math.max(0.02, def.bodyDecay * P.decayMul * dJit);

      this.burst(g, v, t0, {
        buf: g.white[bi % g.white.length],
        type: 'lowpass',
        freq: f,
        q: P.q,
        rate: P.rate * (1 + randSigned() * 0.06),
        attack: 0.0006,
        decay: dur,
        level: P.level,
        drive: P.drive,
        sweepFrom: P.startMul,
        sweepTo: P.endMul,
        sweepRatio: 0.4,
        peakDb: P.peakDb,
        send: send * P.send,
      });

      // 「撕裂」瞬态：第一毫秒的高频炸裂。没有它枪声只有闷响没有锐度。
      this.burst(g, v, t0, {
        type: 'highpass',
        freq: P.crackHz * fJit,
        q: 0.8,
        attack: 0.0004,
        decay: 0.028 * dJit,
        level: P.crack,
        send: send * 0.5,
      });
    }

    // ---- 2. Sub / LFE ------------------------------------------------------
    if (A.layerSub && !bare) {
      const S = SUB_VARIANTS[si];
      const f = Math.max(20, def.subFreq * fJit);
      const dur = Math.max(0.04, def.subDecay * S.decayMul * dJit);
      this.tone(g, v, t0, {
        type: S.type,
        f0: f * S.startMul,
        f1: f * S.endMul,
        glide: dur * S.glideRatio,
        attack: 0.001,
        decay: dur,
        level: S.level,
        lp: S.lp,
        send: send * 0.25,
      });
    }

    // ---- 3. Mechanical -----------------------------------------------------
    if (A.layerMech && !bare) {
      const M = MECH_VARIANTS[mi];
      // mechBright ∈ [0,1] → 频率倍率 [0.6, 1.4]
      const bright = 0.6 + clamp01(def.mechBright) * 0.8;
      for (const c of M.clicks) {
        this.burst(g, v, t0, {
          type: 'bandpass',
          freq: c.f * bright * fJit,
          q: c.q,
          attack: 0.0005,
          decay: c.decay * dJit,
          level: c.level * 0.3,
          delay: c.at * (1 + randSigned() * 0.2),
          send: send * 0.15,
        });
      }
      if (M.ring) {
        this.tone(g, v, t0, {
          type: 'triangle',
          f0: M.ring.f * bright * fJit,
          f1: M.ring.f * bright * fJit * 0.94,
          glide: M.ring.decay,
          attack: 0.0008,
          decay: M.ring.decay,
          level: M.ring.level * 0.3,
          delay: M.ring.at,
          send: send * 0.4,
        });
      }
    }

    // ---- 4. Tail -----------------------------------------------------------
    if (A.layerTail && !bare) {
      const T = TAIL_VARIANTS[ti];
      const dur = Math.max(0.08, def.tailDecay * T.decayMul * dJit);
      this.burst(g, v, t0, {
        buf: g.tails[ti % g.tails.length],
        type: 'bandpass',
        freq: T.f * fJit,
        q: T.q,
        rate: T.rate,
        attack: 0.018,
        decay: dur,
        level: T.level,
        delay: T.pre,
        send: send * T.send,
      });
    }

    // 极端情况：所有层都被关掉 → Voice 里没有 source，onended 永不触发，手动回收
    if (v.stopAt === 0) v.dispose();
  }

  // -------------------------------------------------------------------------
  // 弹着
  // -------------------------------------------------------------------------

  /**
   * 弹着音。音高/衰减来自 SURFACES 表的 impactTone / impactDecay。
   * distance 做音量衰减 + 高频滚降（空气吸收）+ 一点声速延迟。
   */
  impact(surface: SurfaceKind, distance: number): void {
    const g = this.begin();
    if (!g) return;

    const S = surfaceOf(surface);
    const d = Math.max(0, distance);
    const vol = 1 / (1 + d / 16); // 16m 处半音量
    if (vol < 0.03) return; // 太远，不值得为它建节点
    const air = clamp(19000 - d * 620, 800, 19000); // 空气吸收：远处只剩闷响
    // 真实声速延迟是 d/343，但 >60ms 的反馈延迟会让打击感发散（击中与听到脱节），
    // 所以封顶 60ms：近距离物理正确，远距离牺牲真实换手感。
    const t0 = g.ctx.currentTime + 0.001 + Math.min(d / 343, 0.06);

    const v = this.newVoice();
    const fJit = 1 + randSigned() * 0.09;
    const dJit = 1 + randSigned() * 0.18;
    const tone = S.impactTone * fJit;
    const dec = S.impactDecay * dJit;
    const send = feelConfig.master ? 0.55 : 0;

    switch (surface) {
      case 'metal': {
        // 尖锐的「铛」：高 Q 带通噪声 + 金属余振
        this.burst(g, v, t0, { type: 'bandpass', freq: tone, q: 4.5, attack: 0.0004, decay: dec * 0.45, level: 0.75 * vol, lp: air, send: send * 0.8 });
        this.tone(g, v, t0, { type: 'triangle', f0: tone * 1.01, f1: tone * 0.97, glide: dec, attack: 0.0008, decay: dec, level: 0.35 * vol, lp: air, send: send * 1.1 });
        this.tone(g, v, t0, { type: 'sine', f0: tone * 2.41, f1: tone * 2.33, glide: dec * 0.7, attack: 0.001, decay: dec * 0.7, level: 0.18 * vol, lp: air, delay: 0.004, send: send });
        // 跳弹尾音：快速下滑的正弦。不是每次都有，否则会变成动画片。
        if (Math.random() < 0.65) {
          const ric = tone * (1.1 + Math.random() * 0.7);
          // glide 必须 ≤ decay，否则振荡器先停、下滑扫到一半被切掉 ——「piu」就没了
          const glide = 0.24 + Math.random() * 0.2;
          this.tone(g, v, t0, {
            type: 'sine',
            f0: ric,
            f1: ric * (0.22 + Math.random() * 0.14),
            glide,
            attack: 0.004,
            decay: glide * 1.15,
            level: 0.13 * vol,
            lp: air,
            delay: 0.012,
            send: send * 1.4,
          });
        }
        break;
      }
      case 'glass': {
        this.burst(g, v, t0, { type: 'highpass', freq: tone * 0.7, q: 0.8, attack: 0.0004, decay: dec * 0.5, level: 0.6 * vol, lp: air, send: send * 0.9 });
        // 碎片叮当：几个随机高频三角波
        for (let i = 0; i < 3; i++) {
          this.tone(g, v, t0, {
            type: 'triangle',
            f0: 2000 + Math.random() * 3200,
            attack: 0.001,
            decay: 0.05 + Math.random() * 0.09,
            level: (0.13 - i * 0.03) * vol,
            lp: air,
            delay: 0.006 + Math.random() * 0.06,
            send: send * 1.2,
          });
        }
        break;
      }
      case 'flesh': {
        // 湿闷的低频 thud —— 没有任何高频亮点，这是「打中人」和「打中墙」最关键的区别
        this.tone(g, v, t0, { type: 'sine', f0: tone * 1.6, f1: tone * 0.55, glide: 0.05, attack: 0.001, decay: dec * 2.6, level: 0.85 * vol, lp: Math.min(air, 600), send: send * 0.25 });
        this.burst(g, v, t0, { type: 'lowpass', freq: 340 * fJit, q: 1.2, attack: 0.0008, decay: dec * 2.0, level: 0.5 * vol, lp: Math.min(air, 1400), send: send * 0.3 });
        // 极轻的一点「噗」，只为标记命中瞬间
        this.burst(g, v, t0, { type: 'bandpass', freq: 1500, q: 1.0, attack: 0.0004, decay: 0.018, level: 0.14 * vol, lp: air, send: 0 });
        break;
      }
      case 'wood': {
        this.burst(g, v, t0, { type: 'lowpass', freq: tone * 3.2, q: 1.4, attack: 0.0005, decay: dec * 1.8, level: 0.62 * vol, lp: air, peakDb: 8, sweepFrom: 9, sweepTo: 2.2, sweepRatio: 0.5, send: send * 0.7 });
        // 木板空腔的短促共鸣
        this.tone(g, v, t0, { type: 'triangle', f0: tone * 2.4, f1: tone * 2.2, glide: dec * 2, attack: 0.001, decay: dec * 2, level: 0.16 * vol, lp: air, send: send * 0.8 });
        break;
      }
      case 'dirt': {
        this.burst(g, v, t0, { type: 'lowpass', freq: tone * 4, q: 0.9, attack: 0.0008, decay: dec * 2.4, level: 0.55 * vol, lp: Math.min(air, 900), send: send * 0.5 });
        break;
      }
      default: {
        // concrete / brick：干脆的「啪」+ 墙体质量感的低频 + 粉尘细碎高频
        this.burst(g, v, t0, { type: 'bandpass', freq: tone, q: 1.6, attack: 0.0004, decay: dec, level: 0.7 * vol, lp: air, sweepFrom: 7, sweepTo: 1.0, sweepRatio: 0.35, send: send });
        this.tone(g, v, t0, { type: 'sine', f0: 120, f1: 74, glide: 0.05, attack: 0.001, decay: dec * 1.3, level: 0.3 * vol, lp: 300, send: send * 0.3 });
        this.burst(g, v, t0, { type: 'highpass', freq: 4200, q: 0.7, attack: 0.0006, decay: 0.05 * dJit, level: 0.2 * vol, lp: air, send: send * 0.9 });
        break;
      }
    }

    if (v.stopAt === 0) v.dispose();
  }

  // -------------------------------------------------------------------------
  // 反馈音
  // -------------------------------------------------------------------------

  /**
   * hitmarker 的听觉对应物：极短促的 click。
   * 走 ui 总线 —— 它不是场景里的声音，濒死时也必须听得清，所以绕过低血量低通。
   */
  hitTick(headshot: boolean): void {
    const g = this.begin();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.001;
    const v = this.newVoice();
    const j = 1 + randSigned() * 0.05;

    if (headshot) {
      // 高一个八度 + 两个不谐和分音 → 轻微金属感
      this.burst(g, v, t0, { type: 'bandpass', freq: 3500 * j, q: 3.4, attack: 0.0004, decay: 0.032, level: 0.55, bus: 'ui' });
      this.tone(g, v, t0, { type: 'triangle', f0: 2300 * j, attack: 0.0008, decay: 0.085, level: 0.2, bus: 'ui' });
      this.tone(g, v, t0, { type: 'triangle', f0: 3455 * j, attack: 0.0008, decay: 0.06, level: 0.13, bus: 'ui', delay: 0.002 });
    } else {
      this.burst(g, v, t0, { type: 'bandpass', freq: 1750 * j, q: 2.2, attack: 0.0004, decay: 0.028, level: 0.5, bus: 'ui' });
      this.tone(g, v, t0, { type: 'sine', f0: 1150 * j, f1: 900 * j, glide: 0.03, attack: 0.0006, decay: 0.035, level: 0.22, bus: 'ui' });
    }
    if (v.stopAt === 0) v.dispose();
  }

  /** 击杀确认：低沉的 thud + 一段留白用的长混响。 */
  killTone(): void {
    const g = this.begin();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.001;
    const v = this.newVoice();
    const j = 1 + randSigned() * 0.06;
    const send = feelConfig.master ? 1 : 0;

    this.tone(g, v, t0, { type: 'sine', f0: 96 * j, f1: 46 * j, glide: 0.22, attack: 0.002, decay: 0.55, level: 0.85, lp: 260, send: send * 0.9, rev: 'room' });
    this.burst(g, v, t0, { type: 'lowpass', freq: 230 * j, q: 0.8, attack: 0.012, decay: 0.36, level: 0.24, send: send * 0.7, rev: 'room' });
    // 一记干脆的 clack 标记「就是这一发」的瞬间，否则纯低频读不出时机
    this.burst(g, v, t0, { type: 'bandpass', freq: 2600 * j, q: 2.4, attack: 0.0004, decay: 0.032, level: 0.26, send: send * 0.5, rev: 'room' });
    if (v.stopAt === 0) v.dispose();
  }

  /** 换弹三段。eject 中频咔 / insert 闷响带轻金属 / bolt 最亮最脆。 */
  reloadClick(stage: 'eject' | 'insert' | 'bolt'): void {
    const g = this.begin();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.001;
    const v = this.newVoice();
    const j = 1 + randSigned() * 0.07;
    const send = feelConfig.master ? 0.45 : 0;

    switch (stage) {
      case 'eject':
        // 退匣：卡笋弹开的中频咔 + 弹匣脱出的轻微金属刮擦
        this.burst(g, v, t0, { type: 'bandpass', freq: 900 * j, q: 2.6, attack: 0.0005, decay: 0.05, level: 0.5, send: send });
        this.tone(g, v, t0, { type: 'triangle', f0: 1420 * j, f1: 1350 * j, glide: 0.06, attack: 0.001, decay: 0.06, level: 0.16, send: send });
        this.burst(g, v, t0, { type: 'highpass', freq: 3600, q: 0.7, attack: 0.004, decay: 0.07, level: 0.09, delay: 0.02, send: send });
        break;
      case 'insert':
        // 插匣：闷响为主（弹匣撞进井里），只带一点点金属回响
        this.burst(g, v, t0, { type: 'lowpass', freq: 260 * j, q: 1.5, attack: 0.0008, decay: 0.095, level: 0.6, send: send });
        this.tone(g, v, t0, { type: 'sine', f0: 150 * j, f1: 92 * j, glide: 0.05, attack: 0.001, decay: 0.11, level: 0.3, lp: 320, send: send * 0.4 });
        this.tone(g, v, t0, { type: 'triangle', f0: 720 * j, attack: 0.001, decay: 0.055, level: 0.12, delay: 0.004, send: send });
        break;
      case 'bolt':
      default:
        // 拉栓到位：最亮最脆的一下 + 复进簧的短促 zing
        this.burst(g, v, t0, { type: 'highpass', freq: 3200 * j, q: 0.9, attack: 0.0003, decay: 0.04, level: 0.62, send: send * 1.2 });
        this.tone(g, v, t0, { type: 'triangle', f0: 5200 * j, attack: 0.0006, decay: 0.045, level: 0.16, send: send });
        this.tone(g, v, t0, { type: 'triangle', f0: 7400 * j, attack: 0.0006, decay: 0.03, level: 0.09, send: send });
        this.tone(g, v, t0, { type: 'sine', f0: 4100 * j, f1: 2600 * j, glide: 0.06, attack: 0.002, decay: 0.07, level: 0.08, delay: 0.008, send: send });
        break;
    }
    if (v.stopAt === 0) v.dispose();
  }

  /** 脚步。按 FOOTSTEP 表换音色，音量刻意压低（自己的脚步不该抢戏）。 */
  footstep(surface: SurfaceKind): void {
    const g = this.begin();
    if (!g) return;
    const F = FOOTSTEP[surface] ?? FOOTSTEP.concrete;
    const t0 = g.ctx.currentTime + 0.001;
    const v = this.newVoice();
    const j = 1 + randSigned() * 0.12; // 脚步的音高抖动比枪声大，连续走路才不像节拍器
    const send = feelConfig.master ? 0.4 : 0;

    this.burst(g, v, t0, { type: 'bandpass', freq: F.freq * j, q: F.q, attack: 0.001, decay: F.decay * (1 + randSigned() * 0.2), level: F.level * 0.75, send: send });
    if (F.scuff > 0) {
      this.burst(g, v, t0, { type: 'highpass', freq: 3800, q: 0.7, attack: 0.006, decay: 0.06, level: F.scuff * 0.75, delay: 0.008, send: send * 0.8 });
    }
    if (F.ring > 0) {
      this.tone(g, v, t0, { type: 'triangle', f0: F.ring * j, f1: F.ring * j * 0.96, glide: F.decay * 1.5, attack: 0.002, decay: F.decay * 1.5, level: 0.09, delay: 0.003, send: send });
    }
    if (v.stopAt === 0) v.dispose();
  }

  /** 玩家受击：闷重的一下 + 短促高频耳鸣闪（与 setHealthRatio 的持续耳鸣叠加） */
  hurt(): void {
    const g = this.begin();
    if (!g) return;
    const t0 = g.ctx.currentTime + 0.001;
    const v = this.newVoice();
    const j = 1 + randSigned() * 0.1;
    const send = feelConfig.master ? 0.4 : 0;

    this.tone(g, v, t0, { type: 'sine', f0: 168 * j, f1: 68 * j, glide: 0.09, attack: 0.001, decay: 0.2, level: 0.8, lp: 280, send: send * 0.3 });
    this.burst(g, v, t0, { type: 'bandpass', freq: 430 * j, q: 1.1, attack: 0.0008, decay: 0.13, level: 0.45, send: send });
    this.burst(g, v, t0, { type: 'highpass', freq: 3000, q: 0.7, attack: 0.0004, decay: 0.022, level: 0.22, send: send * 0.6 });
    // 一闪而过的高频嗡 —— 冲击波的听觉暗示
    this.tone(g, v, t0, { type: 'sine', f0: 3900 * j, attack: 0.004, decay: 0.45, level: 0.05, send: 0 });
    if (v.stopAt === 0) v.dispose();
  }

  // -------------------------------------------------------------------------
  // 全局状态
  // -------------------------------------------------------------------------

  /**
   * 低血量处理：整条 dry 链加低通（世界变闷）+ 常驻高频耳鸣（越低越响）。
   * 受 feelConfig.audio.lowHealthFilter 控制；关掉时立刻恢复通透。
   * init() 之前调用也安全 —— 状态会缓存，init 时补上。
   */
  setHealthRatio(r: number): void {
    this.health = clamp01(r);
    const g = this.g;
    if (g) this.applyHealth(g);
  }

  /** 写进 feelConfig.audio.masterVolume，与 devpanel 同源，避免两套音量互相打架。 */
  setMasterVolume(v: number): void {
    feelConfig.audio.masterVolume = clamp01(v);
    const g = this.g;
    if (g) this.applyMaster(g);
  }

  // -------------------------------------------------------------------------
  // 内部：每次发声前的公共处理
  // -------------------------------------------------------------------------

  private begin(): AudioGraph | null {
    const g = this.g;
    if (!g) return null;
    if (!feelConfig.audio.enabled) return null;
    if (g.ctx.state !== 'running') {
      // 被浏览器挂起（切标签页/自动播放策略）。尝试恢复，本次静默跳过：
      // 挂起时 currentTime 不前进，硬调度会把一堆声音压在同一时刻爆掉。
      void g.ctx.resume();
      return null;
    }
    // devpanel 直接改 feelConfig，没有回调，所以在这里轮询同步
    if (feelConfig.audio.masterVolume !== this.appliedVolume) this.applyMaster(g);
    if (feelConfig.audio.lowHealthFilter !== this.appliedLowHealth) this.applyHealth(g);
    this.sweep(g);
    return g;
  }

  private applyMaster(g: AudioGraph): void {
    const vol = clamp01(feelConfig.audio.masterVolume);
    this.appliedVolume = feelConfig.audio.masterVolume;
    g.master.gain.setTargetAtTime(vol, g.ctx.currentTime, 0.02);
  }

  private applyHealth(g: AudioGraph): void {
    const on = feelConfig.audio.lowHealthFilter;
    this.appliedLowHealth = on;
    const t = g.ctx.currentTime;

    // hp ≥ 60% 完全通透；越低越闷，下限 700Hz
    const k = on ? clamp01(this.health / 0.6) : 1;
    const cut = 700 * Math.pow(19000 / 700, k);
    g.healthLP.frequency.setTargetAtTime(cut, t, 0.25);

    // hp < 45% 开始耳鸣，指数曲线让「快死了」那一段涨得更凶
    const ring = on ? Math.pow(clamp01((0.45 - this.health) / 0.45), 1.4) * 0.06 : 0;
    g.tinGain.gain.setTargetAtTime(ring, t, 0.35);
    // 越虚弱耳鸣越尖 —— 生理上不准确，但读起来更难受，这里要的就是难受
    g.tinA.frequency.setTargetAtTime(4200 + (1 - this.health) * 1400, t, 0.6);
    g.tinB.frequency.setTargetAtTime(6350 + (1 - this.health) * 900, t, 0.6);
  }

  // -------------------------------------------------------------------------
  // 内部：Voice 池管理
  // -------------------------------------------------------------------------

  private newVoice(): Voice {
    const v = new Voice(this.releaseVoice);
    v.idx = this.voices.length;
    this.voices.push(v);
    return v;
  }

  private readonly releaseVoice = (v: Voice): void => {
    const i = v.idx;
    if (i < 0 || i >= this.voices.length || this.voices[i] !== v) return;
    const last = this.voices.pop();
    if (last && last !== v) {
      this.voices[i] = last;
      last.idx = i;
    }
    v.idx = -1;
  };

  /**
   * 兜底清扫。正常情况 onended 就把节点回收干净了，但：
   *  · 某些浏览器在页面失焦时会漏掉 onended；
   *  · 极端射速下也可能堆积。
   * 这里按 AudioContext 时钟清掉已经确定播完的 Voice，并保一道硬上限。
   */
  private sweep(g: AudioGraph): void {
    const now = g.ctx.currentTime;
    if (now - this.lastSweep < 0.25 && this.voices.length <= MAX_VOICES) return;
    this.lastSweep = now;

    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.stopAt > 0 && now > v.stopAt + 0.25) v.dispose();
    }

    if (this.voices.length > MAX_VOICES) {
      // 应急阀：按计划结束时间排序，掐掉最早的那批（听感上是最老的尾音被截断）
      const doomed = this.voices.slice().sort((a, b) => a.stopAt - b.stopAt);
      const n = this.voices.length - MAX_VOICES;
      for (let i = 0; i < n; i++) doomed[i].dispose();
    }
  }

  /** 从 count 个变体里挑一个，保证与 last 不同 —— 连发时听不出「同一颗声音」。 */
  private pick(count: number, last: number): number {
    if (count <= 1) return 0;
    let i = Math.min(count - 1, Math.floor(Math.random() * count));
    if (i === last) i = (last + 1 + Math.floor(Math.random() * (count - 1))) % count;
    return i;
  }

  // -------------------------------------------------------------------------
  // 内部：两个合成原语
  // -------------------------------------------------------------------------

  /** 噪声爆冲：source → [waveshaper] → filter → [peak] → [空气低通] → gain → 总线 */
  private burst(g: AudioGraph, v: Voice, base: number, o: BurstOpts): void {
    const ctx = g.ctx;
    const t0 = base + (o.delay ?? 0);
    const buf = o.buf ?? g.white[Math.floor(Math.random() * g.white.length)];
    const rate = o.rate ?? 1;
    const attack = o.attack ?? 0.0005;
    const need = (attack + o.decay) * rate + 0.05;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;

    let head: AudioNode = src;

    if (o.drive) {
      const ws = v.add(ctx.createWaveShaper());
      ws.curve = g.satCurve;
      ws.oversample = '2x';
      head.connect(ws);
      head = ws;
    }

    const filt = v.add(ctx.createBiquadFilter());
    filt.type = o.type ?? 'bandpass';
    filt.Q.value = o.q ?? 1;
    if (o.sweepFrom !== undefined && o.sweepTo !== undefined) {
      // 扫频：开火瞬间明亮，几毫秒内塌到低频。爆响之所以是「爆响」全靠这条曲线。
      const a = clamp(o.freq * o.sweepFrom, 30, 20000);
      const b = clamp(o.freq * o.sweepTo, 30, 20000);
      filt.frequency.setValueAtTime(a, t0);
      filt.frequency.exponentialRampToValueAtTime(b, t0 + o.decay * (o.sweepRatio ?? 0.4));
    } else {
      filt.frequency.value = clamp(o.freq, 20, 20000);
    }
    head.connect(filt);
    head = filt;

    if (o.peakDb) {
      const pk = v.add(ctx.createBiquadFilter());
      pk.type = 'peaking';
      pk.frequency.value = clamp(o.freq, 20, 20000);
      pk.Q.value = 1.2;
      pk.gain.value = o.peakDb;
      head.connect(pk);
      head = pk;
    }

    if (o.lp !== undefined && o.lp < 18000) {
      const air = v.add(ctx.createBiquadFilter());
      air.type = 'lowpass';
      air.frequency.value = clamp(o.lp, 200, 20000);
      air.Q.value = 0.7;
      head.connect(air);
      head = air;
    }

    const gain = v.add(ctx.createGain());
    const end = envelope(gain.gain, t0, o.level, attack, o.decay);
    head.connect(gain);
    this.route(g, v, gain, o.send ?? 0, o.bus ?? 'dry', o.rev ?? 'alley');

    // 随机偏移取样 —— 同一条噪声缓冲能出无数种「不同的噪声」
    const maxOff = Math.max(0, buf.duration - need);
    v.play(src, t0, end, Math.random() * maxOff);
  }

  /** 正弦/三角波音：osc → [低通] → gain → 总线。滑音用指数 ramp。 */
  private tone(g: AudioGraph, v: Voice, base: number, o: ToneOpts): void {
    const ctx = g.ctx;
    const t0 = base + (o.delay ?? 0);
    const attack = o.attack ?? 0.001;

    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    const f0 = clamp(o.f0, 20, 20000);
    osc.frequency.setValueAtTime(f0, t0);
    if (o.f1 !== undefined) {
      const f1 = clamp(o.f1, 20, 20000);
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + Math.max(0.005, o.glide ?? o.decay));
    }

    let head: AudioNode = osc;
    if (o.lp !== undefined && o.lp < 18000) {
      const lp = v.add(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = clamp(o.lp, 40, 20000);
      lp.Q.value = 0.7;
      head.connect(lp);
      head = lp;
    }

    const gain = v.add(ctx.createGain());
    const end = envelope(gain.gain, t0, o.level, attack, o.decay);
    head.connect(gain);
    this.route(g, v, gain, o.send ?? 0, o.bus ?? 'dry', o.rev ?? 'alley');

    v.play(osc, t0, end);
  }

  /** 接总线 + 可选混响送出。送出增益也归 Voice 所有，随 Voice 一起断开。 */
  private route(g: AudioGraph, v: Voice, node: AudioNode, send: number, bus: Bus, rev: Verb): void {
    node.connect(bus === 'ui' ? g.ui : g.dry);
    if (send > 0.005) {
      const s = v.add(g.ctx.createGain());
      s.gain.value = send;
      node.connect(s);
      s.connect(rev === 'room' ? g.room : g.alley);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：缓冲生成（只在 init 期跑一次）
  // -------------------------------------------------------------------------

  private makeNoise(ctx: AudioContext, seconds: number, channels: number, seed: number): AudioBuffer {
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
    for (let c = 0; c < channels; c++) {
      // 左右用不同 seed → 去相关 → 尾音天然有立体宽度
      const rnd = mulberry32(seed + c * 7919);
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    }
    return buf;
  }

  /**
   * 程序化脉冲响应。
   *
   * 窄巷的听觉特征不是「混响长」，而是两面平行硬墙来回反射形成的 flutter echo：
   * 一串间隔很小、衰减很快的离散回声。所以这里 = 稀疏早期反射（离散 tap）
   * ＋ 指数衰减的扩散噪声底，整体很短。左右声道 tap 交替加权得到宽度。
   *
   * 注意 t=0 处**没有**直达脉冲 —— 干声是单独一路混进去的，这里只出湿声。
   *
   * @param diffuse 扩散噪声底相对早期反射的比例。越小 flutter 越突出（窄巷用小值）。
   */
  private makeImpulse(ctx: AudioContext, seconds: number, decayK: number, taps: number, tapSpread: number, darkness: number, diffuse: number, seed: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, n, sr);
    const rnd = mulberry32(seed);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    // 1) 扩散噪声底（左右不同 seed → 去相关 → 立体宽度）
    for (const d of [L, R]) {
      for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.exp(-(i / sr) * decayK) * diffuse;
    }

    // 2) 早期反射：窄巷两壁来回，间隔小、衰减快 → flutter echo
    for (let k = 0; k < taps; k++) {
      const tSec = tapSpread * (k + 1) * (0.75 + rnd() * 0.5);
      const i = Math.floor(tSec * sr);
      if (i >= n) break;
      const amp = Math.exp(-tSec * decayK * 0.9) * (rnd() < 0.5 ? -1 : 1);
      const evenSide = k % 2 === 0;
      L[i] += amp * (evenSide ? 1 : 0.45);
      R[i] += amp * (evenSide ? 0.45 : 1);
    }

    // 3) 时变一极点低通，最后统一过一遍 —— 这样离散 tap 也会随时间变暗，
    //    否则后期的反射会是刺耳的全频 click（真实墙面每反射一次都吃掉高频）。
    for (const d of [L, R]) {
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0.05, 0.85 - darkness * (i / n) * 0.75);
        lp += (d[i] - lp) * a;
        d[i] = lp;
      }
    }

    // 4) 峰值归一（数值卫生；实际响度由 convolver.normalize + wet gain 控制）
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]);
      const b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    if (peak > 0) {
      const k = 0.9 / peak;
      for (let i = 0; i < n; i++) {
        L[i] *= k;
        R[i] *= k;
      }
    }
    return buf;
  }
}

// ---------------------------------------------------------------------------
// 自由函数
// ---------------------------------------------------------------------------

/**
 * 打击包络：瞬时起音 → 指数衰减 → 收尾拉到 0。
 * 返回建议的 source 停止时刻（多留 10ms 让指数尾巴走完，避免尾部咔嗒）。
 */
function envelope(p: AudioParam, t0: number, peak: number, attack: number, decay: number): number {
  const lvl = Math.max(EPS, peak);
  const a = Math.max(0.0002, attack);
  const dEnd = t0 + a + Math.max(0.005, decay);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(lvl, t0 + a);
  p.exponentialRampToValueAtTime(EPS, dEnd);
  p.linearRampToValueAtTime(0, dEnd + 0.004);
  return dEnd + 0.012;
}

/** 软削波曲线（tanh）。全局共享一份 Float32Array，WaveShaperNode 本身按 Voice 建。 */
function makeSatCurve(n: number, drive: number): SatCurve {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / norm;
  }
  return c;
}

// ---------------------------------------------------------------------------

/** 全局单例。main.ts 在第一次用户手势里调 audio.init()。 */
export const audio = new AudioEngine();

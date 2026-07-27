/**
 * HUD —— 纯 DOM 覆盖层，挂在 #hud 下。
 *
 * 为什么是 DOM 而不是 canvas：HUD 每帧只改几个 transform/opacity，
 * 交给合成器比每帧重画一遍 2D canvas 便宜得多，而且改样式不用重编译。
 * 样式由本文件注入一个 <style>，不依赖任何外部 CSS 文件。
 *
 * 时钟纪律：update(dt) 的 dt 必须是 time.unscaledDelta。
 * HUD 是玩家读战况的界面，hit-stop / 慢镜期间它必须照常走，
 * 否则「定帧」会被读成「界面卡死」。
 *
 * 视觉基调：冷灰底 + 暖橙 #ff8a2b 强调，等宽数字，直角，军用仪表感。
 */

import { clamp, clamp01, expApproach, lerp } from '../core/time';
import { feelConfig, feelOn } from '../feel/config';

// ---------------------------------------------------------------------------
// 约定 / 假设（契约没写死的部分，在这里做决定）
// ---------------------------------------------------------------------------

/** 血量、护甲的满值。setHealth 传的是绝对值，条长按这两个数归一化。 */
const MAX_HP = 100;
const MAX_ARMOR = 100;

/**
 * 相机垂直 fov（度）的**兜底值**。准星张开角 → 像素的换算要用它，见 spreadToGap()。
 *
 * ⚠ 不要拿这个常量当真实 fov 用。开镜时 camera.fov 会被变焦改掉，
 * 用写死的 90 去算会让准星张开的像素数和真实弹着散布对不上
 * （玩家会觉得「准星明明套住了却打不中」）。真实值由 setFov() 每帧喂进来。
 */
const FALLBACK_FOV_DEG = 90;

/** 准星最小间距（像素）—— 散布为 0 时也要留一点，否则四条线糊成一坨。 */
const CH_MIN_GAP = 3.5;
/** 准星最大间距，防止大散布时四条线飞到屏幕外找不到 */
const CH_MAX_GAP = 96;
/** 准星线长（站立）/ ADS 时收短 */
const CH_LEN = 7;
const CH_LEN_ADS = 4;

/** 弹药低于此比例开始橙色闪烁 */
const LOW_AMMO_RATIO = 0.3;
/** 血量低于此比例开始红色闪烁 + 屏幕暗角 */
const LOW_HP_RATIO = 0.3;

/** 方向性受击弧的淡出时长（秒） */
const HURT_ARC_LIFE = 0.8;
/** 同时最多几道受击弧（池化，够用且不会撞车） */
const HURT_ARC_POOL = 4;

/** 击杀 hitmarker 的时长倍率 —— hitmarkerMs(70ms) 太短，红 ✕ 的 punch 读不出来 */
const KILL_MARKER_MUL = 3.5;
const KILL_MARKER_MIN_MS = 220;


const STYLE_ID = 'bs-hud-style';

// ---------------------------------------------------------------------------
// 样式（一次性注入）
// ---------------------------------------------------------------------------

const CSS = `
.bs-hud {
  position: absolute; inset: 0; pointer-events: none;
  font-family: "Bahnschrift", "Segoe UI", system-ui, sans-serif;
  color: #dee1e6;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.bs-hud .mono { font-family: Consolas, "SFMono-Regular", monospace; }
.bs-hud .num { font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }

/* ---- 屏幕中心锚点：准星 / hitmarker 都挂这里 ---- */
.bs-center { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }

.bs-ch {
  position: absolute; left: 0; top: 0;
  background: #eef1f5;
  box-shadow: 0 0 2px rgba(0,0,0,0.95), 0 0 1px rgba(0,0,0,0.9);
  will-change: transform;
}
.bs-ch-dot {
  position: absolute; left: 0; top: 0; width: 2px; height: 2px;
  background: #ff8a2b;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 3px rgba(0,0,0,0.9);
}

.bs-hm {
  position: absolute; left: 0; top: 0;
  height: 2px; width: 9px;
  background: #ffffff;
  opacity: 0;
  box-shadow: 0 0 3px rgba(0,0,0,0.85);
  will-change: transform, opacity;
}

/* ---- 弹药（右下） ---- */
.bs-ammo {
  position: absolute; right: 34px; bottom: 26px;
  text-align: right; line-height: 1;
}
.bs-ammo .rule { height: 1px; background: rgba(222,225,230,0.25); margin: 0 0 7px auto; width: 108px; }
.bs-ammo .cur {
  font-size: 46px; font-weight: 600; color: #eef1f5;
  text-shadow: 0 2px 6px rgba(0,0,0,0.75);
}
.bs-ammo .res {
  font-size: 13px; color: #8b939e; margin-top: 5px;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.bs-ammo .res b { color: #b6bec8; font-weight: 400; }
.bs-ammo .warn {
  font-size: 11px; letter-spacing: 0.22em; color: #ff8a2b;
  margin-top: 5px; text-transform: uppercase; visibility: hidden;
}
.bs-ammo.low .cur { color: #ff8a2b; }
.bs-ammo.low .rule { background: rgba(255,138,43,0.55); }
.bs-ammo.empty .warn { visibility: visible; }

/* ---- 血量 / 护甲（左下） ---- */
.bs-vit { position: absolute; left: 34px; bottom: 26px; width: 216px; }
.bs-vit .row { display: flex; align-items: center; gap: 9px; margin-top: 8px; }
.bs-vit .tag {
  font-size: 10px; letter-spacing: 0.18em; color: #6f7783; width: 26px;
  text-transform: uppercase;
}
.bs-vit .track {
  position: relative; flex: 1; height: 4px;
  background: rgba(255,255,255,0.09);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,0.55);
  overflow: hidden;
}
.bs-vit .fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
  transform-origin: 0 50%; will-change: transform;
}
.bs-vit .fill.hp { background: linear-gradient(90deg, #b8382c, #e5533a); }
.bs-vit .fill.ar { background: linear-gradient(90deg, #33689e, #5b9dd9); }
.bs-vit .val {
  font-size: 14px; width: 34px; text-align: right; color: #c8ced6;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}
.bs-vit .val.ar { color: #8fb6da; }

/* ---- 调试信息（左上） ---- */
.bs-stats {
  position: absolute; left: 34px; top: 22px;
  font-size: 11.5px; line-height: 1.6; color: #79828e;
  white-space: pre; text-shadow: 0 1px 2px rgba(0,0,0,0.9);
}

/* ---- 方向性受击 ---- */
.bs-hurtwrap {
  position: absolute; left: 50%; top: 50%;
  width: 82vmin; height: 82vmin;
  opacity: 0; will-change: transform, opacity;
}
.bs-hurtarc {
  position: absolute; left: 50%; top: 0;
  width: 42vmin; height: 15vmin;
  transform: translateX(-50%);
  background: radial-gradient(ellipse at 50% 0%,
    rgba(236,74,52,0.95) 0%,
    rgba(196,32,18,0.55) 38%,
    rgba(150,14,8,0.0) 74%);
  filter: blur(1.5px);
}

/* ---- 全屏红色暗角脉冲 ---- */
.bs-vig {
  position: absolute; inset: 0; opacity: 0;
  background: radial-gradient(ellipse at 50% 52%,
    rgba(120,0,0,0) 30%,
    rgba(152,20,12,0.5) 74%,
    rgba(74,6,3,0.92) 100%);
  will-change: opacity;
}

`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
}

type MarkerKind = 'normal' | 'head' | 'kill';

interface HurtArc {
  wrap: HTMLDivElement;
  /** 已存活秒数；>= HURT_ARC_LIFE 表示空闲 */
  t: number;
  angleDeg: number;
  active: boolean;
}

// ---------------------------------------------------------------------------

export class Hud {
  private readonly layer: HTMLDivElement;

  // 准星
  private readonly chLines: HTMLDivElement[] = [];
  private readonly chDot: HTMLDivElement;
  private spreadDeg = 0.8;
  /** 平滑后的实际间距（像素）——直接跳变会闪，用指数逼近跟随 */
  private gap = CH_MIN_GAP;
  private adsT = 0;
  /** 当前相机垂直 fov（度）。变焦时必须跟着变，否则准星和真实散布对不上。 */
  private fovDeg = FALLBACK_FOV_DEG;

  // hitmarker
  private readonly hmTicks: HTMLDivElement[] = [];
  private hmKind: MarkerKind = 'normal';
  private hmT = 0;
  private hmLife = 0;
  private hmActive = false;

  // 弹药
  private readonly ammoBox: HTMLDivElement;
  private readonly ammoCur: HTMLDivElement;
  private readonly ammoRes: HTMLDivElement;
  private ammoLow = false;

  // 血量 / 护甲
  private readonly hpFill: HTMLDivElement;
  private readonly arFill: HTMLDivElement;
  private readonly hpVal: HTMLDivElement;
  private readonly arVal: HTMLDivElement;
  private hpRatio = 1;
  private hpLow = false;

  // 受击
  private readonly arcs: HurtArc[] = [];
  private arcCursor = 0;
  private readonly vig: HTMLDivElement;
  /** 受击脉冲强度 0..1，衰减到 0 */
  private hurtPulse = 0;

  // 调试信息
  private readonly stats: HTMLDivElement;
  private statsText = '';

  /** 内部累计时间（秒，unscaled）—— 闪烁相位用 */
  private t = 0;

  constructor(root: HTMLElement) {
    injectStyle();

    this.layer = div('bs-hud', root);

    // --- 准星 + hitmarker ---
    const center = div('bs-center', this.layer);
    for (let i = 0; i < 4; i++) this.chLines.push(div('bs-ch', center));
    this.chDot = div('bs-ch-dot', center);
    for (let i = 0; i < 4; i++) this.hmTicks.push(div('bs-hm', center));

    // --- 弹药 ---
    this.ammoBox = div('bs-ammo', this.layer);
    div('rule', this.ammoBox);
    this.ammoCur = div('cur num', this.ammoBox);
    this.ammoCur.textContent = '30';
    this.ammoRes = div('res mono num', this.ammoBox);
    this.ammoRes.innerHTML = '<b>30</b> / 90';
    const warn = div('warn mono', this.ammoBox);
    warn.textContent = 'reload';

    // --- 血量 / 护甲 ---
    const vit = div('bs-vit', this.layer);
    const hpRow = div('row', vit);
    div('tag mono', hpRow).textContent = 'hp';
    this.hpFill = div('fill hp', div('track', hpRow));
    this.hpVal = div('val mono num', hpRow);
    this.hpVal.textContent = '100';

    const arRow = div('row', vit);
    div('tag mono', arRow).textContent = 'ar';
    this.arFill = div('fill ar', div('track', arRow));
    this.arVal = div('val ar mono num', arRow);
    this.arVal.textContent = '0';

    // --- 受击（弧 + 暗角）---
    this.vig = div('bs-vig', this.layer);
    for (let i = 0; i < HURT_ARC_POOL; i++) {
      const wrap = div('bs-hurtwrap', this.layer);
      div('bs-hurtarc', wrap);
      wrap.style.transform = 'translate(-50%,-50%)';
      this.arcs.push({ wrap, t: HURT_ARC_LIFE, angleDeg: 0, active: false });
    }

    // --- 调试信息 ---
    this.stats = div('bs-stats mono', this.layer);

    this.layoutCrosshair();
  }

  // -------------------------------------------------------------------------
  // 外部接口
  // -------------------------------------------------------------------------

  /** ammo=弹匣内余弹，mag=弹匣容量（算低弹药比例用），reserve=备弹 */
  setAmmo(ammo: number, mag: number, reserve: number): void {
    const a = Math.max(0, Math.round(ammo));
    const m = Math.max(1, Math.round(mag));
    const r = Math.max(0, Math.round(reserve));
    this.ammoCur.textContent = String(a);
    this.ammoRes.innerHTML = '<b>' + m + '</b> / ' + r;
    this.ammoLow = a / m < LOW_AMMO_RATIO;
    this.ammoBox.classList.toggle('low', this.ammoLow);
    this.ammoBox.classList.toggle('empty', a === 0);
    if (!this.ammoLow) this.ammoBox.style.opacity = '';
  }

  setHealth(hp: number, armor: number): void {
    const h = clamp(hp, 0, MAX_HP);
    const a = clamp(armor, 0, MAX_ARMOR);
    this.hpRatio = h / MAX_HP;
    // 用 scaleX 而不是 width：不触发布局，只走合成
    this.hpFill.style.transform = 'scaleX(' + this.hpRatio.toFixed(4) + ')';
    this.arFill.style.transform = 'scaleX(' + (a / MAX_ARMOR).toFixed(4) + ')';
    this.hpVal.textContent = String(Math.ceil(h));
    this.arVal.textContent = String(Math.ceil(a));
    this.hpLow = this.hpRatio < LOW_HP_RATIO;
    if (!this.hpLow) this.hpVal.style.opacity = '';
  }

  /** 准星随散布张开。deg 是散布半角（度），和 WeaponDef.spread* 同一单位。 */
  setSpread(deg: number): void {
    this.spreadDeg = Math.max(0, deg);
  }

  /** ADS 过渡 0..1：准星淡出（改用机瞄），HUD 整体轻微降低不透明度 */
  setADS(t: number): void {
    this.adsT = clamp01(t);
  }

  /**
   * 当前相机垂直 fov（度）。变焦时每帧喂进来 —— 准星张开的像素换算依赖它，
   * 不更新的话开镜后准星会和真实弹着散布对不上。
   */
  setFov(deg: number): void {
    if (deg > 0) this.fovDeg = deg;
  }

  /**
   * 命中反馈。
   * 重入策略：新的 hitmarker 会重置动画，但「击杀」在自己生命前 40% 内不被
   * 普通命中顶掉 —— 否则同一帧的躯干命中会把红 ✕ 抹掉，最重要的反馈反而丢了。
   */
  hitmarker(kind: MarkerKind): void {
    if (!feelOn(feelConfig.ui.hitmarker)) return;
    if (this.hmActive && this.hmKind === 'kill' && kind !== 'kill') {
      if (this.hmT < this.hmLife * 0.4) return;
    }
    this.hmKind = kind;
    this.hmT = 0;
    this.hmActive = true;
    const ms =
      kind === 'kill'
        ? Math.max(KILL_MARKER_MIN_MS, feelConfig.ui.hitmarkerMs * KILL_MARKER_MUL)
        : feelConfig.ui.hitmarkerMs;
    this.hmLife = ms / 1000;
  }

  /**
   * 方向性受击。
   * fromAngleRad 约定：0 = 伤害来自正前方（弧显示在屏幕上方），
   * +π/2 = 来自右侧，±π = 背后（弧在下方），−π/2 = 左侧。
   * 调用方一般用 atan2(dot(dir, cameraRight), dot(dir, cameraForward)) 算。
   */
  hurt(fromAngleRad: number): void {
    if (!feelOn(feelConfig.ui.hurtVignette)) return;
    const arc = this.arcs[this.arcCursor];
    this.arcCursor = (this.arcCursor + 1) % this.arcs.length;
    arc.angleDeg = (fromAngleRad * 180) / Math.PI;
    arc.t = 0;
    arc.active = true;
    this.hurtPulse = 1;
  }

  /** 左上角调试小字（帧率 / 粒子数 / draw call 之类） */
  setStats(text: string): void {
    if (text === this.statsText) return;
    this.statsText = text;
    this.stats.textContent = text;
  }

  /** dt 必须是 time.unscaledDelta —— UI 不吃 hit-stop / 慢镜 */
  update(dt: number): void {
    this.t += dt;

    // --- 整体不透明度：ADS 时压暗，让注意力回到机瞄 ---
    this.layer.style.opacity = lerp(1, 0.72, this.adsT).toFixed(3);

    // --- 准星 ---
    // 红点镜的红点是**枪上的 3D 物体**（跟着枪跳），不是 HUD 元素。
    // 所以 HUD 这边只需要在开镜时把屏幕准星淡出，把瞄准交给红点。
    const targetGap = this.spreadToGap(this.spreadDeg);
    this.gap = lerp(this.gap, targetGap, expApproach(22, dt));
    this.layoutCrosshair();

    // --- hitmarker ---
    this.updateHitmarker(dt);

    // --- 受击弧 + 暗角 ---
    this.updateHurt(dt);

    // --- 低弹药 / 低血量闪烁 ---
    const blink = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * 9));
    if (this.ammoLow) this.ammoBox.style.opacity = blink.toFixed(3);
    if (this.hpLow) this.hpVal.style.opacity = blink.toFixed(3);

    // --- 调试信息可见性 ---
    this.stats.style.display = feelConfig.debug.showStats ? '' : 'none';
  }

  /** 拆掉整个 HUD（M0 用不到，留给热重载/场景切换） */
  destroy(): void {
    this.layer.remove();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 散布半角（度）→ 屏幕像素间距。
   * 屏幕半高对应 fov/2，所以 px = tan(deg) / tan(fov/2) * halfHeight。
   * 这样准星张开的宽度就是弹着散布圈在屏幕上的真实投影，不是随手编的数。
   */
  private spreadToGap(deg: number): number {
    const halfH = window.innerHeight * 0.5;
    // 用当前真实 fov，不是写死的 90 —— 变焦后屏幕每像素对应的角度变了
    const k = Math.tan((deg * Math.PI) / 180) / Math.tan((this.fovDeg * 0.5 * Math.PI) / 180);
    return clamp(CH_MIN_GAP + k * halfH, CH_MIN_GAP, CH_MAX_GAP);
  }

  private layoutCrosshair(): void {
    const len = lerp(CH_LEN, CH_LEN_ADS, this.adsT);
    const g = this.gap;
    const [up, down, left, right] = this.chLines;

    up.style.width = '2px';
    up.style.height = len + 'px';
    up.style.transform = 'translate(-50%,' + (-(g + len)).toFixed(2) + 'px)';

    down.style.width = '2px';
    down.style.height = len + 'px';
    down.style.transform = 'translate(-50%,' + g.toFixed(2) + 'px)';

    left.style.width = len + 'px';
    left.style.height = '2px';
    left.style.transform = 'translate(' + (-(g + len)).toFixed(2) + 'px,-50%)';

    right.style.width = len + 'px';
    right.style.height = '2px';
    right.style.transform = 'translate(' + g.toFixed(2) + 'px,-50%)';

    // ADS 时准星整体淡出（机瞄接管），中心点比线多留一点点
    const a = 1 - this.adsT;
    const op = (a * a).toFixed(3);
    for (const l of this.chLines) l.style.opacity = op;
    this.chDot.style.opacity = op;
  }

  private updateHitmarker(dt: number): void {
    if (!this.hmActive) return;
    this.hmT += dt;
    const p = this.hmT / this.hmLife;
    if (p >= 1) {
      this.hmActive = false;
      for (const t of this.hmTicks) t.style.opacity = '0';
      return;
    }

    const kill = this.hmKind === 'kill';
    const head = this.hmKind === 'head';

    // 弹开再收回：sin(πp) 一个来回
    const swell = Math.sin(p * Math.PI);
    // 击杀是「✕」——四条线交在中心不散开；普通/爆头才向外弹
    const baseOff = kill ? 2 : head ? 7 : 5;
    const amp = kill ? 3 : head ? 8 : 6;
    const off = baseOff + amp * swell;

    const len = kill ? 16 : head ? 12 : 9;
    const thick = kill ? 3 : head ? 2.5 : 2;
    const color = kill ? '#e5533a' : head ? '#ffc069' : '#ffffff';

    // 击杀额外来一发 scale punch：1.4 过冲后回落到 1.0
    let scale = 1;
    if (kill) {
      scale = p < 0.22 ? lerp(0.7, 1.4, p / 0.22) : lerp(1.4, 1.0, ease((p - 0.22) / 0.78));
    }

    const alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;

    for (let i = 0; i < 4; i++) {
      const el = this.hmTicks[i];
      const rot = 45 + i * 90;
      el.style.width = len + 'px';
      el.style.height = thick + 'px';
      el.style.background = color;
      el.style.opacity = alpha.toFixed(3);
      // 注意变换顺序：scale 在最右，所以后面的 translateX 已经被 scale 放大过一次，
      // 不要再乘一遍 scale，否则 punch 会过冲成两倍。
      el.style.transform =
        'translate(-50%,-50%) rotate(' +
        rot +
        'deg) translateX(' +
        off.toFixed(2) +
        'px) scale(' +
        scale.toFixed(3) +
        ')';
    }
  }

  private updateHurt(dt: number): void {
    for (const arc of this.arcs) {
      if (!arc.active) continue;
      arc.t += dt;
      const p = arc.t / HURT_ARC_LIFE;
      if (p >= 1) {
        arc.active = false;
        arc.wrap.style.opacity = '0';
        continue;
      }
      // 起手瞬间到满，然后一路淡出；轻微放大让它「推」出来
      const alpha = p < 0.08 ? p / 0.08 : Math.pow(1 - (p - 0.08) / 0.92, 1.6);
      const s = lerp(0.9, 1.08, ease(p));
      arc.wrap.style.opacity = alpha.toFixed(3);
      arc.wrap.style.transform =
        'translate(-50%,-50%) rotate(' + arc.angleDeg.toFixed(1) + 'deg) scale(' + s.toFixed(3) + ')';
    }

    // 全屏红色暗角：受击脉冲 + 低血量常驻
    if (this.hurtPulse > 0) {
      this.hurtPulse = Math.max(0, this.hurtPulse - dt * 1.8);
    }
    let v = Math.pow(this.hurtPulse, 1.5) * 0.9;
    if (feelOn(feelConfig.ui.hurtVignette) && this.hpRatio < LOW_HP_RATIO) {
      const k = (LOW_HP_RATIO - this.hpRatio) / LOW_HP_RATIO;
      // 低血量时轻微呼吸，别做成刺眼的闪
      v = Math.max(v, k * 0.45 * (0.75 + 0.25 * Math.sin(this.t * 3.2)));
    }
    this.vig.style.opacity = v.toFixed(3);
  }
}

/** smootherstep 收尾用的缓动 */
function ease(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

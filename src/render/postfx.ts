/**
 * 后处理管线 —— 契约 F 节。
 *
 * 管线顺序（顺序即质量）：
 *   RenderPass → Bloom → 色差 → 噪点 → 暗角 → ToneMapping
 *
 * ---------------------------------------------------------------------------
 * 为什么是两个 EffectPass 而不是一个
 * ---------------------------------------------------------------------------
 * postprocessing 的 EffectPass 在 setEffects() 里会按 `attributes` 降序**重排**
 * 传进去的 effect（见 node_modules/postprocessing/build/index.js:setEffects）。
 * ChromaticAberrationEffect 带 EffectAttribute.CONVOLUTION(=2)，其余四个都是
 * NONE(=0)，所以只要把它们塞进同一个 pass，色差就会被顶到 Bloom 前面，
 * 顺序直接被库改掉。
 *
 * 因此拆成两个 pass：
 *   pass A = [Bloom]
 *   pass B = [色差, 噪点, 暗角, ToneMapping]
 * pass B 内部排序后色差仍在最前（sort 是稳定的，其余三个保持原序），
 * 于是最终执行顺序正好等于契约要求的顺序。加上 RenderPass 一共 3 个 pass，
 * 这已经是能保住顺序的最少 pass 数。
 *
 * ---------------------------------------------------------------------------
 * 色彩空间 / 色调映射
 * ---------------------------------------------------------------------------
 * composer 的 RT 用 HalfFloatType，场景以线性 HDR 渲进去；Bloom 的 0.85 阈值
 * 因此是在**未压缩的 HDR 亮度**上做判断，只有枪口火光、曳光弹、路灯灯泡这类
 * 真正超过 1.0 的东西会溢出 —— 这是 bloom 能「克制」的前提。
 * 末端 ToneMappingEffect(ACES_FILMIC) 把 HDR 压回 LDR，最后一个 EffectPass
 * 渲到屏幕时自己做 sRGB 编码。renderer 自身的 ACES 只在旁路路径生效
 * （three 只对默认帧缓冲织入 tone mapping），两条路不会双重映射。
 *
 * ---------------------------------------------------------------------------
 * 双时钟
 * ---------------------------------------------------------------------------
 * 本文件所有 update 全部吃 **unscaledDelta**：后处理是表现层，
 * hit-stop 定帧期间胶片颗粒、ADS 过渡必须照常走，否则定帧读起来像掉帧。
 */

import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  VignetteTechnique,
} from 'postprocessing';

import { clamp01, expApproach, lerp } from '../core/time';
import { feelConfig, feelOn } from '../feel/config';

// ---------------------------------------------------------------------------
// 调参常量
// ---------------------------------------------------------------------------
// 打击感相关的数值一律从 feelConfig.post 读；下面这些是纯画面取向的结构参数，
// 不属于「打击感层」，也不需要在 lil-gui 里逐项暴露，所以留在本文件。

/** MSAA 采样数上限。4x 在 1080p 上几乎看不出和 8x 的差别，但便宜一半。 */
const MSAA_SAMPLES = 4;

/** 亮度阈值的软化宽度。0 会让枪口火光在阈值边缘一帧亮一帧灭，闪得很脏。 */
const BLOOM_SMOOTHING = 0.12;
/** mipmap blur 半径。比默认 0.85 收紧，光晕更贴着光源，不糊成一团。 */
const BLOOM_RADIUS = 0.72;
/** mip 层数。默认 8 会把光晕铺满半个屏幕；6 层扩散范围刚好。 */
const BLOOM_LEVELS = 6;
/** ADS 时 bloom 强度的衰减比例 —— 举枪瞄准时画面要更「干净」。 */
const BLOOM_ADS_DAMP = 0.25;

/**
 * 色差的径向调制起点（uv 距中心 ×2 的距离，0=正中，1.414=角落）。
 * 0.3 意味着中心直径约 30% 屏高的圆内完全无色散 —— 准星和命中区必须清晰，
 * 否则瞄准会被「重影」干扰，那是画面污染不是风格。
 */
const CHROMA_CLEAR_RADIUS = 0.3;
/** 竖直方向的偏移比例。纯水平分离太像故障艺术，带一点倾角更像镜头。 */
const CHROMA_VERTICAL_RATIO = 0.4;
/** ADS 时色差减半（契约要求）。 */
const CHROMA_ADS_DAMP = 0.5;

/** 暗角的衰减起点。0.5 配 darkness 0.35 → 四角约 50% 亮度，中心完全不受影响。 */
const VIGNETTE_OFFSET = 0.5;

/** ADS 过渡的指数逼近刚度。够快（~40ms 到位）不至于拖沓，又能吃掉任何突变。 */
const ADS_STIFFNESS = 24;

// ---------------------------------------------------------------------------

export class PostFX {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;

  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;

  private readonly bloom: BloomEffect;
  private readonly chromatic: ChromaticAberrationEffect;
  private readonly noise: NoiseEffect;
  private readonly vignette: VignetteEffect;
  private readonly toneMapping: ToneMappingEffect;

  private readonly bloomPass: EffectPass;
  private readonly finalPass: EffectPass;

  /**
   * syncConfig() 算出的「基准」强度（已经把各层开关折进去了：关 = 0）。
   * render() 每帧在这个基准上叠加 ADS 调制，两者不会互相覆盖。
   */
  private baseBloomIntensity = 0;
  private baseChromaticOffset = 0;

  /** setADS 写入目标值，render 里平滑逼近，避免调用方给突变量时画面「跳」一下。 */
  private adsTarget = 0;
  private adsCurrent = 0;

  /** master 是主循环直接改的（K 键），没人会替我们调 syncConfig，只能自己盯。 */
  private lastMaster = feelConfig.master;

  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.composer = new EffectComposer(renderer, {
      depthBuffer: true,
      stencilBuffer: false,
      // HDR 缓冲：bloom 阈值要在压缩前的亮度上判断才有意义
      frameBufferType: THREE.HalfFloatType,
      // renderer 关了 antialias，抗锯齿由 composer 的多重采样 RT 承担
      multisampling: Math.min(MSAA_SAMPLES, renderer.capabilities.maxSamples),
    });

    this.renderPass = new RenderPass(scene, camera);

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      luminanceThreshold: feelConfig.post.bloomThreshold,
      luminanceSmoothing: BLOOM_SMOOTHING,
      intensity: feelConfig.post.bloomIntensity,
      radius: BLOOM_RADIUS,
      levels: BLOOM_LEVELS,
    });

    this.chromatic = new ChromaticAberrationEffect({
      // 初值给 0，真正的数值由下面的 syncConfig() 统一写入
      offset: new THREE.Vector2(0, 0),
      radialModulation: true,
      modulationOffset: CHROMA_CLEAR_RADIUS,
    });

    this.noise = new NoiseEffect({ premultiply: false });

    this.vignette = new VignetteEffect({
      technique: VignetteTechnique.DEFAULT,
      offset: VIGNETTE_OFFSET,
      darkness: feelConfig.post.vignetteDarkness,
    });

    // 库在 6.39 里的默认 mode 其实是 AGX（.d.ts 的注释写的 ACES_FILMIC 是过期的），
    // 必须显式指定，否则和旁路路径的 renderer.toneMapping(ACESFilmic) 对不上。
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    this.bloomPass = new EffectPass(camera, this.bloom);
    this.finalPass = new EffectPass(
      camera,
      this.chromatic,
      this.noise,
      this.vignette,
      this.toneMapping
    );

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.finalPass);

    this.syncConfig();
    this.applyAds();
  }

  // -------------------------------------------------------------------------
  // 每帧
  // -------------------------------------------------------------------------

  /**
   * @param dtUnscaled 必须是 time.unscaledDelta —— 后处理不受 hit-stop / 慢镜影响。
   */
  render(dtUnscaled: number): void {
    if (this.disposed) return;

    // K 键直接翻 feelConfig.master，不经过 devpanel 的 onPostChange，
    // 所以这里自己检测一次，保证总开关对后处理也立即生效。
    if (this.lastMaster !== feelConfig.master) {
      this.lastMaster = feelConfig.master;
      this.syncConfig();
    }

    this.adsCurrent = lerp(this.adsCurrent, this.adsTarget, expApproach(ADS_STIFFNESS, dtUnscaled));
    this.applyAds();

    if (!feelConfig.post.enabled) {
      // 旁路：EffectComposer 的构造函数把 renderer.autoClear 关掉了，
      // 这里不手动清就会一帧糊一帧（经典翻车点）。
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // deltaTime 传给 composer 用来推进 EffectMaterial 的 time uniform
    // （噪点的 rand(uv*(1+time)) 靠它逐帧变化）。
    this.composer.render(dtUnscaled);
  }

  resize(w: number, h: number): void {
    if (this.disposed) return;
    // composer.setSize 内部会顺带 renderer.setSize（尺寸没变时会跳过），
    // 再按 drawingBufferSize 重建所有 pass 的内部 RT。
    this.composer.setSize(w, h);
  }

  // -------------------------------------------------------------------------
  // ADS
  // -------------------------------------------------------------------------

  /**
   * @param t 0..1 机瞄过渡量（由 weapon 层每帧传入）。
   * 只记目标值，实际数值在 render() 里指数逼近，所以调用方给阶跃也不会闪。
   */
  setADS(t: number): void {
    this.adsTarget = clamp01(t);
  }

  /** 把当前 ADS 量叠加到基准强度上。基准为 0（该层被关）时结果恒为 0。 */
  private applyAds(): void {
    const ads = this.adsCurrent;

    // 色差减半：机瞄时画面必须最干净，色散会直接干扰读准星
    const chromaMul = 1 - CHROMA_ADS_DAMP * ads;
    const ox = this.baseChromaticOffset * chromaMul;
    this.chromatic.offset.set(ox, ox * CHROMA_VERTICAL_RATIO);

    // 顺带压一点 bloom：举枪时高光少一点，远处敌人轮廓更好读
    this.bloom.intensity = this.baseBloomIntensity * (1 - BLOOM_ADS_DAMP * ads);
  }

  // -------------------------------------------------------------------------
  // 配置同步
  // -------------------------------------------------------------------------

  /**
   * 从 feelConfig.post.* 重新读取全部参数并写进各 Effect。
   * lil-gui 改任何一项后调用即可，**不会重建 pass / 重编译着色器**：
   * 每一层的「禁用」都走「把强度写成 0」这条路，避免运行时 recompile 掉帧。
   *
   * - bloom     : intensity = 0 → 输出乘 0，SCREEN 混合退化成恒等
   * - chromatic : offset = (0,0) → 顶点着色器把 vActive 置 0，三次采样退化成原色
   * - noise     : blendMode.opacity = 0 → 混合权重 0
   * - vignette  : darkness = 0 → smoothstep 全程被 clamp 到 1，衰减因子恒为 1
   * ToneMapping 不给开关：它是保证两条渲染路径亮度一致的地基，不是效果层。
   */
  syncConfig(): void {
    if (this.disposed) return;
    const p = feelConfig.post;

    // 用 feelOn() 而不是裸开关：master 关掉 = 连画面「调味」一起旁路，
    // 这样 K 键的 A/B 才是真的「有打击感 / 没打击感」。
    // （纯结构参数 —— 半径 / mip 层数 / 软化宽度 / 暗角起点 / 色差清晰半径 ——
    //   在构造函数里一次设定，这里不重复写，避免误触发 RT 重建。）
    this.baseBloomIntensity = feelOn(p.bloom) ? p.bloomIntensity : 0;
    this.bloom.luminanceMaterial.threshold = p.bloomThreshold;

    this.baseChromaticOffset = feelOn(p.chromatic) ? p.chromaticOffset : 0;

    this.noise.blendMode.opacity.value = feelOn(p.noise) ? p.noiseOpacity : 0;

    this.vignette.darkness = feelOn(p.vignette) ? p.vignetteDarkness : 0;

    // 基准值变了，立刻把 ADS 调制重新叠一遍，避免这一帧用旧值
    this.applyAds();
  }

  // -------------------------------------------------------------------------

  /** 契约之外的便利方法：热重载 / 切场景时释放 GPU 资源。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composer.dispose();
    // composer.dispose() 会连带 dispose 所有 pass，effect 由 EffectPass 负责
    this.renderer.autoClear = true;
  }
}

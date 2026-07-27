/**
 * 画质预设 —— 三档，覆盖从集显到独显。
 *
 * 实测基线（RTX 5060 Laptop，1920×1080，high 档）：整帧约 2.5ms。
 * 本作是**几何/CPU 受限**而非填充率受限 —— 720p 到 4K 的帧时间几乎不变，
 * 所以降分辨率的收益很小，真正有效的杠杆依次是：
 *   1. 阴影（关掉省 ~12%）
 *   2. 后处理 Bloom（多几个 mip 的模糊）
 *   3. 粒子与贴花上限（影响 draw call 和 CPU 更新）
 * 分辨率缩放放在最后，只在极端情况下才动。
 */

import type * as THREE from 'three';
import { feelConfig } from '../feel/config';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  /** 渲染分辨率倍率，最终 pixelRatio = min(devicePixelRatio, cap) * scale */
  pixelRatioCap: number;
  renderScale: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  chromatic: boolean;
  noise: boolean;
  maxDynamicLights: number;
  maxDecals: number;
}

export const PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    label: '低（集显 / 老机器）',
    pixelRatioCap: 1,
    renderScale: 0.75,
    shadows: false,
    shadowMapSize: 512,
    bloom: false,
    chromatic: false,
    noise: false,
    maxDynamicLights: 2,
    maxDecals: 48,
  },
  medium: {
    label: '中（平衡）',
    pixelRatioCap: 1,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    chromatic: false,
    noise: true,
    maxDynamicLights: 3,
    maxDecals: 128,
  },
  high: {
    label: '高（独显）',
    pixelRatioCap: 2,
    renderScale: 1,
    shadows: true,
    shadowMapSize: 2048,
    bloom: true,
    chromatic: true,
    noise: true,
    maxDynamicLights: 4,
    maxDecals: 256,
  },
};

export interface QualityDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  onResize: (w: number, h: number) => void;
  onPostChange: () => void;
}

export class Quality {
  private current: QualityLevel = 'high';

  constructor(private deps: QualityDeps) {}

  get level(): QualityLevel {
    return this.current;
  }

  get preset(): QualityPreset {
    return PRESETS[this.current];
  }

  apply(level: QualityLevel): void {
    this.current = level;
    const p = PRESETS[level];
    const { renderer, scene } = this.deps;

    // --- 分辨率 ---
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, p.pixelRatioCap) * p.renderScale);

    // --- 阴影 ---
    renderer.shadowMap.enabled = p.shadows;
    scene.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (!l.isDirectionalLight || !l.shadow) return;
      l.castShadow = p.shadows;
      if (p.shadows && l.shadow.mapSize.width !== p.shadowMapSize) {
        l.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
        // 换分辨率必须丢掉旧的 shadow map，否则 three 会继续用旧尺寸的纹理
        l.shadow.map?.dispose();
        l.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
    });
    renderer.shadowMap.needsUpdate = true;

    // --- 后处理 ---
    feelConfig.post.bloom = p.bloom;
    feelConfig.post.chromatic = p.chromatic;
    feelConfig.post.noise = p.noise;

    // --- 特效上限 ---
    feelConfig.vfx.maxDynamicLights = p.maxDynamicLights;
    feelConfig.vfx.maxDecals = p.maxDecals;

    this.resize();
    this.deps.onPostChange();
  }

  /** 窗口尺寸变化时调用；会按当前预设重新算渲染尺寸 */
  resize(): void {
    const { renderer, camera, onResize } = this.deps;
    // 视口尺寸为 0 时（窗口最小化、隐藏的 iframe、无头环境）w/h 会算出 NaN，
    // 一旦写进 camera.aspect 就会污染整个投影矩阵，之后所有屏幕空间计算
    // （伤害数字定位、准星换算）全部变 NaN，且不会自己恢复。兜底成 1。
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this.preset.pixelRatioCap) * this.preset.renderScale
    );
    onResize(w, h);
  }

  /** 按 GPU 名称粗略选一档初始值。用户随时可以在面板里改。 */
  static autoDetect(renderer: THREE.WebGLRenderer): QualityLevel {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return 'medium';
      const name = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).toLowerCase();
      // 独显关键字
      if (/rtx|radeon rx|geforce (gtx )?\d{3,4}|arc a\d/.test(name)) return 'high';
      // 明确的集显
      if (/uhd graphics|hd graphics|iris|vega \d| apple m/.test(name)) return 'medium';
      return 'medium';
    } catch {
      return 'medium';
    }
  }
}

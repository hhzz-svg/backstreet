/**
 * 渲染器 / 相机 —— 契约 F 节。
 *
 * 这里只负责「把管线的地基铺对」，没有任何每帧逻辑，因此不涉及双时钟。
 *
 * 两条渲染路径必须看起来一致（否则 feelConfig.post.enabled 的 A/B 会变成
 * 「亮度对比」而不是「后处理对比」）：
 *
 *   1. 后处理开：EffectComposer 把场景渲进离屏 RT。three 只在渲染到
 *      **默认帧缓冲**（currentRenderTarget === null）时才把 renderer.toneMapping
 *      织进材质着色器，所以走 composer 时 renderer 自己的 ACES 不会生效，
 *      色调映射由 postfx.ts 末端的 ToneMappingEffect(ACES_FILMIC) 负责。
 *   2. 后处理关：直接 renderer.render() 到默认帧缓冲，此时下面设的
 *      ACESFilmicToneMapping 生效。
 *
 * 两条路的 ACES 曲线和 toneMappingExposure 都一致 —— postprocessing 的
 * ToneMappingEffect 内联了 three 的 <tonemapping_pars_fragment>，共用同一个
 * 由 WebGLRenderer 注入的 toneMappingExposure uniform。所以既不会双重
 * tone mapping，也不会两条路亮度对不上。
 */

import * as THREE from 'three';

/** 像素比上限。4K/视网膜屏上 DPR 3 会直接把填充率吃光，2 是性价比拐点。 */
const MAX_PIXEL_RATIO = 2;

/**
 * 腰射基准 FOV（度）。倍镜的放大倍率就是相对这个基准算的
 * （scoped fov = BASE_FOV / weapon.scopeZoom），main.ts 每帧据此调 camera.fov。
 * 导出而不是各处写死 90，是为了「基准 FOV」只有一个真源。
 */
export const BASE_FOV = 90;

/**
 * 主渲染器。
 *
 * 注意：**不**把 canvas 挂进 DOM —— main.ts 自己 appendChild，
 * 这里挂一次会变成职责重叠。只把定位样式设好，保证它铺满视口并且
 * 压在 #hud(z-index:10) / #gate(z-index:50) 下面。
 */
export function createRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    // 后处理开启时场景渲进 composer 的多重采样 RT（见 postfx.ts 的 multisampling），
    // 默认帧缓冲只承接最后一次全屏 blit，再给它开一份 MSAA 是纯浪费带宽。
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
    alpha: false,
    // 不需要读回像素；关掉可以让驱动省一份拷贝
    preserveDrawingBuffer: false,
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // 暗巷靠影子讲空间。
  // 注：three r185 已废弃 PCFSoftShadowMap（内部回退到 PCF 并每帧刷警告），
  // 所以直接用 PCFShadowMap —— 行为一致，且不再刷控制台。
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  renderer.domElement.style.position = 'fixed';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.display = 'block';

  return renderer;
}

/**
 * 第一人称相机。
 *
 * fov 90 是巷战的实用值：巷子只有 8m 宽，视角再窄侧向掩体就完全在画外，
 * 玩家会失去「贴墙」的空间感。
 *
 * rotation.order = 'YXZ' 是 FPS 相机的硬性要求 —— 默认的 XYZ 顺序下，
 * 先绕 X 转再绕 Y 转会让水平转向随俯仰角发生倾斜（万向节歪脖子）。
 * YXZ 保证 yaw 永远绕世界 Y 轴、pitch 永远绕相机自身 X 轴，
 * 而且留出 Z 分量给 lean / trauma 的 roll 用。
 *
 * near 0.05 让枪模贴到脸上也不会被裁掉；far 200 足够罩住 40m 巷子 + 天空盒。
 */
export function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    BASE_FOV,
    window.innerWidth / window.innerHeight,
    0.05,
    200
  );
  camera.rotation.order = 'YXZ';
  camera.name = 'PlayerCamera';
  return camera;
}

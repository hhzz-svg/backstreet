/**
 * 程序化贴图 —— 零外部资源。
 *
 * 全部用 <canvas> 逐像素画出来，返回 THREE.CanvasTexture，模块级缓存：
 * 同一张贴图只生成一次，之后所有材质共享同一个 GPU 纹理。
 *
 * 约定：
 * - 粒子贴图（spark / smoke / flash）RGB 尽量保持接近白色，色相交给
 *   instanceColor 去乘 —— 这样同一张贴图能画出橙火花、白热火花、血雾。
 * - 墙面贴图（concrete / metal / wood）用「可整除的格点噪声」保证无缝平铺，
 *   并设置 wrapS/wrapT = RepeatWrapping。
 * - 所有贴图都是作者按 sRGB 画的，因此 colorSpace = SRGBColorSpace。
 *
 * 本文件不参与每帧更新，没有双时钟问题。
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise';

// ---------------------------------------------------------------------------
// canvas 助手
// ---------------------------------------------------------------------------

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  data: Uint8ClampedArray;
  size: number;
}

function makeSurface(size: number): Surface {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[vfx/textures] 拿不到 2D canvas context');
  const img = ctx.createImageData(size, size);
  return { canvas, ctx, img, data: img.data, size };
}

function commit(s: Surface): HTMLCanvasElement {
  s.ctx.putImageData(s.img, 0, 0);
  return s.canvas;
}

function finish(canvas: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8; // renderer 上传时会按硬件上限自动 clamp
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// 可平铺的 2D 值噪声
//
// core/noise.ts 只提供 1D 噪声（震动用），这里需要 2D 且要能无缝平铺，
// 所以用 mulberry32 生成一张 N×N 的格点表，采样时对 N 取模。
// 只要采样频率是 N 的整数倍，u=1 处就会绕回 u=0，天然无缝。
// ---------------------------------------------------------------------------

const LATTICE = 16;

function makeLattice(seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const a = new Float32Array(LATTICE * LATTICE);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** x/y 单位是「格」，越界自动绕回 → 平铺无缝 */
function lat(l: Float32Array, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const sx = smoothstep(x - xi);
  const sy = smoothstep(y - yi);
  const x0 = ((xi % LATTICE) + LATTICE) % LATTICE;
  const y0 = ((yi % LATTICE) + LATTICE) % LATTICE;
  const x1 = (x0 + 1) % LATTICE;
  const y1 = (y0 + 1) % LATTICE;
  const v00 = l[y0 * LATTICE + x0];
  const v10 = l[y0 * LATTICE + x1];
  const v01 = l[y1 * LATTICE + x0];
  const v11 = l[y1 * LATTICE + x1];
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

/** u,v ∈ [0,1)，octaves 频率按 2 倍递增（都是 LATTICE 的整数倍 → 仍然无缝） */
function fbm2(l: Float32Array, u: number, v: number, octaves: number, freq = 1): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += lat(l, u * LATTICE * f, v * LATTICE * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// 粒子贴图
// ---------------------------------------------------------------------------

let _spark: THREE.Texture | null = null;

/**
 * 火花：细长亮点。中心纯白（过曝核心），边缘暖橙。
 * stretch 模式还会沿速度方向再拉长，这里只负责「细」。
 */
export function sparkTexture(): THREE.Texture {
  if (_spark) return _spark;
  const N = 64;
  const s = makeSurface(N);
  const d = s.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5 - N / 2) / (N / 2);
      const dy = (y + 0.5 - N / 2) / (N / 2);
      // 横向压扁 → 细长
      const r = Math.sqrt((dx / 0.30) * (dx / 0.30) + dy * dy);
      const f = Math.max(0, 1 - r);
      const core = Math.pow(f, 6); // 白热核心
      const glow = Math.pow(f, 2); // 暖色辉光
      const a = Math.min(1, core * 1.2 + glow * 0.85);
      const i = (y * N + x) * 4;
      d[i] = 255;
      d[i + 1] = 255 * (0.62 + 0.38 * core);
      d[i + 2] = 255 * (0.30 + 0.70 * core);
      d[i + 3] = 255 * a;
    }
  }
  _spark = finish(commit(s), false);
  return _spark;
}

let _smoke: THREE.Texture | null = null;

/** 烟尘：柔和的径向噪声云。RGB 保持中性灰白，颜色交给 instanceColor。 */
export function smokeTexture(): THREE.Texture {
  if (_smoke) return _smoke;
  const N = 128;
  const s = makeSurface(N);
  const d = s.data;
  const l = makeLattice(0x50e7);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0..1（边角 >1）
      const n = fbm2(l, u, v, 4, 2);
      // 噪声把圆的边缘啃出缺口，看起来才像烟不像球
      const edge = Math.max(0, 1 - r * (0.72 + 0.55 * n));
      const a = Math.pow(edge, 1.7) * (0.55 + 0.45 * n);
      const tint = 0.78 + 0.22 * n;
      const i = (y * N + x) * 4;
      d[i] = 255 * tint;
      d[i + 1] = 255 * tint;
      d[i + 2] = 255 * tint;
      d[i + 3] = 255 * Math.min(1, a);
    }
  }
  _smoke = finish(commit(s), false);
  return _smoke;
}

let _flash: THREE.Texture | null = null;

/** 枪口火光：星芒 + 花瓣。中心白热，向外转暖橙。 */
export function flashTexture(): THREE.Texture {
  if (_flash) return _flash;
  const N = 128;
  const s = makeSurface(N);
  const d = s.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5 - N / 2) / (N / 2);
      const dy = (y + 0.5 - N / 2) / (N / 2);
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const th = Math.atan2(dy, dx);

      const core = Math.pow(Math.max(0, 1 - r * 3.2), 2.0); // 白热核心
      const petals = Math.pow(Math.max(0, 1 - r), 2.2) * (0.42 + 0.58 * Math.pow(Math.abs(Math.cos(3 * th)), 3));
      // 四道尖锐星芒
      const ray =
        Math.pow(Math.max(0, 1 - r), 1.3) *
        (Math.pow(Math.max(0, Math.cos(2 * (th - 0.4))), 34) +
          Math.pow(Math.max(0, Math.cos(2 * (th + 1.17))), 26) * 0.7);

      const a = Math.min(1, core * 1.35 + petals * 0.8 + ray * 0.55);
      const hot = Math.min(1, core * 1.6 + ray * 0.5); // 越靠核心越白
      const i = (y * N + x) * 4;
      d[i] = 255;
      d[i + 1] = 255 * (0.70 + 0.30 * hot);
      d[i + 2] = 255 * (0.36 + 0.64 * hot);
      d[i + 3] = 255 * a;
    }
  }
  _flash = finish(commit(s), false);
  return _flash;
}

let _hole: THREE.Texture | null = null;

/**
 * 弹孔贴花：中心近黑的孔洞，外圈是被打碎的粉末环，边缘不规则碎裂。
 * alpha 通道带边缘破碎 → 贴到墙上不会是一个假圆盘。
 */
export function holeTexture(): THREE.Texture {
  if (_hole) return _hole;
  const N = 128;
  const s = makeSurface(N);
  const d = s.data;
  const l = makeLattice(0xbee7);
  const rnd = mulberry32(0x1337);
  // 8 条随机放射裂纹
  const cracks: Array<{ a: number; len: number; w: number }> = [];
  for (let i = 0; i < 8; i++) {
    cracks.push({ a: rnd() * Math.PI * 2, len: 0.30 + rnd() * 0.16, w: 14 + rnd() * 26 });
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const th = Math.atan2(dy, dx);

      const n = fbm2(l, u, v, 3, 3) - 0.5;
      const rim = 0.30 * (1 + 0.42 * n * 2); // 不规则外缘
      const core = 0.085 * (1 + 0.30 * n * 2); // 孔洞

      let a = 0;
      if (r < core) a = 1;
      else if (r < rim) a = Math.pow(1 - (r - core) / (rim - core), 0.75);

      // 裂纹伸出外缘
      for (let c = 0; c < cracks.length; c++) {
        const ck = cracks[c];
        let dth = Math.abs(((th - ck.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const lobe = Math.pow(Math.max(0, 1 - dth * ck.w * 0.25), 2);
        if (r < ck.len) a = Math.max(a, lobe * (1 - r / ck.len) * 0.85);
      }

      // 颜色：孔心近黑，向外是被打出来的浅色粉末
      const t = core > 0 ? Math.min(1, Math.max(0, (r - core) / Math.max(1e-4, rim - core))) : 1;
      const lum = 0.06 + 0.44 * Math.pow(t, 1.5) * (0.7 + 0.6 * (n + 0.5));
      const i = (y * N + x) * 4;
      d[i] = 255 * lum;
      d[i + 1] = 255 * lum * 0.97;
      d[i + 2] = 255 * lum * 0.93;
      d[i + 3] = 255 * Math.min(1, a);
    }
  }
  _hole = finish(commit(s), false);
  return _hole;
}

// ---------------------------------------------------------------------------
// 墙面贴图（可平铺）
// ---------------------------------------------------------------------------

const _concreteCache = new Map<number, THREE.Texture>();

/** 混凝土：粗骨料颗粒 + 大块脏污 + 细密麻点。c 是基色，默认冷灰。 */
export function concreteTexture(c = 0x6d6f72): THREE.Texture {
  const cached = _concreteCache.get(c);
  if (cached) return cached;

  const N = 256;
  const s = makeSurface(N);
  const d = s.data;
  // 直接拿 sRGB 分量画像素（贴图本身就是 sRGB 编码的，不要走 THREE.Color 的线性转换）
  const br = ((c >> 16) & 0xff) / 255;
  const bg = ((c >> 8) & 0xff) / 255;
  const bb = (c & 0xff) / 255;

  const lBlotch = makeLattice(0xc0c7e7);
  const lGrain = makeLattice(0x9a11);
  const lSpeck = makeLattice(0x5eed);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const blotch = fbm2(lBlotch, u, v, 3, 1) - 0.5; // 大块明暗
      const grain = fbm2(lGrain, u, v, 3, 6) - 0.5; // 骨料
      const speck = lat(lSpeck, u * LATTICE * 16, v * LATTICE * 16) - 0.5; // 麻点
      let m = 1 + blotch * 0.34 + grain * 0.26 + speck * 0.16;
      // 少量深色气孔
      if (speck > 0.44) m *= 0.62;
      m = Math.max(0.12, Math.min(1.9, m));
      const i = (y * N + x) * 4;
      d[i] = 255 * Math.min(1, br * m);
      d[i + 1] = 255 * Math.min(1, bg * m);
      d[i + 2] = 255 * Math.min(1, bb * m);
      d[i + 3] = 255;
    }
  }
  const tex = finish(commit(s), true);
  _concreteCache.set(c, tex);
  return tex;
}

let _metal: THREE.Texture | null = null;

/** 铁皮：横向瓦楞 + 拉丝 + 锈斑。看着像掩体，其实一穿一个洞。 */
export function metalTexture(): THREE.Texture {
  if (_metal) return _metal;
  const N = 256;
  const s = makeSurface(N);
  const d = s.data;
  const lBrush = makeLattice(0x6ea5);
  const lRust = makeLattice(0x2b17);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;

      // 瓦楞：8 道竖向起伏（整数周期 → 平铺无缝）
      const rib = 0.5 + 0.5 * Math.cos(u * Math.PI * 2 * 8);
      const shade = 0.62 + 0.48 * Math.pow(rib, 1.6);

      // 拉丝：沿 v 方向拉长的噪声
      const brush = lat(lBrush, u * LATTICE * 24, v * LATTICE * 2) - 0.5;

      let r = 0.36 * shade + brush * 0.10;
      let g = 0.39 * shade + brush * 0.10;
      let b = 0.43 * shade + brush * 0.10;

      // 锈斑
      const rust = fbm2(lRust, u, v, 3, 2);
      if (rust > 0.60) {
        const k = Math.min(1, (rust - 0.60) / 0.28);
        r = r * (1 - k) + 0.42 * k;
        g = g * (1 - k) + 0.21 * k;
        b = b * (1 - k) + 0.11 * k;
      }

      const i = (y * N + x) * 4;
      d[i] = 255 * Math.max(0, Math.min(1, r));
      d[i + 1] = 255 * Math.max(0, Math.min(1, g));
      d[i + 2] = 255 * Math.max(0, Math.min(1, b));
      d[i + 3] = 255;
    }
  }
  _metal = finish(commit(s), true);
  return _metal;
}

let _wood: THREE.Texture | null = null;

/** 木板：4 条横板 + 板缝 + 顺纹木理 + 钉眼。 */
export function woodTexture(): THREE.Texture {
  if (_wood) return _wood;
  const N = 256;
  const s = makeSurface(N);
  const d = s.data;
  const lGrain = makeLattice(0x0d1e);
  const lWarp = makeLattice(0x77a3);
  const PLANKS = 4;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;

      const pv = v * PLANKS;
      const plank = Math.floor(pv);
      const fv = pv - plank; // 板内 0..1
      // 每块板整体亮度略有差异
      const plankTone = 0.86 + 0.28 * lat(lWarp, plank * 3.7, 0.5);

      // 木理：沿 u 拉长的条纹，被低频扰动弯曲
      const warp = (fbm2(lWarp, u, v, 2, 2) - 0.5) * 0.6;
      const rings = 0.5 + 0.5 * Math.sin((fv + warp) * Math.PI * 2 * 5 + plank * 2.1);
      const grain = lat(lGrain, u * LATTICE * 3, v * LATTICE * 20) - 0.5;

      let m = plankTone * (0.78 + 0.30 * Math.pow(rings, 1.8) + grain * 0.18);

      // 板缝（上下边缘各一条暗线）
      const seam = Math.min(fv, 1 - fv);
      if (seam < 0.035) m *= 0.28 + 0.72 * (seam / 0.035);

      // 钉眼
      const nailU = plank % 2 === 0 ? 0.16 : 0.66;
      const ndx = (u - nailU) * 2;
      const ndy = (fv - 0.5) * 0.5;
      if (ndx * ndx + ndy * ndy < 0.0009) m *= 0.35;

      m = Math.max(0.08, Math.min(1.6, m));
      const i = (y * N + x) * 4;
      d[i] = 255 * Math.min(1, 0.52 * m);
      d[i + 1] = 255 * Math.min(1, 0.38 * m);
      d[i + 2] = 255 * Math.min(1, 0.24 * m);
      d[i + 3] = 255;
    }
  }
  _wood = finish(commit(s), true);
  return _wood;
}

/** 释放全部缓存（热重载/关卡切换用；正常运行不需要调用）。 */
export function disposeTextures(): void {
  const all: Array<THREE.Texture | null> = [_spark, _smoke, _flash, _hole, _metal, _wood];
  for (const t of all) t?.dispose();
  for (const t of _concreteCache.values()) t.dispose();
  _concreteCache.clear();
  _spark = _smoke = _flash = _hole = _metal = _wood = null;
}

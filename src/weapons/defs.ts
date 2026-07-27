/**
 * 武器定义 —— 数据驱动，改数值不改代码。
 * （模式参照 KenneyNL Starter-Kit-FPS 的 resource 写法）
 *
 * M0 只上 AR-15；M1 补齐 P9 / MP7 / SG-12 / M-DMR，结构已经预留。
 */

import type { WeaponDef } from '../types';

export const AR15: WeaponDef = {
  id: 'ar15',
  name: 'AR-15',
  damage: 30,
  rpm: 700, // 85.7ms/发 → 无甲 4 发 257ms TTK
  pellets: 1,
  magSize: 30,
  reloadSec: 2.4,
  reloadEmptySec: 2.9,

  spreadStand: 0.8, // 度
  spreadMove: 2.6,
  spreadADS: 0.35,
  spreadAir: 3.2, // 空中散布 ×4，不做兔子跳互蹦

  recoilVert: 1.7,
  recoilHoriz: 0.6,
  recoilKick: 0.04,

  trauma: 0.18,
  hitstopNormal: 2,
  hitstopHead: 5,
  hitstopKill: 7,

  falloffStart: 30,
  falloffEnd: 60,
  falloffMinMul: 0.65,
  maxPenetrations: 2,

  tracerEvery: 3, // 每 3 发一条 —— 每发都有会变成激光秀，反而掩盖单发的清晰度

  /**
   * 红点镜：1.15x。红点镜本身是**不放大**的（真镜就是 1x），这里给一点点
   * 是纯粹的表现手法 —— 轻微收 FOV 会读成「凑近了、专注了」，是几乎所有
   * FPS 都会做的 ADS 视觉补偿。给大了就变成望远镜，反而砍掉巷战需要的周边视野。
   */
  scopeZoom: 1.15, // FOV 90° → 78°

  audio: {
    bodyFreq: 148,
    bodyDecay: 0.16,
    subFreq: 54,
    subDecay: 0.22,
    mechBright: 0.75,
    tailDecay: 0.55,
  },
};

export const WEAPONS: Record<string, WeaponDef> = {
  ar15: AR15,
};

/** 射击间隔（秒） */
export function fireInterval(w: WeaponDef): number {
  return 60 / w.rpm;
}

/** 距离衰减倍率 */
export function falloffMul(w: WeaponDef, distance: number): number {
  if (distance <= w.falloffStart) return 1;
  if (distance >= w.falloffEnd) return w.falloffMinMul;
  const t = (distance - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 + (w.falloffMinMul - 1) * t;
}

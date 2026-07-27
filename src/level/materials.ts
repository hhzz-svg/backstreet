/**
 * 表面材质表 —— 把关卡从「几何」变成「信息」。
 *
 * 玩家必须学会认材质：铁皮广告牌看着能躲（穿透 0.55），混凝土才是真掩体。
 * 这是巷战最好的深度来源，而且几乎零额外成本。
 *
 * 用法：给每个碰撞网格的 userData.surface 打上 SurfaceKind 标签，
 * 射线命中后查这张表分派弹着特效、音效和穿透衰减。
 */

import type { SurfaceDef, SurfaceKind } from '../types';

export const SURFACES: Record<SurfaceKind, SurfaceDef> = {
  concrete: {
    kind: 'concrete',
    penetration: 0.0, // 唯一的真掩体
    sparks: 4,
    sparkColor: 0xffa040,
    dust: 14, // 灰白粉尘团是主角
    dustColor: 0xd8d4cc,
    decal: true,
    decalColor: 0x2a2723,
    impactTone: 420,
    impactDecay: 0.11,
  },
  brick: {
    kind: 'brick',
    penetration: 0.25, // 能穿但代价大
    sparks: 5,
    sparkColor: 0xff9a3c,
    dust: 12,
    dustColor: 0xc9a48c,
    decal: true,
    decalColor: 0x3a2118,
    impactTone: 380,
    impactDecay: 0.12,
  },
  metal: {
    kind: 'metal',
    penetration: 0.55, // 看着像掩体，其实是陷阱
    sparks: 22, // 大量白热火花是主角
    sparkColor: 0xfff2c0,
    dust: 0,
    dustColor: 0x000000,
    decal: true,
    decalColor: 0x14161a,
    impactTone: 1650, // 尖锐的「铛」+ 跳弹尾音
    impactDecay: 0.28,
  },
  wood: {
    kind: 'wood',
    penetration: 0.75, // 拆迁区的临时隔断，几乎挡不住子弹
    sparks: 2,
    sparkColor: 0xffb060,
    dust: 8, // 木屑
    dustColor: 0x8a6b46,
    decal: true,
    decalColor: 0x241a10,
    impactTone: 260,
    impactDecay: 0.09,
  },
  glass: {
    kind: 'glass',
    penetration: 0.95, // 碎了永久改变视线
    sparks: 0,
    sparkColor: 0xffffff,
    dust: 18, // 玻璃碎屑
    dustColor: 0xbfe0e8,
    decal: false, // 玻璃整块碎裂，不留弹孔
    decalColor: 0x000000,
    impactTone: 2400,
    impactDecay: 0.22,
  },
  dirt: {
    kind: 'dirt',
    penetration: 0.35,
    sparks: 0,
    sparkColor: 0x000000,
    dust: 16,
    dustColor: 0x6b5a44,
    decal: true,
    decalColor: 0x2a2118,
    impactTone: 180,
    impactDecay: 0.08,
  },
  flesh: {
    kind: 'flesh',
    penetration: 0.6,
    sparks: 0,
    sparkColor: 0x000000,
    dust: 12, // 血雾沿弹道方向喷出
    dustColor: 0x8c1a12,
    decal: true,
    decalColor: 0x4a0d08,
    impactTone: 140, // 湿闷的 thud
    impactDecay: 0.07,
  },
};

export function surfaceOf(kind: SurfaceKind | undefined): SurfaceDef {
  return SURFACES[kind ?? 'concrete'];
}

/** 部位伤害倍率 */
export const PART_MULTIPLIER = {
  head: 2.0,
  torso: 1.0,
  limb: 0.85,
} as const;

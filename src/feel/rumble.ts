/**
 * 手柄震动 —— Gamepad API 的 vibrationActuator。
 *
 * 全程做特性检测：没手柄、浏览器不支持、playEffect 抛异常，一律**安静地 no-op**。
 * 这一层是纯锦上添花，任何情况下都不允许因为它中断射击流程。
 *
 * 双时钟：本模块不需要 dt。震动时长用毫秒墙钟交给硬件，
 * 天然不受 hit-stop / 慢镜影响 —— 这正是我们要的（震动属于 unscaled 反馈层）。
 *
 * 抢占策略：高射速下每发都会调 rumble()。playEffect 本身会抢占正在播放的效果，
 * 所以我们额外加一条规则 —— 正在播放的效果如果**更强**且还没快结束，
 * 就不让弱效果打断它（不然爆炸的大震动会被紧接着的一发枪声震动截断）。
 */

import { clamp, clamp01 } from '../core/time';
import { feelConfig, feelOn } from './config';

/** 旧版 Chrome 的非标准接口，仍有设备只支持它。 */
interface LegacyActuator {
  pulse?: (value: number, duration: number) => Promise<unknown>;
}

/** 当前正在播放的效果的结束墙钟时间戳。 */
let activeUntil = 0;
/** 当前正在播放的效果的强度（strong 与 weak 取大者），用于抢占比较。 */
let activeMagnitude = 0;

/** 快结束时（剩余不足这个毫秒数）允许被弱效果抢占，保证连发的每一下都有反馈。 */
const PREEMPT_TAIL_MS = 40;

function gamepads(): (Gamepad | null)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return [];
  }
  try {
    return navigator.getGamepads();
  } catch {
    // 某些环境（无安全上下文 / 权限策略禁用）会直接抛
    return [];
  }
}

/** 是否至少有一个已连接、且带震动硬件的手柄。 */
export function hasGamepad(): boolean {
  for (const pad of gamepads()) {
    if (!pad || !pad.connected) continue;
    const act = pad.vibrationActuator as GamepadHapticActuator | undefined;
    const legacy = pad.vibrationActuator as unknown as LegacyActuator | undefined;
    if ((act && typeof act.playEffect === 'function') || (legacy && typeof legacy.pulse === 'function')) {
      return true;
    }
  }
  return false;
}

/**
 * 触发一次双马达震动。
 *
 * @param strong 低频重马达 0..1（"闷"的那一下：枪声本体、爆炸、受击）
 * @param weak   高频轻马达 0..1（"脆"的那一下：hitmarker、抛壳、上膛）
 * @param ms     持续毫秒
 *
 * 两个强度都会乘 feelConfig.rumble.scale 并 clamp 到 0..1。
 * feelConfig.rumble.enabled（或 master）关掉时直接 return。
 */
export function rumble(strong: number, weak: number, ms: number): void {
  if (!feelOn(feelConfig.rumble.enabled)) return;

  const scale = feelConfig.rumble.scale;
  const s = clamp01((Number.isFinite(strong) ? strong : 0) * scale);
  const w = clamp01((Number.isFinite(weak) ? weak : 0) * scale);
  const dur = clamp(Number.isFinite(ms) ? ms : 0, 0, 5000);

  if (dur <= 0 || (s <= 0 && w <= 0)) return;

  // 抢占规则：更强的效果随时可以打断；更弱的只能在尾巴上接管。
  const now = performance.now();
  const mag = Math.max(s, w);
  const remaining = activeUntil - now;
  if (remaining > PREEMPT_TAIL_MS && mag < activeMagnitude) return;

  let played = false;

  for (const pad of gamepads()) {
    if (!pad || !pad.connected) continue;

    const act = pad.vibrationActuator as GamepadHapticActuator | undefined;
    if (act && typeof act.playEffect === 'function') {
      try {
        const p = act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: dur,
          strongMagnitude: s,
          weakMagnitude: w,
        });
        // 被抢占时 Promise 会 reject，必须吞掉，否则控制台一片红。
        if (p && typeof p.catch === 'function') p.catch(() => {});
        played = true;
        continue;
      } catch {
        // 落到下面的 legacy 分支
      }
    }

    const legacy = pad.vibrationActuator as unknown as LegacyActuator | undefined;
    if (legacy && typeof legacy.pulse === 'function') {
      try {
        const p = legacy.pulse(mag, dur);
        if (p && typeof (p as Promise<unknown>).catch === 'function') {
          (p as Promise<unknown>).catch(() => {});
        }
        played = true;
      } catch {
        /* 安静地放弃 */
      }
    }
  }

  if (played) {
    activeUntil = now + dur;
    activeMagnitude = mag;
  }
}

/** 立刻停掉所有震动。暂停 / 死亡 / 重开局时调用，避免马达卡在一直转。 */
export function stopRumble(): void {
  activeUntil = 0;
  activeMagnitude = 0;

  for (const pad of gamepads()) {
    if (!pad || !pad.connected) continue;
    const act = pad.vibrationActuator as GamepadHapticActuator | undefined;
    if (act && typeof act.reset === 'function') {
      try {
        const p = act.reset();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* 安静地放弃 */
      }
    }
  }
}

/**
 * 调参面板 —— lil-gui 直接绑定 feelConfig。
 *
 * 这个面板不是锦上添花：Vlambeer《The Art of Screenshake》全部的说服力
 * 都来自「每一层能单独开关」。没有它，打击感只能靠嘴说；有了它，
 * 任何人 30 秒内就能自己听出震动/定帧/后坐各贡献了多少。
 *
 * 所以最上面永远是 master 总开关（A/B 对比），关掉 = 只剩裸射击。
 *
 * 注意：本文件只读写 feelConfig，不持有任何游戏对象。
 * 需要重建管线的参数（post.*、audio.*）通过回调通知外部，见 DevPanelOptions。
 */

import GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { feelConfig } from '../feel/config';

/**
 * 契约里写的是 `createDevPanel(onReset?: () => void)`。
 * 这里扩展成「可以传一个函数（等价于 onReset），也可以传一个回调对象」，
 * 旧签名的调用方不用改。
 */
export interface DevPanelOptions {
  /** 点「重置为默认值」后调用 —— 外部需要跟着复位的东西在这里做 */
  onReset?: () => void;
  /** post.* 任一参数改变后调用 —— PostFX.syncConfig() 挂这里 */
  onPostChange?: () => void;
  /** audio.* 任一参数改变后调用 —— audio.setMasterVolume() / 重建滤波挂这里 */
  onAudioChange?: () => void;
  /** 任何一项改变都会调用（含 master），参数是被改的属性名 */
  onAnyChange?: (property: string) => void;
}

export interface DevPanelHandle {
  /** 显示 / 隐藏（默认隐藏） */
  toggle(): void;
  /** 外部代码改了 feelConfig（比如按 K 切 master）后调用，让面板显示同步 */
  refresh(): void;
  destroy(): void;
  readonly visible: boolean;
}

const STYLE_ID = 'bs-devpanel-style';

/** 面板配色：跟 HUD 一套（冷灰底 + 暖橙），并给 master 那一行做醒目标记 */
const CSS = `
.lil-gui.bs-panel {
  --background-color: #14171b;
  --text-color: #dfe3e8;
  --title-background-color: #1b1f25;
  --title-text-color: #ff8a2b;
  --widget-color: #262b33;
  --hover-color: #313842;
  --focus-color: #ff8a2b;
  --number-color: #ffb066;
  --string-color: #8fd0c0;
  --font-family: "Bahnschrift", "Segoe UI", system-ui, sans-serif;
  --font-family-mono: Consolas, "SFMono-Regular", monospace;
  --font-size: 12px;
  --input-font-size: 12px;
  --widget-border-radius: 0px;
  --name-width: 52%;
  z-index: 1200;
  box-shadow: 0 10px 40px rgba(0,0,0,0.55);
}
.lil-gui.bs-panel .lil-controller.bs-master {
  background: rgba(255,138,43,0.16);
  border-left: 3px solid #ff8a2b;
  margin-left: 0;
}
.lil-gui.bs-panel .lil-controller.bs-master .lil-name {
  color: #ffb066; font-weight: 600; letter-spacing: 0.04em;
}
/* master 关掉时整块面板变「警戒色」，一眼知道现在是裸射击对照组 */
.lil-gui.bs-panel.bs-off > .lil-title {
  background: #5d1b12; color: #ff9a80;
}
.lil-gui.bs-panel.bs-off .lil-controller.bs-master {
  background: rgba(229,83,58,0.20);
  border-left-color: #e5533a;
}
.lil-gui.bs-panel.bs-off .lil-controller.bs-master .lil-name { color: #ff8a70; }
.lil-gui.bs-panel.bs-flash { animation: bs-panel-flash 260ms ease-out 1; }
@keyframes bs-panel-flash {
  0%   { box-shadow: 0 0 0 3px rgba(255,138,43,0.9), 0 10px 40px rgba(0,0,0,0.55); }
  100% { box-shadow: 0 0 0 0 rgba(255,138,43,0.0), 0 10px 40px rgba(0,0,0,0.55); }
}
`;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/**
 * 默认值快照。在模块加载时深拷贝一份 —— devpanel 在启动阶段被 import，
 * 这时 feelConfig 还没被任何人改过，所以这份就是真·出厂值。
 */
const DEFAULTS: Record<string, unknown> = JSON.parse(JSON.stringify(feelConfig));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 只覆盖 target 里已有的键，递归进对象 —— 不引入新键、不换引用 */
function deepAssign(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const sv = src[k];
    const tv = target[k];
    if (isPlainObject(sv) && isPlainObject(tv)) deepAssign(tv, sv);
    else target[k] = sv;
  }
}

function copyToClipboard(text: string): void {
  const nav = navigator as Navigator & { clipboard?: Clipboard };
  if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    nav.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text: string): void {
  // 非安全上下文（http://局域网 IP）拿不到 clipboard API，退回老办法
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* 复制失败也没关系，JSON 已经在 console 里了 */
  }
  ta.remove();
}

// ---------------------------------------------------------------------------

export function createDevPanel(opts?: DevPanelOptions | (() => void)): DevPanelHandle {
  const o: DevPanelOptions = typeof opts === 'function' ? { onReset: opts } : (opts ?? {});
  injectStyle();

  const gui = new GUI({ title: '暗巷 · 打击感调参', width: 300 });
  gui.domElement.classList.add('bs-panel');

  const notify = (prop: string): void => {
    o.onAnyChange?.(prop);
  };

  /** 给一批控件挂同一个额外回调（post / audio 用） */
  const hook = (ctrls: Controller[], extra?: () => void): void => {
    for (const c of ctrls) {
      c.onChange(() => {
        notify(c.property);
        extra?.();
      });
    }
  };

  // -------------------------------------------------------------------------
  // 0. 总开关 —— 永远在最上面，改动时整块面板变色
  // -------------------------------------------------------------------------
  const master = gui
    .add(feelConfig, 'master')
    .name('★ 打击感总开关 (A/B)')
    .listen() // 外部按 K 切换时面板自动跟上
    .onChange((v: boolean) => {
      syncMasterStyle();
      flash();
      console.log('[feel] master =', v ? 'ON（全部反馈层）' : 'OFF（裸射击对照组）');
      notify('master');
    });
  master.domElement.classList.add('bs-master');

  function syncMasterStyle(): void {
    gui.domElement.classList.toggle('bs-off', !feelConfig.master);
  }
  function flash(): void {
    gui.domElement.classList.remove('bs-flash');
    // 强制回流，让动画能重新触发
    void gui.domElement.offsetWidth;
    gui.domElement.classList.add('bs-flash');
  }
  syncMasterStyle();

  // -------------------------------------------------------------------------
  // 0.5 操作手感 —— 不是打击感层，master 关掉也生效。放最上面是因为
  //     灵敏度必须边动边试，藏在折叠夹里就没人调了。
  // -------------------------------------------------------------------------
  const fInput = gui.addFolder('操作 INPUT');
  hook([
    fInput.add(feelConfig.input, 'lookSens', 0.0005, 0.012, 0.0001).name('鼠标灵敏度'),
    fInput.add(feelConfig.input, 'adsSensMul', 0.2, 1.5, 0.05).name('开镜灵敏度倍率'),
    fInput.add(feelConfig.input, 'adsToggle').name('开镜切换模式（不用按住）'),
  ]);

  // -------------------------------------------------------------------------
  // 1. 震动
  // -------------------------------------------------------------------------
  const fShake = gui.addFolder('震动 SHAKE');
  hook([
    fShake.add(feelConfig.shake, 'enabled').name('启用'),
    fShake.add(feelConfig.shake, 'decay', 0.2, 5, 0.01).name('衰减 /s'),
    fShake.add(feelConfig.shake, 'freq', 2, 60, 0.5).name('噪声频率 Hz'),
    fShake.add(feelConfig.shake, 'exponent', 1, 4, 0.05).name('幂次 trauma^n'),
    fShake.add(feelConfig.shake, 'maxPitch', 0, 12, 0.1).name('最大 Pitch°'),
    fShake.add(feelConfig.shake, 'maxYaw', 0, 12, 0.1).name('最大 Yaw°'),
    fShake.add(feelConfig.shake, 'maxRoll', 0, 12, 0.1).name('最大 Roll°'),
    fShake.add(feelConfig.shake, 'traumaOnHurt', 0, 1, 0.01).name('受击 trauma'),
  ]);

  // -------------------------------------------------------------------------
  // 2. 定帧
  // -------------------------------------------------------------------------
  const fStop = gui.addFolder('定帧 HIT-STOP');
  hook([
    fStop.add(feelConfig.hitstop, 'enabled').name('启用'),
    fStop.add(feelConfig.hitstop, 'scale', 0, 1, 0.01).name('timeScale'),
    fStop.add(feelConfig.hitstop, 'framesLimb', 0, 20, 1).name('四肢 帧'),
    fStop.add(feelConfig.hitstop, 'framesTorso', 0, 20, 1).name('躯干 帧'),
    fStop.add(feelConfig.hitstop, 'framesHead', 0, 20, 1).name('爆头 帧'),
    fStop.add(feelConfig.hitstop, 'framesKill', 0, 20, 1).name('击杀 帧'),
  ]);

  // -------------------------------------------------------------------------
  // 3. 慢镜
  // -------------------------------------------------------------------------
  const fSlow = gui.addFolder('慢镜 SLOW-MO');
  hook([
    fSlow.add(feelConfig.slowmo, 'enabled').name('启用'),
    fSlow.add(feelConfig.slowmo, 'scale', 0.05, 1, 0.01).name('timeScale'),
    fSlow.add(feelConfig.slowmo, 'durationMs', 0, 2000, 10).name('持续 ms'),
    fSlow.add(feelConfig.slowmo, 'recoverMs', 0, 1500, 10).name('恢复 ms'),
  ]);

  // -------------------------------------------------------------------------
  // 4. 后坐
  // -------------------------------------------------------------------------
  const fRecoil = gui.addFolder('后坐 RECOIL');
  hook([
    fRecoil.add(feelConfig.recoil, 'enabled').name('启用'),
    fRecoil.add(feelConfig.recoil, 'snappiness', 1, 60, 0.5).name('刚度 (脆)'),
    fRecoil.add(feelConfig.recoil, 'returnSpeed', 1, 40, 0.5).name('回落速度 (余味)'),
    fRecoil.add(feelConfig.recoil, 'scale', 0, 3, 0.05).name('总倍率'),
  ]);

  // -------------------------------------------------------------------------
  // 5. 视觉层
  // -------------------------------------------------------------------------
  const fVfx = gui.addFolder('视觉 VFX');
  hook([
    fVfx.add(feelConfig.vfx, 'muzzleFlash').name('枪口火光'),
    fVfx.add(feelConfig.vfx, 'muzzleLight').name('枪口动态光'),
    fVfx.add(feelConfig.vfx, 'tracer').name('曳光弹'),
    fVfx.add(feelConfig.vfx, 'shell').name('抛壳'),
    fVfx.add(feelConfig.vfx, 'impactSparks').name('弹着火花'),
    fVfx.add(feelConfig.vfx, 'impactDust').name('弹着尘烟'),
    fVfx.add(feelConfig.vfx, 'decals').name('弹孔贴花'),
    fVfx.add(feelConfig.vfx, 'bloodMist').name('血雾'),
    // 下面两项是池容量：只影响之后新建的池，运行中改动一般不重建（成本高）
    fVfx.add(feelConfig.vfx, 'maxDynamicLights', 0, 16, 1).name('动态光上限*'),
    fVfx.add(feelConfig.vfx, 'maxDecals', 0, 1024, 16).name('贴花上限*'),
  ]);

  // -------------------------------------------------------------------------
  // 6. UI 反馈
  // -------------------------------------------------------------------------
  const fUi = gui.addFolder('界面 UI');
  hook([
    fUi.add(feelConfig.ui, 'hitmarker').name('hitmarker'),
    fUi.add(feelConfig.ui, 'damageNumbers').name('伤害数字'),
    fUi.add(feelConfig.ui, 'hurtVignette').name('受击暗角'),
    fUi.add(feelConfig.ui, 'hitmarkerMs', 20, 400, 5).name('hitmarker ms'),
    fUi.add(feelConfig.ui, 'damageTextLife', 0.2, 3, 0.05).name('伤害数字 s'),
  ]);

  // -------------------------------------------------------------------------
  // 7. 音频（改动要通知引擎）
  // -------------------------------------------------------------------------
  const fAudio = gui.addFolder('音频 AUDIO');
  hook(
    [
      fAudio.add(feelConfig.audio, 'enabled').name('启用'),
      fAudio.add(feelConfig.audio, 'masterVolume', 0, 1, 0.01).name('总音量'),
      fAudio.add(feelConfig.audio, 'layerBody').name('层1 主体爆响'),
      fAudio.add(feelConfig.audio, 'layerSub').name('层2 次低频'),
      fAudio.add(feelConfig.audio, 'layerMech').name('层3 机械拟音'),
      fAudio.add(feelConfig.audio, 'layerTail').name('层4 环境尾音'),
      fAudio.add(feelConfig.audio, 'lowHealthFilter').name('低血量低通/耳鸣'),
    ],
    () => o.onAudioChange?.(),
  );

  // -------------------------------------------------------------------------
  // 8. 手柄震动
  // -------------------------------------------------------------------------
  const fRumble = gui.addFolder('手柄震动 RUMBLE');
  hook([
    fRumble.add(feelConfig.rumble, 'enabled').name('启用'),
    fRumble.add(feelConfig.rumble, 'scale', 0, 2, 0.05).name('强度倍率'),
  ]);

  // -------------------------------------------------------------------------
  // 9. 后处理（改动要通知 PostFX 重建/同步）
  // -------------------------------------------------------------------------
  const fPost = gui.addFolder('后处理 POST');
  hook(
    [
      fPost.add(feelConfig.post, 'enabled').name('启用管线'),
      fPost.add(feelConfig.post, 'bloom').name('Bloom'),
      fPost.add(feelConfig.post, 'bloomIntensity', 0, 3, 0.01).name('Bloom 强度'),
      fPost.add(feelConfig.post, 'bloomThreshold', 0, 2, 0.01).name('Bloom 阈值'),
      fPost.add(feelConfig.post, 'vignette').name('暗角'),
      fPost.add(feelConfig.post, 'vignetteDarkness', 0, 1.5, 0.01).name('暗角强度'),
      fPost.add(feelConfig.post, 'chromatic').name('色差'),
      fPost.add(feelConfig.post, 'chromaticOffset', 0, 0.01, 0.0001).name('色差偏移'),
      fPost.add(feelConfig.post, 'noise').name('噪点'),
      fPost.add(feelConfig.post, 'noiseOpacity', 0, 0.3, 0.005).name('噪点不透明度'),
    ],
    () => o.onPostChange?.(),
  );

  // -------------------------------------------------------------------------
  // 10. 调试
  // -------------------------------------------------------------------------
  const fDebug = gui.addFolder('调试 DEBUG');
  hook([
    fDebug.add(feelConfig.debug, 'showColliders').name('显示碰撞体'),
    fDebug.add(feelConfig.debug, 'showHitscanRays').name('显示射线'),
    fDebug.add(feelConfig.debug, 'showStats').name('显示统计'),
  ]);

  // -------------------------------------------------------------------------
  // 11. 动作按钮
  // -------------------------------------------------------------------------
  const refresh = (): void => {
    for (const c of gui.controllersRecursive()) c.updateDisplay();
    syncMasterStyle();
  };

  const actions = {
    exportJson(): void {
      const json = JSON.stringify(feelConfig, null, 2);
      console.log('%c[feel] 当前配置 —— 已复制到剪贴板', 'color:#ff8a2b;font-weight:bold');
      console.log(json);
      copyToClipboard(json);
    },
    resetAll(): void {
      deepAssign(feelConfig as unknown as Record<string, unknown>, DEFAULTS);
      refresh();
      flash();
      o.onPostChange?.();
      o.onAudioChange?.();
      o.onReset?.();
      notify('*reset*');
      console.log('[feel] 已重置为默认值');
    },
    allFeedbackOff(): void {
      // 快捷 A/B：一键只留裸射击，再点一次回来
      feelConfig.master = !feelConfig.master;
      syncMasterStyle();
      refresh();
      flash();
      notify('master');
    },
  };

  const fAct = gui.addFolder('操作');
  fAct.add(actions, 'exportJson').name('导出配置 JSON（复制到剪贴板）');
  fAct.add(actions, 'resetAll').name('重置为默认值');
  fAct.add(actions, 'allFeedbackOff').name('一键切换 裸射击 / 全反馈');

  // 折叠所有分组，默认只露出 master + 操作手感 + 动作，别一开面板就糊一屏
  for (const f of gui.folders) f.close();
  fInput.open(); // 灵敏度要边动边试，默认展开
  fAct.open();

  // 默认隐藏
  let visible = false;
  gui.hide();

  return {
    toggle(): void {
      visible = !visible;
      gui.show(visible);
      if (visible) refresh();
    },
    refresh,
    destroy(): void {
      gui.destroy();
    },
    get visible(): boolean {
      return visible;
    },
  };
}

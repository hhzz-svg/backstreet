/**
 * 《暗巷 BACKSTREET》M0 竖切 —— 集成层
 *
 * 一条巷子 + 一把 AR-15 + 会还击的敌人 + 完整打击感栈 + lil-gui 调参面板。
 *
 * M0 的判决标准：把打击感总开关（K 键）关掉再打开，
 * 差异要明显到不需要解释。
 *
 * ── 每帧顺序有硬依赖，改动前先读这段 ──────────────────────────────
 *  1. time.tick + pumpUnscaledTimers + updateTimeControl
 *  2. player.update(scaled)              身体先动，相机基础朝向定下来
 *  3. recoil / shake.update(unscaled)    衰减上一帧的冲量
 *  4. player.applyCameraOffsets          相机最终朝向 = 瞄准 + 后坐 + 震动
 *  5. viewModel.update(unscaled)         枪模跟随最终相机 → 刷新 muzzleWorld
 *  6. weapon.update(scaled)              开火时拿到的是本帧的枪口位置
 *  6.5 倍镜 FOV                          必须在 6 之后 —— adsT 在那里推进
 *  7. enemies.update(scaled)
 *  8. vfx / ui(unscaled) → postfx.render
 *
 *  5 必须在 6 之前：ViewModel 在 update 末尾才刷新 muzzleWorld，
 *  顺序反了快速转身时曳光弹会从旧位置射出。
 *  后坐的相机位移会在下一帧的 3-4 生效（+1 帧 ≈ 16ms，不可感知）；
 *  而枪口火光 / 曳光弹 / 音频 / 定帧全部是开火当帧落下的。
 */

import * as THREE from 'three';

import { time, pumpUnscaledTimers, clamp01, expApproach, lerp } from './core/time';
import { feelConfig } from './feel/config';
import { AR15 } from './weapons/defs';
import type { DamageResult } from './types';

import { createRenderer, createCamera, BASE_FOV } from './render/renderer';
import { PostFX } from './render/postfx';
import { Quality, PRESETS, type QualityLevel } from './render/quality';
import { buildAlley } from './level/alley';

import { shake } from './feel/trauma';
import { updateTimeControl, resetTimeControl } from './feel/hitstop';
import { Recoil } from './feel/recoil';
import { rumble, stopRumble } from './feel/rumble';

import { VfxSystem } from './vfx/particles';
import { LightPool } from './vfx/lightPool';
import { DecalSystem } from './vfx/decals';
import { MuzzleFx } from './vfx/muzzle';
import { TracerFx } from './vfx/tracer';
import { ImpactFx } from './vfx/impact';

import { audio } from './audio/engine';
import { Player } from './entities/player';
import { Enemy } from './entities/enemy';
import { Weapon } from './weapons/weapon';
import { ViewModel } from './weapons/viewmodel';
import { Hud } from './ui/hud';
import { DamageText } from './ui/damageText';
import { createDevPanel } from './ui/devpanel';

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const gate = document.getElementById('gate') as HTMLDivElement;
const gateLoad = document.getElementById('gate-load') as HTMLDivElement;
const gateHint = document.getElementById('gate-hint') as HTMLDivElement;
const hudRoot = document.getElementById('hud') as HTMLDivElement;

const renderer = createRenderer(); // 内部已 setSize
document.body.appendChild(renderer.domElement);
// postprocessing 一帧要 render 多次，autoReset 会让 info 只反映最后一个 pass
// （表现为 draw calls 恒等于 1）。改成手动每帧 reset 一次，统计才是整帧的。
renderer.info.autoReset = false;

const camera = createCamera();
const scene = new THREE.Scene();

// ---- 关卡 ----
const level = buildAlley();
scene.add(level.group);
// 巷子没有天花板，不设雾会看到 far 平面的硬边
scene.fog = (level.group.userData.suggestedFog as THREE.FogExp2) ?? null;
scene.background = (level.group.userData.suggestedBackground as THREE.Color) ?? null;

// ---- 后处理 ----
const postfx = new PostFX(renderer, scene, camera);

// ---- 特效 ----
const vfx = new VfxSystem(scene);
const lights = new LightPool(scene, feelConfig.vfx.maxDynamicLights);
const decals = new DecalSystem(scene, feelConfig.vfx.maxDecals);
const muzzle = new MuzzleFx(vfx, lights);
const tracer = new TracerFx(scene);
const impact = new ImpactFx(vfx, decals, lights);

// ---- 实体 ----
const player = new Player(camera, level.collider);
player.respawn(level.spawnPoint);

const enemies: Enemy[] = level.enemySpawns.map((p, i) => new Enemy(scene, p, i));

// ---- 打击感 ----
const recoil = new Recoil();

// ---- UI ----
const hud = new Hud(hudRoot);
const damageText = new DamageText(hudRoot, camera);

// ---- 武器 ----
// 枪模是 camera 的子对象 —— camera 必须在场景图里，否则枪不渲染
scene.add(camera);
const viewModel = new ViewModel(camera);
viewModel.floorY = 0; // 巷子地面在 y=0，抛壳落到这个高度

const weapon = new Weapon(AR15, {
  camera,
  hitMeshes: level.hitMeshes,
  enemies,
  muzzle,
  tracer,
  impact,
  recoil,
  shake,
  viewmodel: viewModel,
  getMuzzleWorld: () => viewModel.muzzleWorld,
  onDamage: (r: DamageResult) => {
    damageText.spawn(r.worldPos, r.amount, r.headshot, r.killed);
    hud.hitmarker(r.killed ? 'kill' : r.headshot ? 'head' : 'normal');
    rumble(r.killed ? 0.9 : r.headshot ? 0.6 : 0.35, 0.3, r.killed ? 140 : 70);
  },
});

// ---------------------------------------------------------------------------
// 受击 / 反击接线
// ---------------------------------------------------------------------------

// Player 自己不认识 feel / audio 模块（保持零编译依赖），反馈在这里接
player.onHurt = (_dmg, _fromDir, angleRad, dead) => {
  shake.add(feelConfig.shake.traumaOnHurt);
  audio.hurt();
  rumble(0.5, 0.7, 120);
  hud.hurt(angleRad);
  if (dead) {
    stopRumble();
    resetTimeControl();
    setTimeout(() => {
      player.respawn(level.spawnPoint);
      weapon.refill();
    }, 900);
  }
};
player.onFootstep = () => audio.footstep('concrete');

const _toPlayer = new THREE.Vector3();
for (const e of enemies) {
  e.onShoot = (origin, dir, damage) => {
    // M0 简化：敌人不做完整射线，只判定弹道是否落在朝向玩家的窄锥内
    _toPlayer.subVectors(player.position, origin).normalize();
    if (dir.dot(_toPlayer) > 0.985) player.takeDamage(damage, dir);
  };
}

// ---------------------------------------------------------------------------
// 调参面板
// ---------------------------------------------------------------------------

const devPanel = createDevPanel({
  onReset: () => {
    resetTimeControl();
    stopRumble();
    shake.reset();
    recoil.reset();
    decals.clear();
    player.respawn(level.spawnPoint);
    weapon.cancelReload();
    weapon.refill();
    setAds(false);
    for (let i = 0; i < enemies.length; i++) enemies[i].respawn(level.enemySpawns[i]);
  },
  onPostChange: () => postfx.syncConfig(),
  onAudioChange: () => audio.setMasterVolume(feelConfig.audio.masterVolume),
});

// ---------------------------------------------------------------------------
// 提示条（K 键 A/B 对比时给个明确反馈）
// ---------------------------------------------------------------------------

const toast = document.createElement('div');
toast.style.cssText = [
  'position:fixed;left:50%;top:16%;transform:translateX(-50%)',
  'font:600 15px/1 Consolas,monospace;letter-spacing:.22em',
  'padding:10px 20px;border:1px solid #ff8a2b;color:#ff8a2b',
  'background:rgba(8,10,14,.82);pointer-events:none;z-index:40',
  'opacity:0;transition:opacity .18s',
].join(';');
document.body.appendChild(toast);
let toastTimer = 0;
function showToast(msg: string): void {
  toast.textContent = msg;
  toast.style.opacity = '1';
  toastTimer = 1.4;
}

// ---------------------------------------------------------------------------
// 输入（键盘移动由 Player 自己监听，这里只管鼠标和功能键）
// ---------------------------------------------------------------------------

let locked = false;

document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') {
    devPanel.toggle();
  } else if (e.code === 'KeyK') {
    feelConfig.master = !feelConfig.master;
    if (!feelConfig.master) {
      resetTimeControl();
      shake.reset();
    }
    devPanel.refresh();
    showToast(feelConfig.master ? '打击感  ON' : '打击感  OFF');
  } else if (e.code === 'KeyR') {
    weapon.reload();
  } else if (e.code === 'KeyF') {
    // 循环画质档位。卡的时候第一件事就是按它。
    const order: QualityLevel[] = ['low', 'medium', 'high'];
    const next = order[(order.indexOf(quality.level) + 1) % order.length];
    quality.apply(next);
    devPanel.refresh();
    showToast('画质  ' + PRESETS[next].label);
  }
});

/** 当前是否在开镜。toggle 模式下由右键翻转，保持模式下等于「右键是否按住」。 */
let adsOn = false;

function setAds(on: boolean): void {
  adsOn = on;
  weapon.setADS(on);
  player.setADS(on);
}

/**
 * 右键按下时的开镜决策。抽成函数是因为 mousedown 处理器被 pointer-lock 门控挡着
 * （没锁定鼠标时不响应），自动化测试进不去 —— 让测试能调到同一段逻辑。
 */
function onAdsPress(): void {
  setAds(feelConfig.input.adsToggle ? !adsOn : true);
}

renderer.domElement.addEventListener('mousedown', (e) => {
  if (!locked) return;
  if (e.button === 0) weapon.setTrigger(true);
  // toggle 模式：按一下开、再按一下关，不用一直按住右键
  if (e.button === 2) onAdsPress();
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 0) weapon.setTrigger(false);
  // toggle 模式下松开右键什么都不做，镜一直开着
  if (e.button === 2 && !feelConfig.input.adsToggle) setAds(false);
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// 鼠标增量按帧合并，不要每个事件都立刻转向。
// 游戏鼠标是 1000Hz 轮询，一帧内会来十几个 mousemove；逐事件调 look() 会把一次转向
// 拆成多次微小更新，还会在事件回调里反复写相机矩阵 —— 手感上就是「黏」。
// 攒在这里，帧里一次性应用。
let lookDx = 0;
let lookDy = 0;
let pendingLookX = 0;
let pendingLookY = 0;

document.addEventListener('mousemove', (e) => {
  if (!locked) return;
  // 开镜时按 adsT 插值压低灵敏度 —— 用 adsT 而不是布尔量，
  // 举枪过程中灵敏度平滑过渡，不会在开镜瞬间「顿」一下。
  const sens =
    feelConfig.input.lookSens *
    lerp(1, feelConfig.input.adsSensMul, clamp01(weapon.adsT));
  pendingLookX += e.movementX * sens;
  pendingLookY += e.movementY * sens;
});

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!locked) {
    weapon.setTrigger(false);
    setAds(false); // 失去鼠标锁定时强制收镜，避免 toggle 状态卡在开镜
    stopRumble();
  }
});

gate.addEventListener('click', () => {
  if (!ready) return;
  audio.init(); // AudioContext 必须在用户手势里创建
  gate.classList.add('hidden');
  hudRoot.classList.remove('hidden');
  // 开局才放敌人：否则玩家在开始界面上就被 1 号（出生点有视线）打掉一半血
  started = true;
  player.respawn(level.spawnPoint);
  for (let i = 0; i < enemies.length; i++) enemies[i].respawn(level.enemySpawns[i]);
  renderer.domElement.requestPointerLock();
});

// ---------------------------------------------------------------------------
// 画质
// ---------------------------------------------------------------------------

const quality = new Quality({
  renderer,
  camera,
  scene,
  onResize: (w, h) => postfx.resize(w, h), // 内部会同步 renderer.setSize
  onPostChange: () => postfx.syncConfig(),
});
quality.apply(Quality.autoDetect(renderer));

window.addEventListener('resize', () => quality.resize());

// ---------------------------------------------------------------------------
// 敌人视线
// ---------------------------------------------------------------------------

const _seeRay = new THREE.Raycaster();
const _seeDir = new THREE.Vector3();
const _seeOrigin = new THREE.Vector3();
_seeRay.firstHitOnly = true;

/** 从敌人胸口向玩家眼睛打一条射线，被世界几何挡住就看不见 */
function canSee(e: Enemy): boolean {
  if (!e.alive) return false;
  e.object.getWorldPosition(_seeOrigin);
  _seeOrigin.y += 1.2;
  _seeDir.subVectors(camera.position, _seeOrigin);
  const dist = _seeDir.length();
  if (dist > 45) return false;
  _seeDir.normalize();
  _seeRay.set(_seeOrigin, _seeDir);
  _seeRay.far = dist - 0.3;
  return _seeRay.intersectObjects(level.hitMeshes, false).length === 0;
}

// ---------------------------------------------------------------------------
// 倍镜 FOV
// ---------------------------------------------------------------------------
// weapon.adsT 本身已经是 ease-out 平滑过的举枪进度，所以 FOV **直接**对它插值，
// 不要再套一层指数逼近 —— 两层滞后串联会让变焦明显跟不上手（实测收镜时
// adsT 已经掉到 0.165、FOV 却还停在接近全放大的位置）。
// scopeZoom=1 时 lerp(f, f, t) 恒等于 f，等价于「无倍镜」路径。

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

let statAcc = 0;
let statFrames = 0;
let cpuAcc = 0;
let frameStart = 0;

/**
 * 帧调度：rAF 与 setTimeout 竞速，先到者胜，用 generation 计数把慢的那个作废。
 *
 * 浏览器在标签页不可见 / 窗口被遮挡时会暂停 requestAnimationFrame，
 * 循环会整个冻死。竞速调度让它在这种情况下自动降级到定时器驱动，
 * rAF 恢复后又会重新赢下竞速 —— 不需要任何状态机。
 *
 * ⚠ 兜底延迟必须是自适应的。固定 60ms 会在 rAF 被节流时把整个游戏锁死在
 * 16 FPS —— 实测本作一帧只要 ~2.5ms（400 FPS 的余量），却被调度器压成 16 FPS，
 * 表现为「莫名其妙地卡」。所以：
 *   · rAF 正常时兜底设为 FALLBACK_IDLE(150ms)，保证 rAF 永远先到、定时器纯属空转；
 *   · 一旦定时器真的抢到（说明 rAF 停摆），立刻收紧到 FALLBACK_ACTIVE(8ms)；
 *   · 任何一次 rAF 触发都会把它放回 150ms。
 * 代价只有停摆瞬间的一帧延迟。
 */
const FALLBACK_IDLE = 150;
const FALLBACK_ACTIVE = 8;

let gen = 0;
let fallbackDelay = FALLBACK_IDLE;

function schedule(): void {
  const g = ++gen;
  const run = (fromRaf: boolean): void => {
    if (g !== gen) return; // 输掉竞速的那个，直接作废
    gen++;
    fallbackDelay = fromRaf ? FALLBACK_IDLE : FALLBACK_ACTIVE;
    frame();
  };
  requestAnimationFrame(() => run(true));
  setTimeout(() => run(false), fallbackDelay);
}

/** 当前由谁在驱动帧循环 —— rAF 被节流时显示「兜底」，是排查卡顿的第一个线索 */
function driverLabel(): string {
  return fallbackDelay === FALLBACK_IDLE ? 'rAF' : '⚠兜底';
}

// ---------------------------------------------------------------------------
// 分段计时器
// ---------------------------------------------------------------------------
// 关掉时每帧只多两次分支判断。开启后能精确到每个子系统 —— 排查「卡」的时候
// 猜是最没效率的做法，直接量。用 __bs.profile(seconds) 采样。

const profOn = { v: false };
const profAcc: Record<string, number> = {};
let profFrames = 0;
let profMark = 0;

function pStart(): void {
  if (profOn.v) profMark = performance.now();
}
function pEnd(key: string): void {
  if (!profOn.v) return;
  const now = performance.now();
  profAcc[key] = (profAcc[key] ?? 0) + (now - profMark);
  profMark = now;
}

function frame(): void {
  schedule();
  frameStart = performance.now();

  renderer.info.reset();
  time.tick();
  pumpUnscaledTimers();

  const dts = time.scaledDelta; // 受 hit-stop / 慢镜影响
  const dtu = time.unscaledDelta; // 不受影响

  updateTimeControl(dtu);
  pStart();

  // ── 1.5 应用本帧攒下的鼠标增量（一次，不是每个事件一次）──
  if (pendingLookX !== 0 || pendingLookY !== 0) {
    player.look(pendingLookX, pendingLookY);
    lookDx = pendingLookX;
    lookDy = pendingLookY;
    pendingLookX = 0;
    pendingLookY = 0;
  } else {
    lookDx = 0;
    lookDy = 0;
  }

  // ── 2. 身体（scaled）──
  player.update(dts);
  pEnd('player');

  // ── 3. 打击感衰减（unscaled：定帧期间必须继续走）──
  recoil.update(dtu);
  const shakeOffset = shake.update(dtu, time.elapsed);

  // ── 4. 相机最终朝向 = 瞄准 + 后坐 + 震动 ──
  // recoil.pitch 已经包含 climb 分量，不要再加一次（会翻倍）
  player.applyCameraOffsets(shakeOffset, recoil.pitch, recoil.yaw, dtu);
  pEnd('feel');

  // ── 5. 枪模跟随最终相机，刷新 muzzleWorld ──
  viewModel.update(dtu, {
    speed: player.speed,
    onGround: player.onGround,
    adsT: weapon.adsT,
    recoilPitch: recoil.pitch,
    recoilKick: recoil.kickZ,
    lookDx,
    lookDy,
  });
  pEnd('viewmodel');

  // ── 6. 武器（scaled：射速受慢镜影响）──
  weapon.update(dts, player.speed, player.onGround);
  pEnd('weapon');

  // ── 6.5 倍镜 FOV ──
  // 必须在 weapon.update **之后**：adsT 是在那里推进的，放前面会让变焦
  // 永远落后一帧（rAF 被节流时这一帧可达 150ms，肉眼就是「变焦跟不上手」）。
  // adsT 本身已是 ease-out 平滑过的，所以这里直接映射，不再叠加二次缓动 ——
  // 两层滞后串联同样会让收镜时画面还停在放大状态。
  const fovTarget = lerp(BASE_FOV, BASE_FOV / weapon.def.scopeZoom, clamp01(weapon.adsT));
  if (Math.abs(camera.fov - fovTarget) > 1e-4) {
    camera.fov = fovTarget;
    camera.updateProjectionMatrix();
  }

  // ── 7. 敌人 AI（scaled）—— 开局前不激活 ──
  for (const e of enemies) e.update(dts, player.position, started && canSee(e));
  pEnd('enemies+视线');

  // ── 8. 表现层（全部 unscaled）──
  vfx.update(dtu, camera);
  lights.update(dtu);
  tracer.update(dtu);
  decals.update(dtu);
  pEnd('vfx');

  hud.setAmmo(weapon.ammo, weapon.magSize, weapon.reserve);
  hud.setHealth(player.hp, player.armor);
  hud.setSpread(weapon.currentSpread);
  hud.setADS(weapon.adsT);
  hud.setFov(camera.fov); // 变焦后准星换算要用真实 fov
  hud.update(dtu);
  damageText.update(dtu);
  audio.setHealthRatio(player.hp / 100);
  pEnd('hud+音频');

  if (toastTimer > 0) {
    toastTimer -= dtu;
    if (toastTimer <= 0) toast.style.opacity = '0';
  }

  postfx.setADS(weapon.adsT);
  postfx.render(dtu);
  pEnd('render');
  if (profOn.v) profFrames++;

  // ── 统计 ──
  // cpuMs 是本帧从 tick 到提交渲染命令的墙钟耗时。它和 FPS 一起看才有意义：
  // cpuMs 很小但 FPS 也很低 → 瓶颈不在游戏里，而在调度（rAF 被节流）或垂直同步。
  const cpuMs = performance.now() - frameStart;
  cpuAcc += cpuMs;
  statAcc += dtu;
  statFrames++;
  if (statAcc >= 0.5) {
    const fps = Math.round(statFrames / statAcc);
    const avgCpu = cpuAcc / statFrames;
    hud.setStats(
      feelConfig.debug.showStats
        ? `${fps} FPS · 帧耗时 ${avgCpu.toFixed(2)}ms · ${driverLabel()} · ` +
            `粒子 ${vfx.activeCount} · draw ${renderer.info.render.calls} · ` +
            `tri ${(renderer.info.render.triangles / 1000).toFixed(0)}k · ` +
            `贴花 ${decals.activeCount} · 打击感 ${feelConfig.master ? 'ON' : 'OFF'}`
        : ''
    );
    statAcc = 0;
    statFrames = 0;
    cpuAcc = 0;
  }
}

// ---------------------------------------------------------------------------
// 就绪
// ---------------------------------------------------------------------------

let ready = false;
let started = false; // 点过开始界面才激活敌人

/**
 * 着色器预热。
 *
 * three 的材质是**惰性编译**的：一个 shader program 直到第一次真正被画出来才会编译，
 * 而 postprocessing 的 Bloom / 色差 / ToneMapping 都是大 shader。不预热的话，
 * 进场头几秒和**第一次开枪**（枪口火光、曳光弹、贴花、火花的材质首次上屏）
 * 会有肉眼可见的顿挫 —— 表现为「莫名其妙地卡」，而且只在最关键的第一枪出现。
 *
 * 做法：在开始界面还挡着的时候，把所有特效在镜头外触发一遍并跑几帧完整管线，
 * 强制编译所有 program，然后清干净。用户点开始时一切都是热的。
 */
function warmUp(): { ms: number; programs: number; passes: number } {
  const t0 = performance.now();
  const savedPos = camera.position.clone();
  const savedRot = camera.rotation.clone();
  const kinds = ['concrete', 'brick', 'metal', 'wood', 'glass', 'dirt', 'flesh'] as const;

  const progCount = (): number => renderer.info.programs?.length ?? 0;

  /**
   * 把所有会产生新 shader 变体的东西全触发一遍。
   *
   * 视角很关键：three 只为**实际画出来的**（材质 × 几何属性布局 × 灯光/阴影状态）
   * 组合编译 program。所以必须从玩家真正会看到的位置和朝向渲染，
   * 否则预热出来的变体集合和实战对不上 —— 实测差了 25 个 program，
   * 表现为头两枪各卡 0.4~0.8 秒。
   */
  const exercise = (pass: number): void => {
    // 轮流站在出生点和巷子中段，覆盖玩家真实会有的视野
    const anchors = [
      new THREE.Vector3(level.spawnPoint.x, 1.74, level.spawnPoint.z),
      new THREE.Vector3(0, 1.74, level.spawnPoint.z - 12),
      new THREE.Vector3(0, 1.74, level.spawnPoint.z - 26),
    ];
    const eye = anchors[pass % anchors.length];
    camera.position.copy(eye);
    camera.rotation.set(0, (pass % 2 === 0 ? 0 : Math.PI) + (pass * 0.35), 0);
    camera.updateMatrixWorld(true);

    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    muzzle.fire(eye, dir);
    tracer.spawn(eye, eye.clone().addScaledVector(dir, 10));

    // 每种材质 × 每个目标网格：贴花与弹着的 shader 变体和目标几何有关
    for (let i = 0; i < kinds.length; i++) {
      const mesh = level.hitMeshes[i % level.hitMeshes.length];
      impact.play(eye.clone().addScaledVector(dir, 2 + i * 0.3), dir.clone().negate(), kinds[i], mesh, dir);
    }

    // 走**真实开火路径**：手写清单永远会漏（抛壳网格、敌人受击闪白、击杀倒地
    // 这些都会产生自己的 shader 变体）。让真实代码自己把变体走出来最可靠。
    viewModel.onFire();
    weapon.setTrigger(true);
    for (let i = 0; i < 4; i++) weapon.update(1 / 20, 0, true);
    weapon.setTrigger(false);
    // 对着每个敌人打一发，逼出受击/闪白/死亡的材质变体
    for (const e of enemies) {
      if (!e.alive) continue;
      const p = new THREE.Vector3();
      e.object.getWorldPosition(p);
      p.y += 1.2;
      camera.lookAt(p);
      camera.updateMatrixWorld(true);
      weapon.setTrigger(true);
      weapon.update(1 / 10, 0, true);
      weapon.setTrigger(false);
    }

    // 让粒子池里真的有活着的实例（count=0 的 InstancedMesh 不会被编译）
    for (let i = 0; i < 3; i++) {
      vfx.update(1 / 240, camera);
      lights.update(1 / 240);
      tracer.update(1 / 240);
      decals.update(1 / 240);
      // ADS 两个分支、后处理开关两条路径都要走到
      postfx.setADS(i === 1 ? 1 : 0);
      postfx.render(1 / 60);
    }
  };

  // 静态场景与角色材质（含阴影 depth 变体）
  renderer.compile(scene, camera);

  // 迭代到 program 数不再增长为止 —— 手写清单一定会漏，让它自己收敛。
  // 要求**连续两轮**零增长：单轮零增长会误判（某些变体要下一轮的视角才触发）。
  let passes = 0;
  let stable = 0;
  for (let p = 0; p < 14 && stable < 2; p++) {
    const before = progCount();
    exercise(p);
    passes++;
    stable = progCount() === before ? stable + 1 : 0;
  }

  // 清干净，不要把预热痕迹留给玩家
  decals.clear();
  shake.reset();
  recoil.reset();
  recoil.update(1);
  postfx.setADS(0);
  weapon.setTrigger(false);
  weapon.cancelReload();
  weapon.refill();
  resetTimeControl();
  for (let i = 0; i < enemies.length; i++) enemies[i].respawn(level.enemySpawns[i]);
  viewModel.reset();
  camera.position.copy(savedPos);
  camera.rotation.copy(savedRot);
  camera.updateMatrixWorld(true);

  return { ms: Math.round(performance.now() - t0), programs: progCount(), passes };
}

gateLoad.textContent = '正在预热着色器…';

// 让「正在预热」这一帧先画出来，再做会阻塞主线程的编译。
// ⚠ 这个启动门不能只挂在 rAF 上：窗口不可见时 rAF 根本不触发，游戏会永远停在
// 开始界面。和主循环一样用竞速兜底。
let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  const w = warmUp();
  gateLoad.textContent = '';
  gateHint.style.display = '';
  ready = true;
  console.info(
    `[backstreet] 预热完成 ${w.ms}ms · ${w.programs} 个 shader program · ${w.passes} 轮收敛`
  );
  frame();
}
requestAnimationFrame(boot);
setTimeout(boot, 250);

// 开发期调试句柄 —— 便于在控制台/自动化里探测各系统状态
;(window as unknown as Record<string, unknown>).__bs = {
  time,
  feelConfig,
  scene,
  camera,
  renderer,
  postfx,
  quality,
  muzzle,
  impact,
  tracer,
  lights,
  player,
  enemies,
  weapon,
  viewModel,
  recoil,
  shake,
  vfx,
  decals,
  level,
  audio,
  hud,
  damageText,
  /**
   * 采样 N 秒的真实帧分段耗时。这是排查卡顿的正确工具 ——
   * 在真实 rAF 循环里量，而不是把子系统拎出来单独跑（那样会漏掉相互作用）。
   */
  profile(seconds = 3): Promise<string> {
    for (const k of Object.keys(profAcc)) delete profAcc[k];
    profFrames = 0;
    profOn.v = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        profOn.v = false;
        const n = Math.max(1, profFrames);
        const rows = Object.entries(profAcc)
          .map(([k, v]) => [k, +(v / n).toFixed(3)] as [string, number])
          .sort((a, b) => b[1] - a[1]);
        const total = rows.reduce((s, r) => s + r[1], 0);
        resolve(
          JSON.stringify({
            帧数: profFrames,
            采样秒: seconds,
            实测FPS: +(profFrames / seconds).toFixed(1),
            每帧总计ms: +total.toFixed(3),
            驱动: driverLabel(),
            分段ms: Object.fromEntries(rows),
          })
        );
      }, seconds * 1000);
    });
  },
  /** 当前是否开镜（toggle 状态）。只读探测用。 */
  get adsOn(): boolean {
    return adsOn;
  },
  /** 模拟按一次右键 —— 走的是和真实 mousedown 完全相同的开镜决策 */
  pressAds(): void {
    onAdsPress();
  },
  /** 强行开一枪（不需要指针锁定），用于验证整条打击感链路 */
  testFire(n = 1): void {
    weapon.setTrigger(true);
    for (let i = 0; i < n; i++) weapon.update(60 / AR15.rpm, 0, true);
    weapon.setTrigger(false);
  },
  /** 把相机指向某个敌人，用于验证命中链路 */
  aimAt(i = 0): void {
    const e = enemies[i];
    if (!e) return;
    const p = new THREE.Vector3();
    e.object.getWorldPosition(p);
    p.y += 1.2;
    camera.lookAt(p);
  },
  snapshot(): string {
    return JSON.stringify({
      frameDriver: gen,
      elapsed: +time.elapsed.toFixed(2),
      timeScale: +time.timeScale.toFixed(3),
      playerPos: player.position.toArray().map((v) => +v.toFixed(2)),
      hp: player.hp,
      armor: player.armor,
      ammo: weapon.ammo,
      reserve: weapon.reserve,
      spread: +weapon.currentSpread.toFixed(2),
      trauma: +shake.value.toFixed(3),
      recoilPitch: +recoil.pitch.toFixed(4),
      particles: vfx.activeCount,
      decals: decals.activeCount,
      enemies: enemies.map((e) => ({ id: e.id, hp: e.hp, alive: e.alive })),
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    });
  },
};

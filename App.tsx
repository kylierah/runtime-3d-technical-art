// tslint:disable
/* eslint-disable */
import {
  ChevronRight,
  Crosshair,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {getConfig} from './constants';
import {Game, SoldierDebugInfo} from './Game';
import {createInitialInputSnapshot, type InputSnapshot} from './input';
import BackgroundMusic from './utils/BackgroundMusic';
import {
  gameAudio,
  GameState,
  useIsMobile,
} from './utils/helper';
import {
  usePlayground,
  usePlaygroundGameLifecycle,
  usePlaygroundResume,
  useRpc,
} from './utils/usePlayground';

interface CustomWindow extends Window {
  canHandleBackKey?: boolean;
}

const JOYSTICK_RADIUS_PX = 36;

/**
 * Mobile touch controls overlay (tactical angular minimal styling)
 */
function MobileControls({
  inputRef,
  onFire,
  onReload,
}: {
  inputRef: React.MutableRefObject<InputSnapshot>;
  onFire: () => void;
  onReload: () => void;
}): React.ReactElement {
  const activePointerIdRef = useRef<number | null>(null);
  const [knobOffset, setKnobOffset] = useState<{x: number; y: number}>({
    x: 0,
    y: 0,
  });

  const resetJoystick = useCallback(() => {
    activePointerIdRef.current = null;
    inputRef.current.analogMove = {x: 0, y: 0};
    setKnobOffset({x: 0, y: 0});
  }, [inputRef]);

  useEffect(() => {
    window.addEventListener('blur', resetJoystick);
    return () => {
      window.removeEventListener('blur', resetJoystick);
      inputRef.current.analogMove = {x: 0, y: 0};
    };
  }, [inputRef, resetJoystick]);

  const updateStickFromEvent = (
    e: React.PointerEvent<HTMLDivElement>,
  ): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rawDx = e.clientX - cx;
    const rawDy = e.clientY - cy;
    const dist = Math.hypot(rawDx, rawDy);
    const scale = dist > JOYSTICK_RADIUS_PX ? JOYSTICK_RADIUS_PX / dist : 1;
    const clampedX = rawDx * scale;
    const clampedY = rawDy * scale;
    inputRef.current.analogMove = {
      x: clampedX / JOYSTICK_RADIUS_PX,
      y: clampedY / JOYSTICK_RADIUS_PX,
    };
    setKnobOffset({x: clampedX, y: clampedY});
  };

  const handleStickDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (
      activePointerIdRef.current !== null &&
      activePointerIdRef.current !== e.pointerId
    ) {
      return;
    }
    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateStickFromEvent(e);
  };

  const handleStickMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.stopPropagation();
    updateStickFromEvent(e);
  };

  const handleStickEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (activePointerIdRef.current !== e.pointerId) return;
    e.stopPropagation();
    resetJoystick();
  };

  return (
    <div className="absolute inset-0 pointer-events-none z-20 select-none">
      {/* Movement Virtual D-Pad */}
      <div
        aria-label="Movement joystick"
        data-testid="mobile-joystick"
        onPointerDown={handleStickDown}
        onPointerMove={handleStickMove}
        onPointerUp={handleStickEnd}
        onPointerCancel={handleStickEnd}
        onLostPointerCapture={handleStickEnd}
        className="absolute left-6 bottom-8 w-24 h-24 border border-zinc-700 bg-black/60 pointer-events-auto touch-none flex items-center justify-center font-mono">
        <div className="w-1 h-1 bg-red-600/80 absolute" />
        <div
          style={{
            transform: `translate3d(${knobOffset.x}px, ${knobOffset.y}px, 0)`,
          }}
          className="w-10 h-10 border border-zinc-400 bg-zinc-800/80 pointer-events-none flex items-center justify-center">
          <div className="w-1.5 h-1.5 bg-[#f2f0eb]" />
        </div>
      </div>

      {/* Action Cluster (Fire + Reload) */}
      <div className="absolute right-6 bottom-8 flex items-center gap-3 pointer-events-auto touch-none">
        <button
          type="button"
          aria-label="Reload"
          onClick={onReload}
          className="w-14 h-14 min-w-[48px] min-h-[48px] bg-zinc-900/90 active:bg-zinc-800 border border-zinc-700 text-[#78808a] active:text-[#f2f0eb] font-mono text-[11px] flex flex-col items-center justify-center tracking-wider">
          <RotateCcw size={16} />
          <span className="text-[9px] mt-1 font-mono">[R]</span>
        </button>
        <button
          type="button"
          aria-label="Fire"
          onClick={onFire}
          className="w-16 h-16 min-w-[48px] min-h-[48px] bg-[#d93829]/90 active:bg-[#b52b1e] border border-red-500 text-[#f2f0eb] font-sans font-bold text-xs tracking-[0.14em] flex items-center justify-center">
          FIRE
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const {sdk, isReady} = usePlayground();
  const [exitChat] = useRpc<Record<string, unknown>, void>('ExitChat');
  const isMobile = useIsMobile();
  const sharedInputRef = useRef<InputSnapshot>(createInitialInputSnapshot());

  // Save/Resume wiring
  const {initialLevel, initialScore, persistenceEnabled, autoStartPending} =
    usePlaygroundResume({
      isReady,
      onAutoStart: () => {
        if (gameStateRef.current.status === 'START') {
          initGame();
        }
      },
    });

  const startLevel = initialLevel;
  const startScore = initialScore;
  const levelStartScoreRef = useRef(startScore);
  const prevLevelRef = useRef(startLevel);
  const runWonRef = useRef(false);

  const [gameState, setGameState] = useState<GameState>({
    status: 'START',
    score: startScore,
    level: startLevel,
  });

  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;

  const [gameKey, setGameKey] = useState(0);

  // Ammunition State: Mag & Reserves
  const [ammo, setAmmo] = useState({
    mag: getConfig('magCapacity'),
    reserve: getConfig('startingAmmo'),
  });

  // PointerLock & UI states
  const [isLocked, setIsLocked] = useState(false);
  const [isGameMenuOpen, setIsGameMenuOpen] = useState(false);
  const [isHowToPlayOpen, setIsHowToPlayOpen] = useState(false);
  const [isAmbianceMuted, setIsAmbianceMuted] = useState(false);
  const [isSfxMuted, setIsSfxMuted] = useState(false);
  const [showHitMarker, setShowHitMarker] = useState(false);

  // Technical Art Debug & Performance Profiler panel toggle (F3 or `)
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [testAnim, setTestAnim] = useState<'idle' | 'shoot' | 'fall'>('shoot');
  const [soldierDebug, setSoldierDebug] = useState<Partial<SoldierDebugInfo>>({
    soldierStatus: 'Loading...',
    shootAnimStatus: 'Loading...',
    fallAnimStatus: 'Loading...',
    gunStatus: 'Loading...',
    worldPos: '[-3.8, 0.00, -11.5]',
    scale: '[1.00, 1.00, 1.00]',
    activeAnim: 'idle',
    meshBoneCount: 'Scanning...',
    finalHeight: 'Measuring...',
  });

  const handleUpdateDebug = useCallback((info: Partial<SoldierDebugInfo>) => {
    setSoldierDebug((prev) => ({...prev, ...info}));
  }, []);

  // Keyboard shortcut for toggling debug panel (F3 or backtick `)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F3' || e.key === '`') {
        e.preventDefault();
        setShowDebugPanel((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Manage Cold Tactical Ambient Soundscape (Sub-bass drone & wind/static)
  useEffect(() => {
    if (['PLAYING', 'VICTORY'].includes(gameState.status) && !isGameMenuOpen && !isAmbianceMuted) {
      gameAudio.startTacticalAmbiance();
    } else {
      gameAudio.stopTacticalAmbiance();
    }
  }, [gameState.status, isGameMenuOpen, isAmbianceMuted]);

  const triggerHitMarker = useCallback(() => {
    setShowHitMarker(true);
    setTimeout(() => setShowHitMarker(false), 80);
  }, []);

  useEffect(() => {
    if (gameState.level !== prevLevelRef.current) {
      prevLevelRef.current = gameState.level;
      levelStartScoreRef.current = gameStateRef.current.score;
    }
  }, [gameState.level]);

  useEffect(() => {
    if (gameState.status === 'VICTORY') {
      runWonRef.current = true;
    }
  }, [gameState.status]);

  // Window back-key cast
  useEffect(() => {
    const canHandleBackKey = ['PLAYING', 'PAUSED', 'VICTORY'].includes(gameState.status);
    (window as unknown as CustomWindow).canHandleBackKey = canHandleBackKey;
  }, [gameState.status]);

  // Start run helper
  const startRun = useCallback(
    (level: number, score: number) => {
      levelStartScoreRef.current = score;
      prevLevelRef.current = level;
      runWonRef.current = false;
      Object.assign(sharedInputRef.current, createInitialInputSnapshot());
      setAmmo({
        mag: getConfig('magCapacity'),
        reserve: getConfig('startingAmmo'),
      });
      setIsGameMenuOpen(false);
      setIsHowToPlayOpen(false);
      setGameState((prev) => ({
        ...prev,
        status: 'PLAYING',
        level,
        score,
      }));
      setGameKey((prev) => prev + 1);

      if (sdk) {
        sdk.startGame();
      }
    },
    [sdk],
  );

  const initGame = useCallback(() => {
    if (persistenceEnabled && !runWonRef.current) {
      startRun(gameStateRef.current.level, levelStartScoreRef.current);
    } else {
      startRun(1, 0);
    }
  }, [startRun, persistenceEnabled]);

  const resetGame = useCallback(() => {
    startRun(1, 0);
  }, [startRun]);

  usePlaygroundGameLifecycle(gameState, sdk);

  // Auto-start autoplay query
  const hasAutoplayed = useRef(false);
  useEffect(() => {
    if (
      !hasAutoplayed.current &&
      new URLSearchParams(window.location.search).has('autoplay')
    ) {
      hasAutoplayed.current = true;
      initGame();
    }
  }, [initGame]);

  // Escape key toggles in-game menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ['PLAYING', 'VICTORY'].includes(gameState.status)) {
        setIsGameMenuOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState.status]);

  const isMusicPlaying = ['PLAYING', 'VICTORY'].includes(gameState.status) && !isGameMenuOpen;

  const handleMobileFire = useCallback(() => {
    sharedInputRef.current.actions.confirm = true;
    setTimeout(() => {
      sharedInputRef.current.actions.confirm = false;
    }, 50);
  }, []);

  const handleMobileReload = useCallback(() => {
    const magCap = getConfig('magCapacity');
    setAmmo((prev) => {
      if (prev.mag >= magCap || prev.reserve <= 0) return prev;
      const needed = magCap - prev.mag;
      const taking = Math.min(needed, prev.reserve);
      gameAudio.playConfirmSelect();
      return {
        mag: prev.mag + taking,
        reserve: prev.reserve - taking,
      };
    });
  }, []);

  // Compute active neutralized target count from score
  const targetsRemaining = Math.max(0, 3 - Math.floor(gameState.score / 100));

  return (
    <div className="fixed inset-0 overflow-hidden touch-none flex flex-col bg-[#0a0c0e] text-[#f2f0eb] select-none font-mono">
      {/* 1. Global Font Stylesheet Injector & Helper Variables */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Orbitron:wght@700;800;900&family=Rajdhani:wght@500;600;700&display=swap');

        .font-display {
          font-family: 'Orbitron', -apple-system, sans-serif;
          font-weight: 800;
          letter-spacing: 0.08em;
          line-height: 1.05;
        }

        .font-action {
          font-family: 'Rajdhani', -apple-system, sans-serif;
          font-weight: 700;
          letter-spacing: 0.14em;
        }

        .font-action-label {
          font-family: 'Rajdhani', -apple-system, sans-serif;
          font-weight: 600;
          letter-spacing: 0.12em;
        }

        .font-telemetry {
          font-family: 'JetBrains Mono', monospace;
          font-variant-numeric: tabular-nums;
        }
      `}</style>

      {/* 2. Diegetic 1px Tactical Viewfinder Ticks framing the four corners */}
      <div className="absolute inset-0 pointer-events-none z-30">
        {/* Top-Left Viewfinder Tick */}
        <div className="absolute top-4 left-4 w-4 h-4 border-t border-l border-zinc-600/70" />
        {/* Top-Right Viewfinder Tick */}
        <div className="absolute top-4 right-4 w-4 h-4 border-t border-r border-zinc-600/70" />
        {/* Bottom-Left Viewfinder Tick */}
        <div className="absolute bottom-4 left-4 w-4 h-4 border-b border-l border-zinc-600/70" />
        {/* Bottom-Right Viewfinder Tick */}
        <div className="absolute bottom-4 right-4 w-4 h-4 border-b border-r border-zinc-600/70" />
      </div>

      {/* Top Telemetry & Menu Bar */}
      {['PLAYING', 'VICTORY'].includes(gameState.status) && (
        <header className="w-full h-12 px-6 flex items-center justify-between shrink-0 z-30 border-b border-zinc-800/80 bg-[#0a0c0e]/80 backdrop-blur-xs font-telemetry">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 bg-[#d93829]" />
            <span className="text-[11px] font-action font-bold text-[#f2f0eb] tracking-[0.14em] uppercase">
              SECTOR 04 // LIVE ENGAGEMENT
            </span>
            <span className="text-[10px] text-[#78808a] font-telemetry hidden sm:inline">
              [GRID 34.05°N // WAREHOUSE RUINS]
            </span>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setIsGameMenuOpen(true)}
              className="px-3 py-1 bg-transparent hover:bg-zinc-800/80 border border-zinc-700/80 text-[12px] font-action text-[#f2f0eb] tracking-[0.14em] transition-colors">
              <span>SYSTEM MENU</span>
              <span className="text-[9px] text-[#78808a] ml-1.5 font-telemetry hidden sm:inline">[ESC]</span>
            </button>
          </div>
        </header>
      )}

      {/* Main 3D Canvas Area */}
      <main className="flex-1 w-full min-h-0 relative flex items-center justify-center">
        <Game
          key={gameKey}
          gameState={gameState}
          setGameState={setGameState}
          exitChat={exitChat}
          gameStateRef={gameStateRef}
          externalInputRef={sharedInputRef}
          ammo={ammo}
          setAmmo={setAmmo}
          setIsLocked={setIsLocked}
          showHitMarker={showHitMarker}
          triggerHitMarker={triggerHitMarker}
          isGameMenuOpen={isGameMenuOpen}
          testAnim={testAnim}
          onUpdateDebug={handleUpdateDebug}
        />

        {/* Minimal Central Reticle (+) */}
        {['PLAYING', 'VICTORY'].includes(gameState.status) && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
            <div className="relative flex items-center justify-center">
              {/* Horizontal line */}
              <div
                className={`w-3.5 h-[1.5px] transition-colors ${
                  showHitMarker ? 'bg-[#d93829] scale-125' : 'bg-[#f2f0eb]/90'
                }`}
              />
              {/* Vertical line */}
              <div
                className={`h-3.5 w-[1.5px] absolute transition-colors ${
                  showHitMarker ? 'bg-[#d93829] scale-125' : 'bg-[#f2f0eb]/90'
                }`}
              />
              {/* Precision center dot */}
              <div
                className={`w-1 h-1 rounded-none absolute ${
                  showHitMarker ? 'bg-[#d93829]' : 'bg-[#c89d5c]'
                }`}
              />
              {/* Hitmarker ticks */}
              {showHitMarker && (
                <div className="absolute w-7 h-7 pointer-events-none animate-ping">
                  <div className="w-full h-full border border-[#d93829] rotate-45" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tactical Click-to-Aim Prompt (when unlocked on desktop) */}
        {['PLAYING', 'VICTORY'].includes(gameState.status) && !isMobile && !isLocked && !isGameMenuOpen && (
          <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-[#0a0c0e]/90 border border-zinc-700 px-4 py-1.5 pointer-events-none z-20 flex items-center gap-2">
            <div className="w-1.5 h-1.5 bg-[#c89d5c]" />
            <span className="text-[12px] text-[#f2f0eb] font-action tracking-[0.14em] uppercase">
              CLICK VIEWPORT TO ENGAGE OPTICS // POINTER LOCK
            </span>
          </div>
        )}

        {/* Top-Left In-Game Objective Tracker (Minimalist Uppercase Telemetry) */}
        {['PLAYING', 'VICTORY'].includes(gameState.status) && (
          <div className="absolute top-6 left-8 pointer-events-none z-20 flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-[11px] text-[#78808a] uppercase font-action-label tracking-[0.12em]">
              <span>OP OBJECTIVE // PRIORITY ALPHA</span>
            </div>
            <div className="w-48 h-[1px] bg-zinc-800" />
            <div className="flex items-baseline justify-between w-48 text-[11px] font-telemetry">
              <span className="text-[#78808a]">TARGETS:</span>
              <span className={targetsRemaining === 0 ? 'text-[#c89d5c] font-bold' : 'text-[#f2f0eb] font-bold'}>
                {targetsRemaining.toString().padStart(2, '0')}
              </span>
            </div>
            <div className="flex items-baseline justify-between w-48 text-[11px] font-telemetry">
              <span className="text-[#78808a]">SCORE:</span>
              <span className="text-[#c89d5c] font-bold">{gameState.score} PTS</span>
            </div>
            <div className="w-48 h-[1px] bg-zinc-800" />
          </div>
        )}

        {/* Bottom-Right Weapon Readout (AAA Diegetic Clean Haired Layout - No Box) */}
        {['PLAYING', 'VICTORY'].includes(gameState.status) && (
          <aside className="absolute right-8 bottom-8 pointer-events-none z-20 flex flex-col items-end select-none">
            <div className="text-[12px] text-[#78808a] font-action tracking-[0.14em] uppercase mb-1">
              7.62MM CQB // SEMI-AUTO
            </div>
            <div className="flex items-baseline gap-3">
              {/* Tabular Large Magazine Count */}
              <span
                className={`text-5xl font-black font-telemetry tracking-tight tabular-nums ${
                  ammo.mag <= 3 ? 'text-[#d93829] animate-pulse' : 'text-[#f2f0eb]'
                }`}>
                {ammo.mag.toString().padStart(2, '0')}
              </span>
              {/* Hairline Divider */}
              <span className="w-[1px] h-8 bg-zinc-700/80 inline-block self-center" />
              {/* Smaller Reserve Count */}
              <span className="text-xl font-bold font-telemetry text-[#78808a] tracking-normal">
                / {ammo.reserve.toString().padStart(2, '0')}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-telemetry">
                TACTICAL RELOAD [R]
              </span>
              <div className={`w-1.5 h-1.5 ${ammo.mag > 0 ? 'bg-[#c89d5c]' : 'bg-[#d93829]'}`} />
            </div>
          </aside>
        )}

        {/* Toggled Technical Art Debug & Performance Profiler (F3 / `) */}
        {showDebugPanel && (
          <div className="absolute top-16 left-6 z-40 flex flex-col gap-2 pointer-events-auto select-none font-telemetry">
            {/* Animation Switcher Controls */}
            <div className="flex items-center gap-1.5 bg-[#0a0c0e]/95 backdrop-blur-md px-3 py-2 border border-white/15 shadow-2xl rounded-none">
              <span className="text-[10px] text-[#78808a] font-bold uppercase tracking-wider mr-1">
                TEST ANIM:
              </span>
              {(['idle', 'shoot', 'fall'] as const).map((anim) => (
                <button
                  key={anim}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTestAnim(anim);
                  }}
                  className={`px-2 py-0.5 text-[10px] uppercase font-bold transition-all border ${
                    testAnim === anim
                      ? 'bg-[#c89d5c] text-black border-[#c89d5c]'
                      : 'bg-zinc-900 hover:bg-zinc-800 text-[#78808a] border-zinc-700'
                  }`}>
                  {anim}
                </button>
              ))}
            </div>

            {/* Live Pipeline Telemetry Card */}
            <div className="bg-[#0a0c0e]/95 backdrop-blur-md p-3 border border-white/15 text-[11px] font-mono leading-tight flex flex-col gap-1.5 shadow-2xl w-72 rounded-none">
              <div className="flex items-center justify-between pb-1.5 border-b border-zinc-800">
                <span className="text-[#c89d5c] font-bold tracking-wider uppercase">
                  TA DEBUG // PROFILER
                </span>
                <span className="text-[10px] text-[#78808a]">[F3 TOGGLE]</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Main Soldier:</span>
                <span className={soldierDebug.soldierStatus?.includes('Loaded') ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                  {soldierDebug.soldierStatus}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Shoot Anim:</span>
                <span className={soldierDebug.shootAnimStatus?.includes('Loaded') ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                  {soldierDebug.shootAnimStatus}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Fall Anim:</span>
                <span className={soldierDebug.fallAnimStatus?.includes('Loaded') ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                  {soldierDebug.fallAnimStatus}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Rifle GLB:</span>
                <span className={soldierDebug.gunStatus?.includes('Loaded') ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                  {soldierDebug.gunStatus}
                </span>
              </div>
              <div className="flex justify-between pt-1 border-t border-zinc-800/80">
                <span className="text-[#78808a]">World Pos:</span>
                <span className="text-[#f2f0eb] font-bold">{soldierDebug.worldPos}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Scale:</span>
                <span className="text-[#c89d5c] font-bold">{soldierDebug.scale}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Meshes / Bones:</span>
                <span className="text-[#f2f0eb] font-bold">{soldierDebug.meshBoneCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Final Height:</span>
                <span className="text-emerald-400 font-bold">{soldierDebug.finalHeight}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#78808a]">Active Clip:</span>
                <span className="text-[#c89d5c] font-bold uppercase">{soldierDebug.activeAnim}</span>
              </div>
            </div>
          </div>
        )}

        {/* Mobile On-Screen Controls */}
        {['PLAYING', 'VICTORY'].includes(gameState.status) && isMobile && (
          <MobileControls
            inputRef={sharedInputRef}
            onFire={handleMobileFire}
            onReload={handleMobileReload}
          />
        )}
      </main>

      {/* Asymmetric Left-Aligned Front-End: START Screen */}
      {gameState.status === 'START' && !autoStartPending && (
        <div className="fixed inset-0 z-50 flex pointer-events-auto">
          {/* Left Dark Gradient Framing - Live 3D scene completely visible on the right */}
          <div className="w-full sm:max-w-lg md:max-w-xl h-full bg-gradient-to-r from-[#0a0c0e] via-[#0a0c0e]/95 to-transparent p-8 md:p-12 flex flex-col justify-between border-r border-zinc-800/40">
            {/* Header Telemetry */}
            <div className="flex flex-col gap-2">
              <div className="inline-flex items-center gap-2 font-telemetry">
                <span className="px-1.5 py-0.5 bg-[#d93829] text-[10px] font-black tracking-widest text-[#f2f0eb] uppercase">
                  CLASSIFIED // FIELD OP 04
                </span>
                <span className="text-[10px] text-[#78808a] uppercase tracking-wider">
                  LOC: 34.05°N // BREACH SECTOR Z-29
                </span>
              </div>
              <h1 className="text-4xl md:text-5xl font-display uppercase text-[#f2f0eb] mt-2">
                TACTICAL BREACH
              </h1>
              <div className="w-24 h-[2px] bg-[#c89d5c] mt-2 mb-1" />
              <p className="text-xs text-[#78808a] leading-relaxed max-w-sm mt-1 font-telemetry">
                Infiltrate cold industrial ruins. Neutralize reinforced hostile targets fortified across the sector. Precision fire and tactical discipline authorized.
              </p>
            </div>

            {/* Menu Actions (Clean left-aligned rows with sharp 3px accent indicator) */}
            <div className="flex flex-col gap-2 my-auto max-w-sm">
              <button
                type="button"
                onClick={initGame}
                autoFocus
                data-testid="start-button"
                className="group relative flex items-center justify-between p-3.5 bg-zinc-950/70 hover:bg-zinc-900/90 border border-zinc-800 transition-all text-left">
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-[#d93829] group-hover:bg-[#c89d5c] transition-colors" />
                <div className="flex items-center gap-3 pl-2">
                  <ChevronRight size={16} className="text-[#d93829] group-hover:translate-x-1 transition-transform" />
                  <span className="text-sm font-action uppercase text-[#f2f0eb]">
                    DEPLOY MISSION
                  </span>
                </div>
                <span className="text-[10px] text-[#78808a] font-telemetry group-hover:text-[#f2f0eb] transition-colors">
                  [ENTER]
                </span>
              </button>

              <button
                type="button"
                onClick={() => setIsHowToPlayOpen(true)}
                className="group relative flex items-center justify-between p-3 bg-zinc-950/40 hover:bg-zinc-900/80 border border-zinc-800/80 transition-all text-left">
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-transparent group-hover:bg-[#c89d5c] transition-colors" />
                <div className="flex items-center gap-3 pl-2">
                  <span className="text-xs font-action-label uppercase text-[#78808a] group-hover:text-[#f2f0eb] transition-colors">
                    TACTICAL BRIEFING
                  </span>
                </div>
                <span className="text-[10px] text-[#78808a] font-telemetry">
                  [INFO]
                </span>
              </button>
            </div>

            {/* Bottom Keycap / Telemetry Reference */}
            <div className="border-t border-zinc-800/80 pt-4 flex flex-col gap-2">
              <div className="text-[11px] text-[#78808a] uppercase font-action-label tracking-[0.14em]">
                OPERATIONAL CONTROLS
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-telemetry">
                <div className="flex items-center justify-between">
                  <span className="text-[#78808a]">MOVE:</span>
                  <span className="text-[#f2f0eb] font-bold">[WASD]</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#78808a]">ENGAGE:</span>
                  <span className="text-[#f2f0eb] font-bold">[LMB]</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#78808a]">LOOK:</span>
                  <span className="text-[#f2f0eb] font-bold">[MOUSE]</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#78808a]">RELOAD:</span>
                  <span className="text-[#f2f0eb] font-bold">[R]</span>
                </div>
              </div>
            </div>
          </div>

          {/* Subtle Reviewer Hint in Bottom-Right Corner of Start Screen */}
          <div className="absolute bottom-4 right-6 pointer-events-none z-40 flex items-center gap-2 text-[10px] font-telemetry text-[#78808a]/70">
            <span className="px-1.5 py-0.5 border border-zinc-700/60 bg-black/40 text-[#c89d5c]">
              F3 / `
            </span>
            <span>TA DEBUGGER</span>
          </div>
        </div>
      )}

      {/* Asymmetric In-Game Pause Menu */}
      {isGameMenuOpen && (
        <div className="fixed inset-0 z-50 flex pointer-events-auto bg-black/40 backdrop-blur-xs">
          <div className="w-full sm:max-w-md h-full bg-[#0a0c0e]/95 p-8 flex flex-col justify-between border-r border-zinc-800">
            <div>
              <div className="inline-flex items-center gap-2 mb-2 font-telemetry">
                <span className="w-2 h-2 bg-[#c89d5c]" />
                <span className="text-[10px] font-bold tracking-widest text-[#78808a] uppercase">
                  TAC-OPS // SUSPENDED
                </span>
              </div>
              <h2 className="text-2xl font-display uppercase text-[#f2f0eb]">
                SYSTEM PAUSED
              </h2>
              <div className="w-16 h-[2px] bg-[#d93829] mt-2 mb-6" />

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setIsGameMenuOpen(false)}
                  autoFocus
                  className="group relative flex items-center justify-between p-3 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 transition-all text-left">
                  <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-[#d93829] group-hover:bg-[#c89d5c] transition-colors" />
                  <span className="text-xs font-action uppercase text-[#f2f0eb] pl-2">
                    RESUME MISSION
                  </span>
                  <span className="text-[10px] text-[#78808a] font-telemetry">[ESC]</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsGameMenuOpen(false);
                    startRun(gameStateRef.current.level, levelStartScoreRef.current);
                  }}
                  className="group relative flex items-center justify-between p-3 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 transition-all text-left">
                  <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-transparent group-hover:bg-[#c89d5c] transition-colors" />
                  <span className="text-xs font-action-label uppercase text-[#78808a] group-hover:text-[#f2f0eb] pl-2 transition-colors">
                    REDEPLOY SECTOR
                  </span>
                  <RotateCw size={14} className="text-[#78808a]" />
                </button>

                <button
                  type="button"
                  onClick={() => setIsHowToPlayOpen(true)}
                  className="group relative flex items-center justify-between p-3 bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 transition-all text-left">
                  <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-transparent group-hover:bg-[#c89d5c] transition-colors" />
                  <span className="text-xs font-action-label uppercase text-[#78808a] group-hover:text-[#f2f0eb] pl-2 transition-colors">
                    BRIEFING DATA
                  </span>
                </button>

                {/* Audio Toggles */}
                <div className="grid grid-cols-2 gap-2 mt-2 font-telemetry">
                  <button
                    type="button"
                    onClick={() => {
                      const next = !isSfxMuted;
                      setIsSfxMuted(next);
                      gameAudio.setMuted(next);
                    }}
                    className="p-2.5 bg-zinc-950 border border-zinc-800 flex items-center justify-between text-[11px] font-bold text-[#78808a] hover:text-[#f2f0eb] transition-colors">
                    <span>SFX:</span>
                    <span className={isSfxMuted ? 'text-[#d93829]' : 'text-[#c89d5c]'}>
                      {isSfxMuted ? 'MUTE' : 'ACTIVE'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsAmbianceMuted((prev) => !prev)}
                    className="p-2.5 bg-zinc-950 border border-zinc-800 flex items-center justify-between text-[11px] font-bold text-[#78808a] hover:text-[#f2f0eb] transition-colors">
                    <span>AMBIANCE:</span>
                    <span className={isAmbianceMuted ? 'text-[#d93829]' : 'text-[#c89d5c]'}>
                      {isAmbianceMuted ? 'MUTE' : 'ACTIVE'}
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setIsGameMenuOpen(false);
                setGameState((prev) => ({...prev, status: 'START'}));
              }}
              className="w-full p-2.5 bg-[#d93829]/20 hover:bg-[#d93829]/30 border border-[#d93829]/40 text-[#f2f0eb] font-action text-xs uppercase tracking-[0.14em] transition-colors text-center">
              ABORT TO MAIN OPERATIONAL MENU
            </button>
          </div>
        </div>
      )}

      {/* Tactical Briefing Modal (Asymmetric Sharp Framed) */}
      {isHowToPlayOpen && (
        <div className="fixed inset-0 z-[70] bg-black/85 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#0a0c0e] border border-zinc-700 p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[#d93829]" />
                <span className="text-xs font-action font-bold text-[#f2f0eb] uppercase tracking-[0.14em]">
                  CLASSIFIED // OPERATIONAL DOSSIER
                </span>
              </div>
              <span className="text-[10px] text-[#78808a] font-telemetry">REF: BREACH-04</span>
            </div>

            <div className="space-y-3 text-xs text-[#78808a] leading-relaxed font-telemetry">
              <p>
                • <strong className="text-[#f2f0eb]">TARGET ACQUISITION:</strong> Click viewport to lock aim optics. Mouse movement controls fine targeting orientation.
              </p>
              <p>
                • <strong className="text-[#f2f0eb]">BALLISTIC TELEMETRY:</strong> Weapon fires high-velocity 7.62mm rounds with reactive recoil and hitscan registration.
              </p>
              <p>
                • <strong className="text-[#f2f0eb]">HOSTILES:</strong> Hostile targets occupy tactical cover. Neutralize all units across warehouse and desert exterior.
              </p>
              <p>
                • <strong className="text-[#f2f0eb]">LOGISTICS:</strong> Weapon capacity is limited to 30-round magazines. Press [R] to reload when spent.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setIsHowToPlayOpen(false)}
              autoFocus
              className="mt-2 w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-[#f2f0eb] font-action text-xs uppercase tracking-[0.14em] transition-colors">
              CONFIRM AND RETURN
            </button>
          </div>
        </div>
      )}

      {/* Game Over Screen: Asymmetric Left-Aligned Tactical Failure */}
      {gameState.status === 'GAME_OVER' && (
        <div className="fixed inset-0 z-50 flex pointer-events-auto bg-black/60">
          <div className="w-full sm:max-w-md h-full bg-[#0a0c0e]/95 p-8 flex flex-col justify-between border-r border-[#d93829]/60">
            <div>
              <span className="px-2 py-0.5 bg-[#d93829] text-[10px] font-black text-[#f2f0eb] uppercase tracking-widest font-telemetry">
                MISSION COMPROMISED
              </span>
              <h2 className="text-3xl font-display uppercase text-[#f2f0eb] mt-3">
                KIA / SIGNAL LOST
              </h2>
              <div className="w-20 h-[2px] bg-[#d93829] mt-2 mb-4" />
              <p className="text-xs text-[#78808a] leading-relaxed mb-6 font-telemetry">
                Reserve ammunition depleted prior to complete sector clearance. Operative must regroup and re-engage.
              </p>

              <div className="border border-zinc-800 bg-zinc-950 p-3 mb-6 text-xs flex justify-between font-telemetry">
                <span className="text-[#78808a]">FINAL SCORE:</span>
                <span className="text-[#c89d5c] font-bold">{gameState.score} PTS</span>
              </div>
            </div>

            <button
              type="button"
              onClick={initGame}
              autoFocus
              className="w-full py-3 bg-[#d93829] hover:bg-[#b52b1e] text-[#f2f0eb] font-action text-xs uppercase tracking-[0.14em] transition-colors flex items-center justify-center gap-2">
              <RotateCw size={16} />
              REDEPLOY TO SECTOR
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

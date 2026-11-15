// tslint:disable
/* eslint-disable */
import {Canvas, useFrame, useThree} from '@react-three/fiber';
import {Bloom, EffectComposer} from '@react-three/postprocessing';
import * as SkeletonUtils from 'three-stdlib';
import {DRACOLoader, GLTFLoader} from 'three-stdlib';
import {
  CapsuleCollider,
  CuboidCollider,
  Physics,
  type RapierRigidBody,
  RigidBody,
} from '@react-three/rapier';
import React, {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {MutableRefObject} from 'react';
import * as THREE from 'three';
import {getConfig} from './constants';
import {InputSnapshot, useInput} from './input';
import {gameAudio, GameState} from './utils/helper';

/** Procedural Canvas Texture generator helper. */
function createProceduralTexture(
  generator: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  size = 512,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  generator(ctx, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

interface TargetData {
  id: number;
  position: [number, number, number];
  hp: number;
  maxHp: number;
  hitAnim: number;
  alive: boolean;
  initialYaw?: number;
}

// Static obstacle collision definitions for soldier clearance verification (radius >= 1.1)
const STATIC_OBSTACLES: Array<{x: number; z: number; radius: number}> = [
  // Indoor Warehouse Columns
  {x: -10, z: -10, radius: 1.8},
  {x: 10, z: -10, radius: 1.8},
  {x: -10, z: 10, radius: 1.8},
  {x: 10, z: 10, radius: 1.8},
  {x: 0, z: 18, radius: 1.8},

  // Indoor Tactical Clusters (Barriers, Crates, Barrels)
  {x: -4.8, z: -6.5, radius: 2.2},
  {x: -6.2, z: -5.8, radius: 1.2},
  {x: -6.8, z: -7.0, radius: 1.2},
  {x: -2.8, z: -7.2, radius: 1.5},
  {x: 4.6, z: -7.8, radius: 2.2},
  {x: 6.4, z: -9.6, radius: 2.0},
  {x: 3.2, z: -9.0, radius: 1.5},
  {x: 7.4, z: -8.6, radius: 1.2},
  {x: -0.4, z: -17.2, radius: 2.6},
  {x: -2.8, z: -16.4, radius: 1.8},
  {x: 2.4, z: -17.8, radius: 1.4},

  // Breach Area Rubble
  {x: -4.0, z: -29.0, radius: 2.5},
  {x: 3.5, z: -29.0, radius: 2.5},

  // Outdoor Bunkers & Containers
  {x: -4.8, z: -36.5, radius: 2.5},
  {x: -2.4, z: -38.5, radius: 2.0},
  {x: -7.2, z: -37.8, radius: 1.8},
  {x: 5.6, z: -39.0, radius: 2.4},
  {x: 7.8, z: -41.2, radius: 2.2},
  {x: 10.2, z: -42.0, radius: 1.8},
  {x: 3.8, z: -40.5, radius: 1.6},
  {x: -15, z: -56, radius: 3.6},
  {x: 16, z: -64, radius: 3.6},
  {x: -3, z: -78, radius: 3.6},
  {x: 1.5, z: -55.0, radius: 1.8},
  {x: 3.1, z: -54.2, radius: 1.2},
];

/**
 * 3. Prevent Soldiers From Overlapping With Crates, Walls, or Pillars:
 * Validates spawn coordinates against warehouse perimeter walls and all static obstacles.
 * If overlapping (clearance < 1.1), shifts outward iteratively to the nearest open floor point.
 */
function getClearSpawnPosition(initialPos: [number, number, number]): [number, number, number] {
  let [cx, cy, cz] = initialPos;
  const minClearance = 1.1;

  // Clamp within warehouse or outdoor perimeter
  if (cz > -28) {
    // Indoor warehouse limits: x in [-26, 26], z in [-27, 26]
    cx = Math.max(-26, Math.min(26, cx));
    cz = Math.max(-27, Math.min(26, cz));
  } else {
    // Outdoor yard limits: x in [-45, 45], z in [-95, -31]
    cx = Math.max(-45, Math.min(45, cx));
    cz = Math.max(-95, Math.min(-31, cz));
  }

  // Iterate up to 8 times to push outward from any overlapping obstacle
  for (let iter = 0; iter < 8; iter++) {
    let hasOverlap = false;

    for (const obs of STATIC_OBSTACLES) {
      const dx = cx - obs.x;
      const dz = cz - obs.z;
      const dist = Math.hypot(dx, dz);
      const reqDist = obs.radius + minClearance;

      if (dist < reqDist) {
        hasOverlap = true;
        const pushDist = reqDist - dist + 0.15;
        const angle = dist > 0.001 ? Math.atan2(dz, dx) : (iter * 0.785);
        cx += Math.cos(angle) * pushDist;
        cz += Math.sin(angle) * pushDist;
      }
    }

    if (!hasOverlap) break;
  }

  return [cx, cy, cz];
}

/**
 * 1. Raycast down at (x, z) to detect exact ground floor height
 * Floor is at y = 0.0 everywhere across both warehouse and desert yard
 */
function getGroundFloorY(x: number, z: number): number {
  return 0.0;
}

export interface SoldierDebugInfo {
  soldierStatus: string;
  shootAnimStatus: string;
  fallAnimStatus: string;
  gunStatus: string;
  worldPos: string;
  scale: string;
  activeAnim: string;
  meshBoneCount: string;
  finalHeight: string;
}

interface SceneProps {
  gameState: GameState;
  setGameState: React.Dispatch<React.SetStateAction<GameState>>;
  inputRef: MutableRefObject<InputSnapshot>;
  exitChat: (payload: Record<string, unknown>) => Promise<void>;
  gameStateRef: MutableRefObject<GameState>;
  ammo: {mag: number; reserve: number};
  setAmmo: React.Dispatch<React.SetStateAction<{mag: number; reserve: number}>>;
  setIsLocked: (locked: boolean) => void;
  showHitMarker: boolean;
  triggerHitMarker: () => void;
  isGameMenuOpen: boolean;
  testAnim?: 'idle' | 'shoot' | 'fall';
  onUpdateDebug?: (info: Partial<SoldierDebugInfo>) => void;
}

// Global reusable scratch vectors
const vForward = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vMove = new THREE.Vector3();
const vRayOrigin = new THREE.Vector3();
const vRayDir = new THREE.Vector3();
const vTargetPosScratch = new THREE.Vector3();
const vMuzzlePosScratch = new THREE.Vector3();
const vAimDirScratch = new THREE.Vector3();
const vLookAtScratch = new THREE.Vector3();
const vImpactScratch = new THREE.Vector3();
const vSparksVelScratch = new THREE.Vector3();
const vHandRScratch = new THREE.Vector3();
const vHandLScratch = new THREE.Vector3();
const vSoldierAimDirScratch = new THREE.Vector3();
const vForwardScratch = new THREE.Vector3();
const vWorldUpLocalScratch = new THREE.Vector3();
const vSideScratch = new THREE.Vector3();
const vUpScratch = new THREE.Vector3();
const mRotMatrixScratch = new THREE.Matrix4();
const qParentInvertScratch = new THREE.Quaternion();
const qAimAdjustScratch = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12, 1.48, 0, 'YXZ'));
const qRHandWorldScratch = new THREE.Quaternion();
const vAimDirWorldScratch = new THREE.Vector3();
const raycaster = new THREE.Raycaster();

/**
 * Procedural Sky Dome with smooth vertical gradient:
 * Pale dusty sky at zenith -> warm ochre horizon haze at bottom
 */
function OutdoorSkyDome() {
  const skyTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#788ea2');
    grad.addColorStop(0.3, '#9fb4c4');
    grad.addColorStop(0.6, '#bca27d');
    grad.addColorStop(0.82, '#ba9d75');
    grad.addColorStop(1.0, '#ba9d75');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 512);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  return (
    <mesh position={[0, 0, -40]} scale={[-1, 1, 1]}>
      <sphereGeometry args={[260, 32, 24]} />
      <meshBasicMaterial
        map={skyTexture}
        side={THREE.BackSide}
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * FPS Weapon Rig attached directly to camera as child object
 */
function FPSWeapon({
  recoilRef,
  muzzleFlashRef,
}: {
  recoilRef: React.MutableRefObject<{time: number; amount: number}>;
  muzzleFlashRef: React.MutableRefObject<boolean>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const flashMeshRef = useRef<THREE.Mesh>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);

  const restPos = useMemo(() => new THREE.Vector3(0.24, -0.22, -0.45), []);
  const restRot = useMemo(() => new THREE.Euler(0.04, -0.06, 0), []);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const dt = Math.min(delta, 0.1);
    const rec = recoilRef.current;

    if (rec.amount > 0.001) {
      rec.amount = THREE.MathUtils.lerp(rec.amount, 0, dt * 16);
    } else {
      rec.amount = 0;
    }

    groupRef.current.position.set(
      restPos.x + (Math.random() - 0.5) * rec.amount * 0.1,
      restPos.y + rec.amount * 0.4,
      restPos.z + rec.amount * 0.8,
    );
    groupRef.current.rotation.set(
      restRot.x + rec.amount * 1.5,
      restRot.y,
      restRot.z + (Math.random() - 0.5) * rec.amount * 0.2,
    );

    const isFlashing = muzzleFlashRef.current;
    if (flashMeshRef.current) {
      flashMeshRef.current.visible = isFlashing;
      if (isFlashing) {
        flashMeshRef.current.rotation.z = Math.random() * Math.PI * 2;
      }
    }
    if (flashLightRef.current) {
      flashLightRef.current.visible = isFlashing;
    }
    if (isFlashing) {
      muzzleFlashRef.current = false;
    }
  });

  return (
    <group ref={groupRef} position={[0.24, -0.22, -0.45]}>
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.045, 0.065, 0.32]} />
        <meshStandardMaterial color="#222730" roughness={0.45} metalness={0.8} />
      </mesh>
      <mesh position={[0, 0.015, -0.23]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.014, 0.014, 0.18, 12]} />
        <meshStandardMaterial color="#12151b" roughness={0.3} metalness={0.9} />
      </mesh>
      <mesh position={[0, 0.015, -0.32]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.018, 0.016, 0.04, 12]} />
        <meshStandardMaterial color="#333b47" roughness={0.5} metalness={0.8} />
      </mesh>
      <mesh position={[0, 0.045, -0.04]}>
        <boxGeometry args={[0.03, 0.025, 0.12]} />
        <meshStandardMaterial color="#141820" roughness={0.5} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.06, -0.03]}>
        <ringGeometry args={[0.008, 0.012, 16]} />
        <meshBasicMaterial color="#00ffcc" side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.08, -0.04]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.035, 0.13, 0.065]} />
        <meshStandardMaterial color="#2b313d" roughness={0.6} metalness={0.6} />
      </mesh>
      <mesh position={[0, -0.07, 0.09]} rotation={[-0.35, 0, 0]}>
        <boxGeometry args={[0.038, 0.11, 0.05]} />
        <meshStandardMaterial color="#181a20" roughness={0.8} metalness={0.2} />
      </mesh>
      <mesh position={[0, -0.01, 0.2]}>
        <boxGeometry args={[0.04, 0.08, 0.14]} />
        <meshStandardMaterial color="#1b1e25" roughness={0.7} metalness={0.5} />
      </mesh>

      <group position={[0, 0.015, -0.36]}>
        <mesh ref={flashMeshRef} visible={false}>
          <coneGeometry args={[0.05, 0.14, 8]} />
          <meshBasicMaterial color="#ffbb44" transparent opacity={0.9} />
        </mesh>
        <pointLight
          ref={flashLightRef}
          color="#ffaa33"
          intensity={16.0}
          distance={8}
          decay={1.5}
          visible={false}
        />
      </group>
    </group>
  );
}

/**
 * Dedicated white-RGB radial gradient canvas texture for clearly visible dust puffs
 */
let sharedWhiteDustTexture: THREE.CanvasTexture | null = null;
function getSharedWhiteDustTexture(): THREE.CanvasTexture {
  if (!sharedWhiteDustTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.25, 'rgba(255, 255, 255, 0.7)');
    grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.3)');
    grad.addColorStop(0.85, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    sharedWhiteDustTexture = new THREE.CanvasTexture(canvas);
    sharedWhiteDustTexture.wrapS = THREE.ClampToEdgeWrapping;
    sharedWhiteDustTexture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return sharedWhiteDustTexture;
}

/**
 * Shared radial-gradient soft dust/scorch texture for seamless ground blending
 */
let sharedRubbleDustTexture: THREE.CanvasTexture | null = null;
function getSharedRubbleDustTexture(): THREE.CanvasTexture {
  if (!sharedRubbleDustTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(38, 33, 26, 0.55)');
    grad.addColorStop(0.45, 'rgba(38, 33, 26, 0.35)');
    grad.addColorStop(0.78, 'rgba(38, 33, 26, 0.12)');
    grad.addColorStop(1.0, 'rgba(38, 33, 26, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    sharedRubbleDustTexture = new THREE.CanvasTexture(canvas);
    sharedRubbleDustTexture.wrapS = THREE.ClampToEdgeWrapping;
    sharedRubbleDustTexture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return sharedRubbleDustTexture;
}

/**
 * Concrete Rubble Mound with organic radial stone scatter and seamless soft dust shadow
 */
function RubbleCluster({
  position,
  count = 6,
  radius = 1.4,
}: {
  position: [number, number, number];
  count?: number;
  radius?: number;
}) {
  const dustTex = useMemo(() => getSharedRubbleDustTexture(), []);

  const stones = useMemo(() => {
    return Array.from({length: count}, (_, i) => {
      // Cluster larger angular concrete chunks near center (r = pow(rand, 0.7) * radius * 0.85)
      // smaller scattered pebbles near the outer edge
      const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 1.2;
      const distRatio = Math.pow(Math.random(), 0.7);
      const r = distRatio * radius * 0.85;

      const isCenter = distRatio < 0.45;
      const sx = isCenter ? 0.25 + Math.random() * 0.45 : 0.12 + Math.random() * 0.22;
      const sy = 0.05 + Math.random() * (isCenter ? 0.27 : 0.14); // varied heights 0.05 to 0.32
      const sz = isCenter ? 0.25 + Math.random() * 0.45 : 0.12 + Math.random() * 0.22;

      return {
        pos: [
          Math.cos(angle) * r + (Math.random() - 0.5) * 0.15,
          sy / 2 + 0.01,
          Math.sin(angle) * r + (Math.random() - 0.5) * 0.15,
        ] as [number, number, number],
        rot: [
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
        ] as [number, number, number],
        scale: [sx, sy, sz] as [number, number, number],
      };
    });
  }, [count, radius]);

  return (
    <group position={position}>
      {/* 1. Seamless radial-gradient soft dust/scorch decal */}
      <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[radius * 2.4, radius * 2.4]} />
        <meshBasicMaterial
          map={dustTex}
          transparent
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
      {/* 2. Angular concrete debris chunks */}
      {stones.map((st, i) => (
        <mesh key={`stone-${i}`} position={st.pos} rotation={st.rot} castShadow receiveShadow>
          <boxGeometry args={st.scale} />
          <meshStandardMaterial color={i % 2 === 0 ? '#383d45' : '#453f36'} roughness={0.92} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Weathered Military Crate with dark wood planks & oxidized metal brackets
 */
function WeatheredMilitaryCrate({
  position,
  rotation = [0, 0, 0],
  size = [1.2, 1.2, 1.2],
  woodTexture,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  size?: [number, number, number];
  woodTexture: THREE.CanvasTexture;
}) {
  const [sx, sy, sz] = size;
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[sx, sy, sz]} />
        <meshStandardMaterial
          map={woodTexture}
          roughness={0.88}
          metalness={0.06}
        />
      </mesh>
      <mesh castShadow>
        <boxGeometry args={[sx * 1.015, sy * 0.1, sz * 1.015]} />
        <meshStandardMaterial color="#221e1a" roughness={0.85} metalness={0.65} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Slanted leaning wooden plank for dynamic debris
 */
function SlantedPlank({
  position,
  rotation,
  length = 2.4,
  woodTexture,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  length?: number;
  woodTexture: THREE.CanvasTexture;
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.35, 0.08, length]} />
        <meshStandardMaterial map={woodTexture} roughness={0.9} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Solid Dark Rusted Metal Barrel (upright or tipped over)
 */
function RustedIronBarrel({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh castShadow receiveShadow position={[0, 0.65, 0]}>
        <cylinderGeometry args={[0.42, 0.42, 1.3, 20]} />
        <meshStandardMaterial
          color="#2b2622"
          roughness={0.78}
          metalness={0.65}
        />
      </mesh>
      <mesh position={[0, 1.28, 0]}>
        <cylinderGeometry args={[0.435, 0.435, 0.05, 20]} />
        <meshStandardMaterial color="#1f1b18" roughness={0.85} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.03, 0]}>
        <cylinderGeometry args={[0.435, 0.435, 0.05, 20]} />
        <meshStandardMaterial color="#1f1b18" roughness={0.85} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.85, 0]}>
        <cylinderGeometry args={[0.438, 0.438, 0.04, 20]} />
        <meshStandardMaterial color="#221e1a" roughness={0.8} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.438, 0.438, 0.04, 20]} />
        <meshStandardMaterial color="#221e1a" roughness={0.8} metalness={0.7} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Rough Concrete Jersey Barrier
 */
function RoughConcreteBarrier({
  position,
  rotation = [0, 0, 0],
  length = 3.6,
  concreteTexture,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  length?: number;
  concreteTexture: THREE.CanvasTexture;
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, 0.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[length, 0.8, 0.9]} />
        <meshStandardMaterial
          map={concreteTexture}
          roughness={0.92}
          metalness={0.08}
        />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow receiveShadow>
        <boxGeometry args={[length * 0.98, 0.5, 0.5]} />
        <meshStandardMaterial
          map={concreteTexture}
          roughness={0.92}
          metalness={0.08}
        />
      </mesh>
      <mesh position={[length * 0.35, 1.25, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.15, 8]} />
        <meshStandardMaterial color="#38322a" roughness={0.8} metalness={0.7} />
      </mesh>
      <mesh position={[-length * 0.35, 1.25, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.15, 8]} />
        <meshStandardMaterial color="#38322a" roughness={0.8} metalness={0.7} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Military Sandbag Wall Barrier
 */
function SandbagWall({
  position,
  rotation = [0, 0, 0],
  length = 3.0,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  length?: number;
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[length, 0.6, 0.9]} />
        <meshStandardMaterial color="#947b57" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.8, 0]} castShadow receiveShadow>
        <boxGeometry args={[length * 0.9, 0.5, 0.65]} />
        <meshStandardMaterial color="#886f4b" roughness={0.95} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Military Hesco Bastion
 */
function HescoBarrier({
  position,
  rotation = [0, 0, 0],
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, 0.8, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.6, 1.6, 1.6]} />
        <meshStandardMaterial color="#8a7350" roughness={0.96} />
      </mesh>
      <mesh position={[0, 0.8, 0]}>
        <boxGeometry args={[1.64, 1.64, 1.64]} />
        <meshStandardMaterial
          color="#3e4756"
          roughness={0.4}
          metalness={0.8}
          wireframe
        />
      </mesh>
    </RigidBody>
  );
}

/**
 * Weathered & Rusted Shipping Container
 */
function ShippingContainer({
  position,
  rotation = [0, 0, 0],
  color = '#7c2d12',
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  color?: string;
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, 1.4, 0]} castShadow receiveShadow>
        <boxGeometry args={[2.8, 2.8, 6.8]} />
        <meshStandardMaterial color={color} roughness={0.85} metalness={0.45} />
      </mesh>
      {[-2.8, -1.8, -0.8, 0.2, 1.2, 2.2].map((zPos, i) => (
        <mesh key={`rib-${i}`} position={[0, 1.4, zPos]}>
          <boxGeometry args={[2.85, 2.7, 0.12]} />
          <meshStandardMaterial color="#1f1813" roughness={0.9} metalness={0.6} />
        </mesh>
      ))}
    </RigidBody>
  );
}

/**
 * Military Guard Watchtower for horizon silhouette depth
 */
function MilitaryWatchtower({position}: {position: [number, number, number]}) {
  return (
    <group position={position}>
      {[
        [-1.6, -1.6],
        [1.6, -1.6],
        [-1.6, 1.6],
        [1.6, 1.6],
      ].map(([lx, lz], i) => (
        <mesh key={`leg-${i}`} position={[lx, 5, lz]}>
          <boxGeometry args={[0.22, 10, 0.22]} />
          <meshStandardMaterial color="#2d3542" roughness={0.7} metalness={0.75} />
        </mesh>
      ))}
      {[2.5, 5.5, 8.5].map((y, i) => (
        <group key={`brace-${i}`} position={[0, y, 0]}>
          <mesh position={[0, 0, 1.6]}>
            <boxGeometry args={[3.4, 0.12, 0.12]} />
            <meshStandardMaterial color="#1e242e" roughness={0.7} metalness={0.8} />
          </mesh>
          <mesh position={[0, 0, -1.6]}>
            <boxGeometry args={[3.4, 0.12, 0.12]} />
            <meshStandardMaterial color="#1e242e" roughness={0.7} metalness={0.8} />
          </mesh>
          <mesh position={[1.6, 0, 0]}>
            <boxGeometry args={[0.12, 0.12, 3.4]} />
            <meshStandardMaterial color="#1e242e" roughness={0.7} metalness={0.8} />
          </mesh>
          <mesh position={[-1.6, 0, 0]}>
            <boxGeometry args={[0.12, 0.12, 3.4]} />
            <meshStandardMaterial color="#1e242e" roughness={0.7} metalness={0.8} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 10.2, 0]}>
        <boxGeometry args={[4.2, 0.35, 4.2]} />
        <meshStandardMaterial color="#1e232b" roughness={0.9} />
      </mesh>
      <mesh position={[0, 11.2, 0]}>
        <boxGeometry args={[3.9, 1.8, 3.9]} />
        <meshStandardMaterial color="#2a323d" roughness={0.8} metalness={0.5} wireframe />
      </mesh>
      <mesh position={[0, 12.4, 0]} rotation={[0.08, 0, 0]}>
        <boxGeometry args={[4.8, 0.12, 4.8]} />
        <meshStandardMaterial color="#473e35" roughness={0.8} metalness={0.6} />
      </mesh>
    </group>
  );
}

const TRUCK_GLB_URL = 'https://cdn.jsdelivr.net/gh/kylierah/3d-assets@main/truck.glb';
let truckBundlePromise: Promise<THREE.Group | null> | null = null;

function loadTruckModel(): Promise<THREE.Group | null> {
  if (truckBundlePromise) return truckBundlePromise;
  truckBundlePromise = new Promise((resolve) => {
    const loader = new GLTFLoader();

    // Configure DRACOLoader with standard Three.js Draco decoder CDN
    try {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
      dracoLoader.setDecoderConfig({type: 'js'});
      loader.setDRACOLoader(dracoLoader);
    } catch (dracoErr) {
      console.warn('Draco loader setup notice:', dracoErr);
    }

    loader.load(
      TRUCK_GLB_URL,
      (gltf: any) => {
        resolve(gltf.scene || null);
      },
      undefined,
      (err: any) => {
        console.warn('Truck model load notice:', err?.message);
        resolve(null);
      }
    );
  });
  return truckBundlePromise;
}

/**
 * Single military truck placed outside the left chain-link fence in the outdoor yard
 */
function OutdoorYardTruck() {
  const [truckScene, setTruckScene] = useState<THREE.Group | null>(null);
  const [colliderDims, setColliderDims] = useState<THREE.Vector3 | null>(null);

  useEffect(() => {
    let active = true;
    loadTruckModel().then((scene) => {
      if (!active || !scene) return;
      const clone = scene.clone(true);

      // Reset transformations to normalize
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.scale.set(1, 1, 1);
      clone.updateMatrixWorld(true);

      // 1. Compute Bounding Box Strictly From Actual isMesh Nodes
      const meshBox = new THREE.Box3();
      let hasMesh = false;
      clone.traverse((n: any) => {
        if (n.isMesh) {
          meshBox.expandByObject(n);
          hasMesh = true;
        }
      });

      if (!hasMesh) {
        meshBox.setFromObject(clone);
      }

      const rawSize = new THREE.Vector3();
      meshBox.getSize(rawSize);
      const longestDim = Math.max(rawSize.x, rawSize.y, rawSize.z, 0.01);

      // Uniformly scale truck so it fits naturally on the road (target length ~9.8 units)
      const targetLength = 9.8;
      const s = targetLength / longestDim;
      clone.scale.set(s, s, s);
      clone.updateMatrixWorld(true);

      // Recompute scaledMeshBox strictly across isMesh nodes
      const scaledMeshBox = new THREE.Box3();
      clone.traverse((n: any) => {
        if (n.isMesh) {
          scaledMeshBox.expandByObject(n);
        }
      });

      const scaledSize = new THREE.Vector3();
      scaledMeshBox.getSize(scaledSize);
      const scaledCenter = new THREE.Vector3();
      scaledMeshBox.getCenter(scaledCenter);

      // Center X and Z at 0, and place bottom of wheels (scaledMeshBox.min.y) right on top of road (y = 0)
      clone.position.set(
        -scaledCenter.x,
        -scaledMeshBox.min.y,
        -scaledCenter.z
      );
      clone.updateMatrixWorld(true);

      // 2. Ensure Solid Material Visibility
      clone.traverse((n: any) => {
        if (n.isMesh) {
          n.visible = true;
          n.frustumCulled = false;
          n.castShadow = true;
          n.receiveShadow = true;

          const inspectAndSolidify = (mat: any) => {
            if (!mat) return mat;
            mat.transparent = false;
            mat.opacity = 1.0;
            mat.depthWrite = true;
            mat.side = THREE.DoubleSide;
            // Clamp metalness & roughness so it renders under direct/ambient lights without turning pitch black
            mat.metalness = Math.min(mat.metalness ?? 0.3, 0.35);
            mat.roughness = Math.max(mat.roughness ?? 0.6, 0.45);
            mat.needsUpdate = true;
            return mat;
          };

          if (Array.isArray(n.material)) {
            n.material = n.material.map(inspectAndSolidify);
          } else {
            n.material = inspectAndSolidify(n.material);
          }
        }
      });

      setColliderDims(scaledSize);
      setTruckScene(clone);
    });

    return () => {
      active = false;
    };
  }, []);

  if (!truckScene || !colliderDims) {
    return null;
  }

  return (
    <RigidBody
      type="fixed"
      position={[-32.5, 0, -37.5]}
      rotation={[0, 0.45, 0]}
      colliders={false}
    >
      <primitive object={truckScene} />
      <CuboidCollider
        args={[colliderDims.x * 0.48, colliderDims.y * 0.5, colliderDims.z * 0.48]}
        position={[0, colliderDims.y * 0.5, 0]}
      />
    </RigidBody>
  );
}

/**
 * Broken Concrete Wall Ruin Chunk with jagged rebar
 */
function BrokenConcreteRuin({
  position,
  rotation = [0, 0, 0],
  scale = [4, 3, 1],
  concreteTexture,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
  concreteTexture: THREE.CanvasTexture;
}) {
  const [sx, sy, sz] = scale;
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, sy / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[sx, sy, sz]} />
        <meshStandardMaterial map={concreteTexture} roughness={0.94} />
      </mesh>
      <mesh position={[sx * 0.15, sy + 0.3, 0]} rotation={[0, 0, 0.2]} castShadow receiveShadow>
        <boxGeometry args={[sx * 0.45, 0.7, sz * 0.95]} />
        <meshStandardMaterial map={concreteTexture} roughness={0.94} />
      </mesh>
      <mesh position={[-sx * 0.3, sy + 0.4, 0]} rotation={[0.2, 0.1, 0.4]}>
        <cylinderGeometry args={[0.015, 0.015, 0.9, 6]} />
        <meshStandardMaterial color="#2b231c" roughness={0.7} metalness={0.8} />
      </mesh>
      <mesh position={[sx * 0.3, sy + 0.35, 0]} rotation={[-0.1, 0.2, -0.4]}>
        <cylinderGeometry args={[0.015, 0.015, 0.7, 6]} />
        <meshStandardMaterial color="#2b231c" roughness={0.7} metalness={0.8} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Military Chain-Link Security Fence
 */
function ChainLinkFence({
  position,
  rotation = [0, 0, 0],
  width = 6.0,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  width?: number;
}) {
  return (
    <RigidBody type="fixed" position={position} rotation={rotation}>
      <mesh position={[0, 1.5, 0]}>
        <planeGeometry args={[width, 3.0, 12, 8]} />
        <meshStandardMaterial
          color="#64748b"
          roughness={0.3}
          metalness={0.85}
          wireframe
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[-width / 2, 1.6, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 3.2, 8]} />
        <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.8} />
      </mesh>
      <mesh position={[width / 2, 1.6, 0]}>
        <cylinderGeometry args={[0.06, 0.06, 3.2, 8]} />
        <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.8} />
      </mesh>
      <mesh position={[0, 3.0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.04, 0.04, width, 8]} />
        <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.8} />
      </mesh>
      <mesh position={[0, 0.1, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.04, 0.04, width, 8]} />
        <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.8} />
      </mesh>
    </RigidBody>
  );
}

/**
 * Heavy Industrial Ceiling Truss Beam
 */
function HeavyCeilingTruss({z}: {z: number}) {
  return (
    <group position={[0, 8.8, z]}>
      <mesh position={[0, 0.35, 0]} castShadow>
        <boxGeometry args={[58, 0.24, 0.28]} />
        <meshStandardMaterial color="#262d38" roughness={0.75} metalness={0.65} />
      </mesh>
      <mesh position={[0, -0.35, 0]} castShadow>
        <boxGeometry args={[58, 0.24, 0.28]} />
        <meshStandardMaterial color="#262d38" roughness={0.75} metalness={0.65} />
      </mesh>
      {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((x, i) => (
        <group key={`strut-${i}`} position={[x, 0, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.12, 0.7, 0.12]} />
            <meshStandardMaterial color="#2c3440" roughness={0.75} metalness={0.65} />
          </mesh>
          <mesh rotation={[0, 0, 0.72]} castShadow>
            <boxGeometry args={[0.09, 0.96, 0.09]} />
            <meshStandardMaterial color="#222832" roughness={0.8} metalness={0.65} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Seamless Indoor-to-Outdoor Environment with Organic CQB Ruins & Desert Range
 */
function SeamlessBreachEnvironment() {
  const indoorFloorTexture = useMemo(() => {
    return createProceduralTexture((ctx, w, h) => {
      ctx.fillStyle = '#22262f';
      ctx.fillRect(0, 0, w, h);

      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 28;
        data[i] = Math.min(255, Math.max(0, data[i] + noise));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise + 1));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise + 2));
      }
      ctx.putImageData(imgData, 0, 0);

      ctx.strokeStyle = '#12151c';
      ctx.lineWidth = 3;
      const step = w / 4;
      for (let x = 0; x <= w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }, 512);
  }, []);
  indoorFloorTexture.repeat.set(8, 8);

  const outdoorGroundTexture = useMemo(() => {
    return createProceduralTexture((ctx, w, h) => {
      ctx.fillStyle = '#9c8156';
      ctx.fillRect(0, 0, w, h);

      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const grain = (Math.random() - 0.5) * 20;
        data[i] = Math.min(255, Math.max(0, data[i] + grain + 3));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + grain + 1));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + grain - 2));
      }
      ctx.putImageData(imgData, 0, 0);
    }, 512);
  }, []);
  outdoorGroundTexture.repeat.set(24, 24);

  const concreteWallTexture = useMemo(() => {
    return createProceduralTexture((ctx, w, h) => {
      ctx.fillStyle = '#262c37';
      ctx.fillRect(0, 0, w, h);

      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 26;
        data[i] = Math.min(255, Math.max(0, data[i] + noise));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise + 1));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise + 3));
      }
      ctx.putImageData(imgData, 0, 0);

      ctx.fillStyle = 'rgba(18, 22, 30, 0.3)';
      for (let x = 0; x < w; x += 35 + Math.random() * 45) {
        ctx.fillRect(x, 0, 10 + Math.random() * 15, h * (0.4 + Math.random() * 0.6));
      }
    }, 512);
  }, []);
  concreteWallTexture.repeat.set(6, 2);

  const militaryCrateTexture = useMemo(() => {
    return createProceduralTexture((ctx, w, h) => {
      ctx.fillStyle = '#3c352a';
      ctx.fillRect(0, 0, w, h);

      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * 35;
        data[i] = Math.min(255, Math.max(0, data[i] + noise));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise * 0.9));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise * 0.6));
      }
      ctx.putImageData(imgData, 0, 0);

      ctx.strokeStyle = '#1b1712';
      ctx.lineWidth = 5;
      const numPlanks = 5;
      const plankH = h / numPlanks;
      for (let i = 1; i < numPlanks; i++) {
        ctx.beginPath();
        ctx.moveTo(0, i * plankH);
        ctx.lineTo(w, i * plankH);
        ctx.stroke();
      }

      ctx.strokeStyle = '#2b251d';
      ctx.lineWidth = 22;
      ctx.strokeRect(11, 11, w - 22, h - 22);

      ctx.fillStyle = 'rgba(18, 14, 10, 0.75)';
      ctx.font = 'bold 34px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('ORDNANCE', w / 2, h / 2 - 12);
      ctx.font = 'bold 20px monospace';
      ctx.fillText('CAL. 7.62mm CQB', w / 2, h / 2 + 22);
    }, 512);
  }, []);

  const sandTransitionTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    // Soft vertical gradient from indoor concrete to outdoor desert sand
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0.0, 'rgba(156, 129, 86, 0)');
    grad.addColorStop(0.2, 'rgba(156, 129, 86, 0.28)');
    grad.addColorStop(0.5, 'rgba(156, 129, 86, 0.75)');
    grad.addColorStop(0.8, 'rgba(156, 129, 86, 0.28)');
    grad.addColorStop(1.0, 'rgba(156, 129, 86, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(16, 1);
    return texture;
  }, []);

  return (
    <group>
      {/* 1. INDOOR WAREHOUSE FLOOR */}
      <RigidBody type="fixed" friction={1}>
        <mesh position={[0, -0.5, 0]} receiveShadow>
          <boxGeometry args={[60, 1, 60]} />
          <meshStandardMaterial
            map={indoorFloorTexture}
            roughness={0.92}
            metalness={0.1}
          />
        </mesh>
      </RigidBody>

      {/* Wind-blown desert sand transition strip along the breach threshold (z = -29.5, y = 0.004) */}
      <mesh position={[0, 0.004, -29.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[60, 4.8]} />
        <meshBasicMaterial
          map={sandTransitionTexture}
          transparent
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
        />
      </mesh>

      {/* 2. OUTDOOR OCHRE DESERT RANGE YARD FLOOR */}
      <RigidBody type="fixed" friction={1}>
        <mesh position={[0, -0.5, -70]} receiveShadow>
          <boxGeometry args={[120, 1, 80]} />
          <meshStandardMaterial
            map={outdoorGroundTexture}
            roughness={0.92}
            metalness={0.02}
          />
        </mesh>
      </RigidBody>

      {/* Background Horizon Military Watchtowers */}
      <MilitaryWatchtower position={[-28, 0, -88]} />
      <MilitaryWatchtower position={[28, 0, -96]} />

      {/* Distant Desert Broken Concrete Perimeter Ruins */}
      <BrokenConcreteRuin
        position={[-36, 0, -78]}
        rotation={[0, 0.45, 0]}
        scale={[12, 4.5, 1.8]}
        concreteTexture={concreteWallTexture}
      />
      <BrokenConcreteRuin
        position={[36, 0, -82]}
        rotation={[0, -0.35, 0]}
        scale={[14, 4.8, 1.8]}
        concreteTexture={concreteWallTexture}
      />
      <BrokenConcreteRuin
        position={[0, 0, -108]}
        scale={[40, 5.5, 2.4]}
        concreteTexture={concreteWallTexture}
      />

      {/* 3. INDOOR WAREHOUSE ROOF */}
      <mesh position={[0, 9.5, 0]} receiveShadow>
        <boxGeometry args={[60, 1, 60]} />
        <meshStandardMaterial color="#1b2029" roughness={0.9} />
      </mesh>

      {/* Heavy Steel Ceiling Trusses */}
      {[-20, -10, 0, 10, 20].map((zPos) => (
        <HeavyCeilingTruss key={`truss-${zPos}`} z={zPos} />
      ))}

      {/* 4. JAGGED DESTROYED CONCRETE WALL BREACH (Z = -29) */}
      <RigidBody type="fixed">
        <mesh position={[-20, 4.5, -29]} receiveShadow>
          <boxGeometry args={[20, 10, 2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[20, 4.5, -29]} receiveShadow>
          <boxGeometry args={[20, 10, 2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[-8.8, 3.2, -29]} rotation={[0, 0, -0.22]} castShadow receiveShadow>
          <boxGeometry args={[3.2, 6.4, 2.2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[8.8, 2.8, -29]} rotation={[0, 0, 0.18]} castShadow receiveShadow>
          <boxGeometry args={[3.4, 5.6, 2.2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[0, 8.4, -29]} rotation={[0, 0, 0.05]} castShadow receiveShadow>
          <boxGeometry args={[16, 2.4, 2.2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <mesh position={[-3.2, 7.0, -29.1]} rotation={[0.2, 0.1, 0.4]}>
        <cylinderGeometry args={[0.02, 0.02, 1.4, 6]} />
        <meshStandardMaterial color="#2d2218" roughness={0.7} metalness={0.8} />
      </mesh>
      <mesh position={[2.8, 6.9, -28.9]} rotation={[-0.3, 0.1, -0.35]}>
        <cylinderGeometry args={[0.02, 0.02, 1.6, 6]} />
        <meshStandardMaterial color="#2d2218" roughness={0.7} metalness={0.8} />
      </mesh>

      {/* 2. Break symmetrical rubble placement at breach threshold */}
      {/* Left breach side: larger elongated collapse pile + smaller secondary scatter */}
      <RubbleCluster position={[-5.4, 0, -28.6]} count={14} radius={2.4} />
      <RubbleCluster position={[-2.9, 0, -29.8]} count={6} radius={1.1} />

      {/* Right breach side: smaller offset rubble scatter + loose stones further inside */}
      <RubbleCluster position={[4.8, 0, -28.2]} count={8} radius={1.5} />
      <RubbleCluster position={[2.6, 0, -26.8]} count={5} radius={1.0} />

      {/* Warehouse Perimeter Walls */}
      <RigidBody type="fixed">
        <mesh position={[0, 4.5, 29]} receiveShadow>
          <boxGeometry args={[60, 10, 2]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[-29, 4.5, 0]} receiveShadow>
          <boxGeometry args={[2, 10, 60]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>
      <RigidBody type="fixed">
        <mesh position={[29, 4.5, 0]} receiveShadow>
          <boxGeometry args={[2, 10, 60]} />
          <meshStandardMaterial map={concreteWallTexture} roughness={0.92} />
        </mesh>
      </RigidBody>

      {/* Heavy Warehouse Concrete Columns */}
      {[
        [-10, -10],
        [10, -10],
        [-10, 10],
        [10, 10],
        [0, 18],
      ].map(([px, pz], i) => (
        <RigidBody key={`pillar-${i}`} type="fixed">
          <mesh position={[px, 4.5, pz]} castShadow receiveShadow>
            <boxGeometry args={[2.4, 9, 2.4]} />
            <meshStandardMaterial
              map={concreteWallTexture}
              roughness={0.94}
              metalness={0.08}
            />
          </mesh>
        </RigidBody>
      ))}

      {/* 5. INDOOR TACTICAL CQB CLUSTERS */}
      <group>
        <RoughConcreteBarrier
          position={[-4.8, 0, -6.5]}
          rotation={[0, 0.42, 0]}
          length={3.4}
          concreteTexture={concreteWallTexture}
        />
        <RustedIronBarrel
          position={[-6.2, 0.42, -5.8]}
          rotation={[Math.PI / 2, 0, 0.65]}
        />
        <RustedIronBarrel
          position={[-6.8, 0, -7.0]}
          rotation={[0, -0.3, 0]}
        />
        <WeatheredMilitaryCrate
          position={[-2.8, 0.65, -7.2]}
          rotation={[0, -0.28, 0]}
          size={[1.3, 1.3, 1.3]}
          woodTexture={militaryCrateTexture}
        />
        <WeatheredMilitaryCrate
          position={[-3.1, 1.88, -7.0]}
          rotation={[0, 0.22, 0]}
          size={[1.05, 1.05, 1.05]}
          woodTexture={militaryCrateTexture}
        />
        <SlantedPlank
          position={[-1.9, 0.7, -6.6]}
          rotation={[0.3, 0.4, 0.45]}
          length={2.2}
          woodTexture={militaryCrateTexture}
        />
        <RubbleCluster position={[-4.5, 0, -6.0]} count={7} radius={1.8} />
      </group>

      <group>
        <SandbagWall
          position={[4.6, 0, -7.8]}
          rotation={[0, -0.6, 0]}
          length={3.6}
        />
        <SandbagWall
          position={[6.4, 0, -9.6]}
          rotation={[0, 0.95, 0]}
          length={3.2}
        />
        <WeatheredMilitaryCrate
          position={[3.2, 0.65, -9.0]}
          rotation={[0, 0.38, 0]}
          size={[1.4, 1.3, 1.3]}
          woodTexture={militaryCrateTexture}
        />
        <RustedIronBarrel
          position={[7.4, 0, -8.6]}
          rotation={[0, 0.15, 0]}
        />
        <RustedIronBarrel
          position={[5.6, 0.42, -6.6]}
          rotation={[Math.PI / 2, 0, -0.8]}
        />
        <RubbleCluster position={[5.0, 0, -8.4]} count={8} radius={1.9} />
      </group>

      <group>
        <RoughConcreteBarrier
          position={[-0.4, 0, -17.2]}
          rotation={[0, -0.18, 0]}
          length={4.5}
          concreteTexture={concreteWallTexture}
        />
        <WeatheredMilitaryCrate
          position={[-2.8, 0.65, -16.4]}
          rotation={[0, 0.45, 0]}
          size={[1.35, 1.3, 1.35]}
          woodTexture={militaryCrateTexture}
        />
        <WeatheredMilitaryCrate
          position={[-2.6, 1.88, -16.3]}
          rotation={[0, -0.15, 0]}
          size={[1.1, 1.05, 1.1]}
          woodTexture={militaryCrateTexture}
        />
        <RustedIronBarrel
          position={[2.4, 0, -17.8]}
          rotation={[0, -0.4, 0]}
        />
        <SlantedPlank
          position={[1.5, 0.65, -16.5]}
          rotation={[-0.35, 0.2, -0.4]}
          length={2.0}
          woodTexture={militaryCrateTexture}
        />
        <RubbleCluster position={[0, 0, -17.0]} count={9} radius={2.2} />
      </group>

      {/* 6. OUTDOOR DENSE L-SHAPED BUNKERS & ORGANIC RANGE CLUSTERS */}
      <group>
        <SandbagWall
          position={[-4.8, 0, -36.5]}
          rotation={[0, 0.28, 0]}
          length={4.5}
        />
        <SandbagWall
          position={[-2.4, 0, -38.5]}
          rotation={[0, -1.25, 0]}
          length={3.4}
        />
        <HescoBarrier
          position={[-7.2, 0, -37.8]}
          rotation={[0, 0.35, 0]}
        />
        <RustedIronBarrel
          position={[-3.8, 0, -38.2]}
          rotation={[0, 0.5, 0]}
        />
        <RustedIronBarrel
          position={[-5.8, 0.42, -35.2]}
          rotation={[Math.PI / 2, 0, 0.3]}
        />
        <RubbleCluster position={[-4.5, 0, -37.0]} count={10} radius={2.4} />
      </group>

      <group>
        <SandbagWall
          position={[5.6, 0, -39.0]}
          rotation={[0, -0.42, 0]}
          length={4.2}
        />
        <SandbagWall
          position={[7.8, 0, -41.2]}
          rotation={[0, 1.15, 0]}
          length={3.5}
        />
        <HescoBarrier
          position={[10.2, 0, -42.0]}
          rotation={[0, -0.25, 0]}
        />
        <WeatheredMilitaryCrate
          position={[3.8, 0.65, -40.5]}
          rotation={[0, 0.32, 0]}
          size={[1.3, 1.3, 1.3]}
          woodTexture={militaryCrateTexture}
        />
        <RubbleCluster position={[6.0, 0, -40.0]} count={8} radius={2.0} />
      </group>

      <ShippingContainer
        position={[-15, 0, -56]}
        rotation={[0, 0.52, 0]}
        color="#3f4a3c"
      />
      <ShippingContainer
        position={[16, 0, -64]}
        rotation={[0, -0.38, 0]}
        color="#854d0e"
      />
      <ShippingContainer
        position={[-3, 0, -78]}
        rotation={[0, 1.35, 0]}
        color="#1e3a5f"
      />

      <group>
        <HescoBarrier position={[3.2, 0, -76.5]} rotation={[0, 0.2, 0]} />
        <WeatheredMilitaryCrate
          position={[1.5, 0.75, -55.0]}
          rotation={[0, -0.35, 0]}
          size={[1.5, 1.5, 1.5]}
          woodTexture={militaryCrateTexture}
        />
        <WeatheredMilitaryCrate
          position={[1.8, 2.1, -54.8]}
          rotation={[0, 0.28, 0]}
          size={[1.15, 1.15, 1.15]}
          woodTexture={militaryCrateTexture}
        />
        <RustedIronBarrel position={[3.1, 0, -54.2]} rotation={[0, 0.4, 0]} />
        <RustedIronBarrel
          position={[0.2, 0.42, -55.6]}
          rotation={[Math.PI / 2, 0, 1.1]}
        />
        <RubbleCluster position={[1.8, 0, -55.0]} count={7} radius={2.0} />
      </group>

      <ChainLinkFence position={[-25, 0, -48]} rotation={[0, 1.48, 0]} width={20} />
      <ChainLinkFence position={[25, 0, -48]} rotation={[0, 1.62, 0]} width={20} />
      <ChainLinkFence position={[-14, 0, -94]} rotation={[0, -0.08, 0]} width={22} />
      <ChainLinkFence position={[14, 0, -94]} rotation={[0, 0.08, 0]} width={22} />

      {/* Single Military Truck outside left chain-link fence */}
      <GLTFErrorBoundary fallback={null}>
        <OutdoorYardTruck />
      </GLTFErrorBoundary>
    </group>
  );
}

const MAIN_SOLDIER_URL = 'https://files.catbox.moe/hjuano.glb';
const SHOOT_ANIM_URL = 'https://files.catbox.moe/r4mabm.glb';
const FALL_ANIM_URL = 'https://files.catbox.moe/vh455p.glb';
const GUN_GLB_URL = 'https://files.catbox.moe/upvi4m.glb';

/**
 * Pure Three.js SkinnedMesh clone implementation (identical to SkeletonUtils.clone)
 * Ensures cloned SkinnedMeshes re-bind to the cloned skeleton hierarchy
 * without failing or throwing if three-stdlib exports differ.
 */
function cloneSkinnedScene(source: THREE.Object3D): THREE.Object3D {
  const cloneLookup = new Map<THREE.Object3D, THREE.Object3D>();
  const cloned = source.clone(true);

  const sourceObjects: THREE.Object3D[] = [];
  const clonedObjects: THREE.Object3D[] = [];

  source.traverse((obj) => sourceObjects.push(obj));
  cloned.traverse((obj) => clonedObjects.push(obj));

  for (let i = 0; i < sourceObjects.length; i++) {
    cloneLookup.set(sourceObjects[i], clonedObjects[i]);
  }

  cloned.traverse((node: any) => {
    if (node.isSkinnedMesh && node.skeleton) {
      const originalSkeleton = node.skeleton;
      const clonedBones: THREE.Bone[] = [];

      for (let i = 0; i < originalSkeleton.bones.length; i++) {
        const originalBone = originalSkeleton.bones[i];
        const clonedBone = (cloneLookup.get(originalBone) as THREE.Bone) || originalBone;
        clonedBones.push(clonedBone);
      }

      node.skeleton = new THREE.Skeleton(clonedBones, originalSkeleton.boneInverses);
      node.bind(node.skeleton, node.bindMatrix);
      node.skeleton.update();
    }
  });

  return cloned;
}

/** Safely clone GLTF scenes including skinned meshes with zero runtime errors */
function safeCloneSkeleton(scene: THREE.Object3D): THREE.Object3D {
  try {
    if (typeof (SkeletonUtils as any)?.clone === 'function') {
      return (SkeletonUtils as any).clone(scene);
    }
    if (typeof (SkeletonUtils as any)?.SkeletonUtils?.clone === 'function') {
      return (SkeletonUtils as any).SkeletonUtils.clone(scene);
    }
  } catch {}
  return cloneSkinnedScene(scene);
}

interface SoldierAssetBundle {
  soldierScene: THREE.Group;
  idleClip: THREE.AnimationClip | null;
  shootClip: THREE.AnimationClip | null;
  fallClip: THREE.AnimationClip | null;
  gunScene: THREE.Group | null;
  statuses: {
    main: string;
    shoot: string;
    fall: string;
    gun: string;
  };
}

let assetBundlePromise: Promise<SoldierAssetBundle> | null = null;

/** Load and cache all 4 soldier & animation GLBs with status tracking */
function loadSoldierBundle(): Promise<SoldierAssetBundle> {
  if (assetBundlePromise) return assetBundlePromise;

  assetBundlePromise = new Promise((resolve) => {
    const loader = new GLTFLoader();
    const bundle: SoldierAssetBundle = {
      soldierScene: new THREE.Group(),
      idleClip: null,
      shootClip: null,
      fallClip: null,
      gunScene: null,
      statuses: {
        main: 'Loading...',
        shoot: 'Loading...',
        fall: 'Loading...',
        gun: 'Loading...',
      },
    };

    let remaining = 4;
    const checkDone = () => {
      remaining--;
      if (remaining <= 0) {
        resolve(bundle);
      }
    };

    // 1. Main Soldier (mesh + skeleton)
    loader.load(
      MAIN_SOLDIER_URL,
      (gltf: any) => {
        bundle.soldierScene = gltf.scene;
        bundle.statuses.main = 'Loaded';
        if (gltf.animations && gltf.animations.length > 0) {
          bundle.idleClip = gltf.animations[0];
          bundle.idleClip.name = 'Idle';
        }
        checkDone();
      },
      undefined,
      (err: any) => {
        bundle.statuses.main = 'Error: ' + (err?.message || 'Load failed');
        console.warn('Main soldier GLB load notice:', err?.message);
        checkDone();
      },
    );

    // 2. Shoot Animation (extracted clip - default combat stance)
    loader.load(
      SHOOT_ANIM_URL,
      (gltf: any) => {
        if (gltf.animations && gltf.animations.length > 0) {
          bundle.shootClip = gltf.animations[0];
          bundle.shootClip.name = 'Shoot';
          bundle.statuses.shoot = 'Loaded';
        } else {
          bundle.statuses.shoot = 'Loaded (No clips)';
        }
        checkDone();
      },
      undefined,
      (err: any) => {
        bundle.statuses.shoot = 'Error: ' + (err?.message || 'Load failed');
        console.warn('Shoot anim GLB load notice:', err?.message);
        checkDone();
      },
    );

    // 3. Fall Animation (extracted clip)
    loader.load(
      FALL_ANIM_URL,
      (gltf: any) => {
        if (gltf.animations && gltf.animations.length > 0) {
          bundle.fallClip = gltf.animations[0];
          bundle.fallClip.name = 'Fall';
          bundle.statuses.fall = 'Loaded';
        } else {
          bundle.statuses.fall = 'Loaded (No clips)';
        }
        checkDone();
      },
      undefined,
      (err: any) => {
        bundle.statuses.fall = 'Error: ' + (err?.message || 'Load failed');
        console.warn('Fall anim GLB load notice:', err?.message);
        checkDone();
      },
    );

    // 4. Gun GLB Asset
    loader.load(
      GUN_GLB_URL,
      (gltf: any) => {
        bundle.gunScene = gltf.scene;
        bundle.statuses.gun = 'Loaded';
        checkDone();
      },
      undefined,
      (err: any) => {
        bundle.statuses.gun = 'Error: ' + (err?.message || 'Load failed');
        console.warn('Gun GLB load notice:', err?.message);
        checkDone();
      },
    );
  });

  return assetBundlePromise;
}

/**
 * Shared radial-gradient soft muzzle flash canvas texture for realistic weapon discharge
 */
let sharedMuzzleFlashTexture: THREE.CanvasTexture | null = null;
function getSharedMuzzleFlashTexture(): THREE.CanvasTexture {
  if (!sharedMuzzleFlashTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;

    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.2, 'rgba(255, 220, 110, 0.95)');
    grad.addColorStop(0.45, 'rgba(255, 130, 25, 0.65)');
    grad.addColorStop(0.75, 'rgba(255, 60, 0, 0.22)');
    grad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    sharedMuzzleFlashTexture = new THREE.CanvasTexture(canvas);
    sharedMuzzleFlashTexture.wrapS = THREE.ClampToEdgeWrapping;
    sharedMuzzleFlashTexture.wrapT = THREE.ClampToEdgeWrapping;
  }
  return sharedMuzzleFlashTexture;
}

/**
 * Clean animation clip: keeps ONLY rotation (.quaternion) tracks,
 * removes .position and .scale tracks, and normalizes bone target names using loose matching
 */
function cleanAndRetargetClip(clip: THREE.AnimationClip, root: THREE.Object3D): THREE.AnimationClip {
  const newTracks: THREE.KeyframeTrack[] = [];
  const existingNodeNames = new Set<string>();
  const nameMap = new Map<string, string>();

  root.traverse((obj) => {
    if (obj.name) {
      existingNodeNames.add(obj.name);
      const lower = obj.name.toLowerCase();
      nameMap.set(lower, obj.name);
      const stripped = lower.replace(/^(mixamorig|armature_?|bip01_?)/i, '');
      nameMap.set(stripped, obj.name);
    }
  });

  clip.tracks.forEach((track) => {
    // Keep ONLY rotation (.quaternion) tracks to prevent distortion
    if (!track.name.endsWith('.quaternion')) {
      return;
    }

    const lastDotIndex = track.name.lastIndexOf('.');
    if (lastDotIndex === -1) return;
    const nodeName = track.name.substring(0, lastDotIndex);
    const property = track.name.substring(lastDotIndex + 1);

    let targetName = '';

    if (existingNodeNames.has(nodeName)) {
      targetName = nodeName;
    } else {
      const cleanNodeName = nodeName.replace(/^.*[:|/]/, '');
      if (existingNodeNames.has(cleanNodeName)) {
        targetName = cleanNodeName;
      } else {
        const lower = cleanNodeName.toLowerCase();
        if (nameMap.has(lower)) {
          targetName = nameMap.get(lower)!;
        } else {
          const stripped = lower.replace(/^(mixamorig|armature_?|bip01_?)/i, '');
          if (nameMap.has(stripped)) {
            targetName = nameMap.get(stripped)!;
          }
        }
      }
    }

    if (targetName) {
      const clonedTrack = track.clone();
      clonedTrack.name = `${targetName}.${property}`;
      newTracks.push(clonedTrack);
    }
  });

  return new THREE.AnimationClip(clip.name, clip.duration, newTracks);
}

/**
 * Search all bone objects case-insensitively for right and left hands
 */
function findSoldierHandBones(root: THREE.Object3D): {
  rightHand: THREE.Object3D | null;
  leftHand: THREE.Object3D | null;
} {
  let rightHand: THREE.Object3D | null = null;
  let leftHand: THREE.Object3D | null = null;

  root.traverse((child) => {
    const name = child.name.toLowerCase();

    // Check Right Hand bone candidates
    if (
      !rightHand &&
      (name.includes('r_hand') ||
        name.includes('righthand') ||
        name.includes('hand_r') ||
        name.includes('hand.r') ||
        name.includes('right_hand') ||
        name.includes('cc_base_r_hand') ||
        name.includes('wrist_r') ||
        name.includes('wrist.r') ||
        name.includes('rightwrist') ||
        name.includes('mixamorigrighthand'))
    ) {
      rightHand = child;
    }

    // Check Left Hand (support hand) bone candidates
    if (
      !leftHand &&
      (name.includes('l_hand') ||
        name.includes('lefthand') ||
        name.includes('hand_l') ||
        name.includes('hand.l') ||
        name.includes('left_hand') ||
        name.includes('cc_base_l_hand') ||
        name.includes('wrist_l') ||
        name.includes('wrist.l') ||
        name.includes('leftwrist') ||
        name.includes('mixamoriglefthand'))
    ) {
      leftHand = child;
    }
  });

  return {rightHand, leftHand};
}

/** Error Boundary for safe remote asset loading */
class GLTFErrorBoundary extends React.Component<
  {fallback: React.ReactNode; children: React.ReactNode},
  {hasError: boolean}
> {
  state = {hasError: false};
  static getDerivedStateFromError() {
    return {hasError: true};
  }
  componentDidCatch(err: unknown) {
    console.warn('GLTF loading notice:', err);
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

/** Procedural fallback assault rifle mesh */
function createProceduralRifleMesh() {
  const g = new THREE.Group();
  const receiver = new THREE.Mesh(
    new THREE.BoxGeometry(0.055, 0.08, 0.38),
    new THREE.MeshStandardMaterial({color: '#1a1c22', roughness: 0.4, metalness: 0.85}),
  );
  receiver.castShadow = true;
  g.add(receiver);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.28, 10),
    new THREE.MeshStandardMaterial({color: '#101216', roughness: 0.3, metalness: 0.9}),
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.02, 0.28);
  barrel.castShadow = true;
  g.add(barrel);

  const mag = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.18, 0.08),
    new THREE.MeshStandardMaterial({color: '#1c1f26', roughness: 0.5, metalness: 0.7}),
  );
  mag.position.set(0, -0.12, 0.05);
  mag.rotation.x = -0.25;
  g.add(mag);

  return g;
}

/**
 * Attach gun scaled proportionally to 3.30m soldier (~1.55 units total length)
 * Centered at weapon's pistol grip / trigger area so it sits directly inside RightHand
 */
function createGunAttachment(gunScene: THREE.Group | null): THREE.Group {
  const holder = new THREE.Group();
  holder.name = 'SoldierGunAttachment';

  if (gunScene && gunScene.children.length > 0) {
    const gun = gunScene.clone(true);

    // 1. Rotate gun mesh FIRST so barrel points forward along +Z and stock points backward along -Z
    gun.rotation.set(0, -Math.PI / 2, 0);
    gun.position.set(0, 0, 0);
    gun.scale.set(1, 1, 1);
    gun.updateMatrixWorld(true);

    // Compute bounding box AFTER rotation
    const box = new THREE.Box3().setFromObject(gun);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 0.01);

    // Scale to targetLength = 1.45
    const targetLength = 1.45;
    const s = targetLength / maxDim;
    gun.scale.set(s, s, s);
    gun.updateMatrixWorld(true);

    // Recompute rotatedBox, rSize, and rCenter after scale
    const rotatedBox = new THREE.Box3().setFromObject(gun);
    const rSize = new THREE.Vector3();
    rotatedBox.getSize(rSize);
    const rCenter = new THREE.Vector3();
    rotatedBox.getCenter(rCenter);

    // Center pistol grip directly at (0, 0, 0) of holder
    gun.position.set(
      -rCenter.x,
      -(rotatedBox.min.y + rSize.y * 0.32),
      -(rotatedBox.min.z + rSize.z * 0.30)
    );

    gun.traverse((n: any) => {
      if (n.isMesh) {
        n.frustumCulled = false;
        n.visible = true;
        n.castShadow = true;
        n.receiveShadow = true;
        if (!n.material) {
          n.material = new THREE.MeshStandardMaterial({
            color: '#222730',
            roughness: 0.4,
            metalness: 0.8,
          });
        }
      }
    });

    holder.add(gun);
    holder.position.set(0, 0, 0);

    // Muzzle Anchor at +Z barrel tip of SoldierGunAttachment for gunfire VFX
    const muzzleAnchor = new THREE.Group();
    muzzleAnchor.name = 'muzzleAnchor';
    // Gun projects along local +Z toward LeftHand; barrel tip is located at +Z front
    muzzleAnchor.position.set(0, 0.04, 0.85);
    holder.add(muzzleAnchor);
  } else {
    const fallbackGun = createProceduralRifleMesh();
    fallbackGun.scale.set(2.0, 2.0, 2.0);
    fallbackGun.position.set(0, -0.05, 0.25);
    holder.add(fallbackGun);

    const muzzleAnchor = new THREE.Group();
    muzzleAnchor.name = 'muzzleAnchor';
    muzzleAnchor.position.set(0, 0.04, 0.85);
    holder.add(muzzleAnchor);
  }

  return holder;
}

/** Detailed procedural tactical soldier fallback for offline/loading state */
function ProceduralSoldierFallback({hitAnim}: {hitAnim: number}) {
  const isHit = hitAnim > 0.05;
  return (
    <group position={[0, 0, 0]} scale={[1.4, 1.4, 1.4]}>
      <mesh position={[-0.26, 0.18, 0]} castShadow>
        <boxGeometry args={[0.22, 0.36, 0.38]} />
        <meshStandardMaterial color="#1a1c22" roughness={0.75} />
      </mesh>
      <mesh position={[0.26, 0.18, 0]} castShadow>
        <boxGeometry args={[0.22, 0.36, 0.38]} />
        <meshStandardMaterial color="#1a1c22" roughness={0.75} />
      </mesh>
      <mesh position={[-0.26, 0.75, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.14, 0.85, 10]} />
        <meshStandardMaterial color="#4a4235" roughness={0.8} />
      </mesh>
      <mesh position={[0.26, 0.75, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.14, 0.85, 10]} />
        <meshStandardMaterial color="#4a4235" roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.68, 0.88, 0.38]} />
        <meshStandardMaterial
          color={isHit ? '#ffffff' : '#3d382e'}
          emissive={isHit ? '#ff2222' : '#000000'}
          emissiveIntensity={isHit ? 0.8 : 0}
          roughness={0.6}
        />
      </mesh>
      <mesh position={[0, 1.45, 0.22]} castShadow>
        <boxGeometry args={[0.58, 0.34, 0.14]} />
        <meshStandardMaterial color="#2b261f" roughness={0.8} />
      </mesh>
      <mesh position={[0, 2.15, 0]} castShadow>
        <sphereGeometry args={[0.22, 16, 16]} />
        <meshStandardMaterial color="#1f1d1a" roughness={0.8} />
      </mesh>
      <mesh position={[0, 2.25, 0]} castShadow>
        <sphereGeometry args={[0.25, 16, 16, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
        <meshStandardMaterial color="#353b30" roughness={0.6} />
      </mesh>
      <mesh position={[0, 2.18, 0.2]}>
        <boxGeometry args={[0.3, 0.1, 0.08]} />
        <meshStandardMaterial color="#111" roughness={0.1} metalness={0.9} />
      </mesh>
    </group>
  );
}

interface EnemyTracer {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  maxDist: number;
  speed: number;
}

interface EnemySpark {
  pos: [number, number, number];
  vel: [number, number, number];
  life: number;
  maxLife: number;
}

/**
 * Animated 3D Enemy Soldier:
 * 1. Default Active Stance is "Shoot" (LoopRepeat combat aiming stance, no static T-pose)
 * 2. Scaled to final height 2.35 units (~1.3x bigger) with feet planted on the ground
 * 3. Gun barrel aligned forward in "Shoot" pose
 * 4. Hit color resets back to tactical uniform (0x4b5335) on respawn
 */
function AnimatedSoldierModel({
  hitAnim,
  alive,
  currentAnim,
  initialYaw = 0,
  onDebugReport,
  onEnemyFire,
}: {
  hitAnim: number;
  alive: boolean;
  currentAnim: 'idle' | 'shoot' | 'fall';
  initialYaw?: number;
  onDebugReport?: (info: Partial<SoldierDebugInfo>) => void;
  onEnemyFire?: (muzzleWorldPos: THREE.Vector3, aimWorldDir: THREE.Vector3) => void;
}) {
  const {camera} = useThree();
  const [modelGroup, setModelGroup] = useState<THREE.Group | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionsRef = useRef<{
    idle?: THREE.AnimationAction;
    shoot?: THREE.AnimationAction;
    fall?: THREE.AnimationAction;
  }>({});
  const activeAnimRef = useRef<'idle' | 'shoot' | 'fall'>('idle');
  const soldierRootRef = useRef<THREE.Group | null>(null);
  const rootWrapperRef = useRef<THREE.Group | null>(null);
  const rightHandBoneRef = useRef<THREE.Object3D | null>(null);
  const leftHandBoneRef = useRef<THREE.Object3D | null>(null);
  const gunAttachmentRef = useRef<THREE.Group | null>(null);

  // Fall grounding offset and alert reaction state
  const fallDropYRef = useRef(0);
  const soldierBaseZRef = useRef(0);
  const hasSpottedPlayerRef = useRef(false);
  const spottedTimerRef = useRef(0);
  const currentFacingYawRef = useRef(initialYaw);
  const burstTimerRef = useRef(0);
  const isBurstFiringRef = useRef(false);
  const hasTriggeredFallDustRef = useRef(false);

  // Ground-impact dust puffs for Fall animation
  const dustPuffsRef = useRef<
    Array<{
      pos: [number, number, number];
      vel: [number, number, number];
      scale: number;
      maxScale: number;
      opacity: number;
      life: number;
      maxLife: number;
    }>
  >([]);
  const dustMeshRefs = useRef<Array<THREE.Mesh | null>>([]);
  const whiteDustTexture = useMemo(() => getSharedWhiteDustTexture(), []);
  const [dustColor, setDustColor] = useState('#4c525e');

  // Enemy gunfire VFX state (synced with isBurstFiringRef)
  const burstShotCountRef = useRef(0);
  const nextShotTimeRef = useRef(0);
  const flashTimerRef = useRef(0);
  const flashGroupRef = useRef<THREE.Group>(null);
  const flashLightRef = useRef<THREE.PointLight>(null);
  const smokeMeshRef = useRef<THREE.Mesh>(null);
  const smokeTimerRef = useRef(0);
  const muzzleFlashTexture = useMemo(() => getSharedMuzzleFlashTexture(), []);

  useEffect(() => {
    let active = true;

    loadSoldierBundle().then((bundle) => {
      if (!active) return;

      onDebugReport?.({
        soldierStatus: bundle.statuses.main,
        shootAnimStatus: bundle.statuses.shoot,
        fallAnimStatus: bundle.statuses.fall,
        gunStatus: bundle.statuses.gun,
      });

      if (!bundle.soldierScene || bundle.soldierScene.children.length === 0) return;

      const soldierClone = safeCloneSkeleton(bundle.soldierScene) as THREE.Group;

      soldierClone.position.set(0, 0, 0);
      soldierClone.scale.set(1, 1, 1);
      soldierClone.rotation.set(0, 0, 0);
      soldierClone.updateMatrixWorld(true);

      const rawBox = new THREE.Box3().setFromObject(soldierClone);
      const rawSize = new THREE.Vector3();
      rawBox.getSize(rawSize);
      const rawHeight = Math.max(rawSize.y, 0.001);

      // Scale soldier to final 3.30m height
      const targetHeight = 3.30;
      let finalScale = targetHeight / rawHeight;
      soldierClone.scale.set(finalScale, finalScale, finalScale);
      soldierClone.updateMatrixWorld(true);

      const scaledBox = new THREE.Box3().setFromObject(soldierClone);
      const scaledCenter = new THREE.Vector3();
      scaledBox.getCenter(scaledCenter);

      soldierClone.position.set(
        -scaledCenter.x,
        -scaledBox.min.y,
        -scaledCenter.z,
      );
      soldierBaseZRef.current = -scaledCenter.z;
      soldierClone.updateMatrixWorld(true);

      let meshCount = 0;
      let boneCount = 0;

      soldierClone.traverse((n: any) => {
        if (n.isMesh || n.isSkinnedMesh) {
          meshCount++;
          n.visible = true;
          n.frustumCulled = false;
          n.castShadow = true;
          n.receiveShadow = true;

          // 1. Preserve original embedded textures & render solidly
          const inspectAndPreserveMaterial = (origMat: any) => {
            if (!origMat) {
              return new THREE.MeshStandardMaterial({
                color: 0xffffff,
                roughness: 0.7,
                metalness: 0.1,
                transparent: false,
                opacity: 1.0,
                side: THREE.DoubleSide,
              });
            }

            origMat.transparent = false;
            origMat.opacity = 1.0;
            origMat.alphaTest = 0;
            if (origMat.color) {
              origMat.color.setHex(0xffffff);
            }
            origMat.side = THREE.DoubleSide;
            origMat.depthWrite = true;
            origMat.needsUpdate = true;
            return origMat;
          };

          if (Array.isArray(n.material)) {
            n.material = n.material.map(inspectAndPreserveMaterial);
          } else {
            n.material = inspectAndPreserveMaterial(n.material);
          }

          if (n.isSkinnedMesh && n.skeleton) {
            n.bind(n.skeleton, n.bindMatrix);
            n.skeleton.update();
          }
        }
        if (n.isBone) {
          boneCount++;
        }
      });

      const finalBox = new THREE.Box3().setFromObject(soldierClone);
      const finalH = finalBox.max.y - finalBox.min.y;

      onDebugReport?.({
        meshBoneCount: `${meshCount} meshes / ${boneCount} bones`,
        finalHeight: `${finalH.toFixed(2)}m`,
      });

      // Find both right hand and left support hand bones
      const {rightHand, leftHand} = findSoldierHandBones(soldierClone);
      rightHandBoneRef.current = rightHand;
      leftHandBoneRef.current = leftHand;

      const gunObj = createGunAttachment(bundle.gunScene);
      gunAttachmentRef.current = gunObj;

      const mixer = new THREE.AnimationMixer(soldierClone);
      const actions: {
        idle?: THREE.AnimationAction;
        shoot?: THREE.AnimationAction;
        fall?: THREE.AnimationAction;
      } = {};

      if (bundle.shootClip) {
        const retargetedShoot = cleanAndRetargetClip(bundle.shootClip, soldierClone);
        const action = mixer.clipAction(retargetedShoot);
        action.setLoop(THREE.LoopRepeat, Infinity);
        actions.shoot = action;

        // Calm Guard Stance: hold frame 0 of Shoot clip with subtle breathing (clamped at time 0)
        const alertClip = retargetedShoot.clone();
        alertClip.name = 'AlertGuard';
        const alertAction = mixer.clipAction(alertClip);
        alertAction.setLoop(THREE.LoopOnce, 1);
        alertAction.clampWhenFinished = true;
        actions.idle = alertAction;
      } else if (bundle.idleClip) {
        const retargetedIdle = cleanAndRetargetClip(bundle.idleClip, soldierClone);
        const action = mixer.clipAction(retargetedIdle);
        action.setLoop(THREE.LoopRepeat, Infinity);
        actions.idle = action;
      }

      if (bundle.fallClip) {
        const retargetedFall = cleanAndRetargetClip(bundle.fallClip, soldierClone);
        const action = mixer.clipAction(retargetedFall);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        actions.fall = action;
      }

      mixerRef.current = mixer;
      actionsRef.current = actions;

      // Start in Alert Guard stance (holding ready aim pose before firing)
      const defaultAction = actions.idle || actions.shoot;
      if (defaultAction) {
        defaultAction.reset().play();
        activeAnimRef.current = 'idle';
      }

      const rootWrapper = new THREE.Group();
      rootWrapper.add(soldierClone);
      rootWrapper.add(gunObj);
      rootWrapper.rotation.y = initialYaw;

      soldierRootRef.current = soldierClone;
      rootWrapperRef.current = rootWrapper;
      setModelGroup(rootWrapper);
    });

    return () => {
      active = false;
    };
  }, [onDebugReport]);

  // Frame loop
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (mixerRef.current) {
      mixerRef.current.update(dt);
    }

    // 3. Realistic Gravity Fall Grounding & Knockback Drift:
    // Standing baseY is floorY + 1.65 so boots stand squarely on top of the floor.
    // Drops via fast gravity ease-out curve to flush floor resting height floorY + 0.20.
    const floorY = getGroundFloorY(
      rootWrapperRef.current ? rootWrapperRef.current.position.x : 0,
      rootWrapperRef.current ? rootWrapperRef.current.position.z : 0
    );

    const standingBaseY = floorY + 1.65;
    const finalLyingY = floorY + 0.20;

    if (soldierRootRef.current && rootWrapperRef.current) {
      if (!alive || currentAnim === 'fall') {
        const fallAction = actionsRef.current.fall;
        let progress = 1.0;
        if (fallAction) {
          const clipDuration = fallAction.getClip().duration || 1.0;
          progress = Math.min(1.0, Math.max(0.0, fallAction.time / clipDuration));
        }

        // Trigger one-shot ground-impact dust burst at progress >= 0.35 when soldier hits the ground
        if (progress >= 0.35 && !hasTriggeredFallDustRef.current) {
          hasTriggeredFallDustRef.current = true;
          const numPuffs = 10;
          dustPuffsRef.current = [];
          for (let i = 0; i < numPuffs; i++) {
            const angle = (i / numPuffs) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
            const speed = 1.3 + Math.random() * 0.9;
            dustPuffsRef.current.push({
              pos: [
                (Math.random() - 0.5) * 0.7,
                0.25,
                (Math.random() - 0.5) * 1.1 - 0.3, // Spreading across torso, hips, and feet
              ],
              vel: [
                Math.cos(angle) * speed,
                0.35 + Math.random() * 0.25,
                Math.sin(angle) * speed,
              ],
              scale: 1.1 + Math.random() * 0.25,
              maxScale: 3.2 + Math.random() * 0.6,
              opacity: 0.32,
              life: 1.0,
              maxLife: 1.0,
            });
          }
        }

        // Fast gravity ease-out curve: 1 - Math.pow(1 - progress, 3.0)
        // Hips drop to ground immediately as knees buckle rather than hovering
        const fallProgress = 1.0 - Math.pow(1.0 - progress, 3.0);
        const targetY = THREE.MathUtils.lerp(standingBaseY, finalLyingY, fallProgress);

        fallDropYRef.current = THREE.MathUtils.lerp(
          fallDropYRef.current,
          targetY,
          dt * 14.0
        );
        soldierRootRef.current.position.y = fallDropYRef.current;

        // Backward knockback drift (~0.7 units backward along local -Z)
        const targetZ = soldierBaseZRef.current - 0.7 * fallProgress;
        soldierRootRef.current.position.z = THREE.MathUtils.lerp(
          soldierRootRef.current.position.z,
          targetZ,
          dt * 14.0
        );
      } else {
        // Standing upright: boots stand right on top of the floor with +1.65m offset
        fallDropYRef.current = standingBaseY;
        soldierRootRef.current.position.y = standingBaseY;
        soldierRootRef.current.position.z = soldierBaseZRef.current;
        hasTriggeredFallDustRef.current = false;
        dustPuffsRef.current = [];
      }
    }

    // Animate and update dust puffs over ~0.85 seconds
    const dustPuffs = dustPuffsRef.current;
    for (let i = dustPuffs.length - 1; i >= 0; i--) {
      const p = dustPuffs[i];
      p.life -= dt;
      if (p.life <= 0) {
        dustPuffs.splice(i, 1);
        continue;
      }
      p.pos[0] += p.vel[0] * dt;
      p.pos[1] += p.vel[1] * dt;
      p.pos[2] += p.vel[2] * dt;
      p.vel[0] *= 0.94;
      p.vel[1] *= 0.90;
      p.vel[2] *= 0.94;
    }

    // Update dust mesh instances (10 puffs)
    for (let i = 0; i < 10; i++) {
      const mesh = dustMeshRefs.current[i];
      if (mesh) {
        if (i < dustPuffs.length) {
          const p = dustPuffs[i];
          const progress = 1 - p.life / p.maxLife; // 0 to 1
          mesh.visible = true;
          mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
          const sc = THREE.MathUtils.lerp(p.scale, p.maxScale, progress);
          mesh.scale.set(sc, sc, sc);
          // Billboard facing the camera
          mesh.quaternion.copy(camera.quaternion);
          const mat = mesh.material as THREE.MeshBasicMaterial;
          if (mat) {
            mat.opacity = (1 - progress) * p.opacity;
          }
        } else {
          mesh.visible = false;
        }
      }
    }

    // 2. Stop Non-Stop Firing (Guard -> Aim -> Burst):
    // Spawn in calm Guard stance (holding frame 0 of Shoot with subtle breathing, NO firing).
    // When player enters range (< 32m), smoothly turn to face player over 0.8s, aim directly at camera,
    // and fire short 2-3 shot bursts (~0.5s active) with 1.5s pauses instead of shooting endlessly.
    if (alive && currentAnim !== 'fall' && rootWrapperRef.current) {
      rootWrapperRef.current.getWorldPosition(vTargetPosScratch);
      const dx = camera.position.x - vTargetPosScratch.x;
      const dz = camera.position.z - vTargetPosScratch.z;
      const distSq = dx * dx + dz * dz;

      // Subtle breathing motion applied to chest/arms in calm guard stance
      if (!isBurstFiringRef.current && soldierRootRef.current) {
        const breath = Math.sin(Date.now() * 0.003) * 0.012;
        soldierRootRef.current.position.y = standingBaseY + breath;
      }

      if (distSq > 0.04) {
        const angleToPlayer = Math.atan2(dx, dz);
        const targetFacingYaw = angleToPlayer - 0.50;

        if (distSq < 17 * 17) {
          // Smoothly turn to face the player over 0.8s
          currentFacingYawRef.current = THREE.MathUtils.damp(
            currentFacingYawRef.current,
            targetFacingYaw,
            1.25, // ~0.8s smooth rotation convergence
            dt
          );
          rootWrapperRef.current.rotation.y = currentFacingYawRef.current;

          // Guard -> Burst state machine:
          burstTimerRef.current += dt;
          if (!isBurstFiringRef.current) {
            // Calm Guard/Aiming pause (1.5s pause between bursts)
            if (burstTimerRef.current >= 1.5) {
              burstTimerRef.current = 0;
              isBurstFiringRef.current = true;
              burstShotCountRef.current = 0;
              nextShotTimeRef.current = 0; // Trigger first shot immediately

              // Start short 2-3 shot firing burst
              const actions = actionsRef.current;
              if (actions?.shoot) {
                actions.idle?.fadeOut(0.15);
                actions.shoot.reset().setLoop(THREE.LoopRepeat, Infinity).fadeIn(0.15).play();
                activeAnimRef.current = 'shoot';
              }
            }
          } else {
            // Synced 2-3 shots during the ~0.55s burst window
            if (burstTimerRef.current >= nextShotTimeRef.current && burstShotCountRef.current < 3) {
              burstShotCountRef.current++;
              // Interval between shots in the 2-3 shot burst: ~0.16s
              nextShotTimeRef.current = burstTimerRef.current + 0.16;

              // Trigger Muzzle Flash VFX
              flashTimerRef.current = 0.028; // ~28ms duration
              smokeTimerRef.current = 0.25; // 0.25s smoke puff expansion and fade
              if (flashGroupRef.current) {
                flashGroupRef.current.visible = true;
                flashGroupRef.current.rotation.z = Math.random() * Math.PI * 2;
                const sc = 0.8 + Math.random() * 0.4;
                flashGroupRef.current.scale.set(sc, sc, sc);
              }
              if (flashLightRef.current) {
                flashLightRef.current.visible = true;
              }

              // Fire tracer towards player's camera position with slight spread
              if (rightHandBoneRef.current && leftHandBoneRef.current) {
                const rightHand = rightHandBoneRef.current;
                const leftHand = leftHandBoneRef.current;
                rightHand.updateWorldMatrix(true, false);
                leftHand.updateWorldMatrix(true, false);
                rightHand.getWorldPosition(vHandRScratch);
                leftHand.getWorldPosition(vHandLScratch);

                vSoldierAimDirScratch.subVectors(vHandLScratch, vHandRScratch).normalize();
                vMuzzlePosScratch.copy(vHandLScratch)
                  .addScaledVector(vSoldierAimDirScratch, 0.38)
                  .add({x: 0, y: 0.14, z: 0});

                if (flashGroupRef.current && flashGroupRef.current.parent) {
                  flashGroupRef.current.position.copy(vMuzzlePosScratch);
                  flashGroupRef.current.parent.worldToLocal(flashGroupRef.current.position);
                }

                // Lead/aim toward camera position with realistic combat dispersion
                vTargetPosScratch.set(
                  camera.position.x + (Math.random() - 0.5) * 1.4,
                  camera.position.y + (Math.random() - 0.5) * 0.9,
                  camera.position.z + (Math.random() - 0.5) * 1.4
                );
                vAimDirScratch.subVectors(vTargetPosScratch, vMuzzlePosScratch).normalize();
                onEnemyFire?.(vMuzzlePosScratch, vAimDirScratch);
              } else if (gunAttachmentRef.current) {
                const muzzleObj = gunAttachmentRef.current.getObjectByName('muzzleAnchor');
                const mPos = vMuzzlePosScratch;
                if (muzzleObj) {
                  muzzleObj.getWorldPosition(mPos);
                } else {
                  gunAttachmentRef.current.getWorldPosition(mPos);
                }

                if (flashGroupRef.current && flashGroupRef.current.parent) {
                  flashGroupRef.current.position.copy(mPos);
                  flashGroupRef.current.parent.worldToLocal(flashGroupRef.current.position);
                }

                // Lead/aim toward camera position with realistic combat dispersion
                vTargetPosScratch.set(
                  camera.position.x + (Math.random() - 0.5) * 1.4,
                  camera.position.y + (Math.random() - 0.5) * 0.9,
                  camera.position.z + (Math.random() - 0.5) * 1.4
                );
                vAimDirScratch.subVectors(vTargetPosScratch, mPos).normalize();
                onEnemyFire?.(mPos, vAimDirScratch);
              }
            }

            // Active firing burst lasting ~0.55s (approx 2-3 shots)
            if (burstTimerRef.current >= 0.55) {
              burstTimerRef.current = 0;
              isBurstFiringRef.current = false;
              // Pause firing and hold ready combat aim pose
              const actions = actionsRef.current;
              if (actions?.idle) {
                actions.shoot?.fadeOut(0.15);
                actions.idle.reset().setLoop(THREE.LoopOnce, 1);
                actions.idle.clampWhenFinished = true;
                actions.idle.fadeIn(0.15).play();
                activeAnimRef.current = 'idle';
              }
            }
          }
        } else {
          // 2. Beyond engagement distance: watch along distinct initial look angle
          currentFacingYawRef.current = initialYaw;
          rootWrapperRef.current.rotation.y = initialYaw;
          isBurstFiringRef.current = false;
          burstTimerRef.current = 0;
        }
      }
    }

    // Update ~28ms Muzzle Flash Visibility & Gunsmoke Puff Expansion/Fade
    if (flashTimerRef.current > 0) {
      flashTimerRef.current -= dt;
      if (flashTimerRef.current <= 0) {
        if (flashLightRef.current) flashLightRef.current.visible = false;
      }
    }

    if (smokeTimerRef.current > 0) {
      smokeTimerRef.current -= dt;
      const progress = Math.max(0, 1 - smokeTimerRef.current / 0.25); // 0 to 1
      if (smokeMeshRef.current) {
        smokeMeshRef.current.visible = true;
        const currentScale = THREE.MathUtils.lerp(0.15, 0.45, progress);
        smokeMeshRef.current.scale.set(currentScale, currentScale, currentScale);
        const mat = smokeMeshRef.current.material as THREE.MeshBasicMaterial;
        if (mat) {
          mat.opacity = THREE.MathUtils.lerp(0.28, 0, progress);
        }
      }
      if (smokeTimerRef.current <= 0) {
        if (smokeMeshRef.current) smokeMeshRef.current.visible = false;
        if (flashGroupRef.current) flashGroupRef.current.visible = false;
      }
    } else {
      if (flashTimerRef.current <= 0 && flashGroupRef.current) {
        flashGroupRef.current.visible = false;
      }
    }

    // 2. Keep useFrame Alignment Unchanged:
    // Keep gunAttachmentRef locked at rHandWorldPos (with (0, -0.02, 0) local seat)
    // and oriented along normalize(lHandWorldPos - rHandWorldPos) without adding any extra 180-degree flip in useFrame.
    if (rightHandBoneRef.current && gunAttachmentRef.current && soldierRootRef.current) {
      const gun = gunAttachmentRef.current;
      const rightHand = rightHandBoneRef.current;
      rightHand.updateWorldMatrix(true, false);

      rightHand.getWorldPosition(vHandRScratch);
      const parent = gun.parent;
      if (parent) {
        // Place gun at right hand position
        gun.position.copy(vHandRScratch);
        parent.worldToLocal(gun.position);

        const parentWorldQuat = qParentInvertScratch;
        parent.getWorldQuaternion(parentWorldQuat);

        if (leftHandBoneRef.current) {
          const leftHand = leftHandBoneRef.current;
          leftHand.updateWorldMatrix(true, false);
          leftHand.getWorldPosition(vHandLScratch);

          const aimDirWorld = vAimDirScratch.subVectors(vHandLScratch, vHandRScratch);

          if (aimDirWorld.lengthSq() > 0.01) {
            aimDirWorld.normalize();

            // Transform aim direction into local space of parent
            const qPInv = qRHandWorldScratch.copy(parentWorldQuat).invert();
            vSoldierAimDirScratch.copy(aimDirWorld).applyQuaternion(qPInv).normalize();

            vForwardScratch.copy(vSoldierAimDirScratch);
            vWorldUpLocalScratch.set(0, 1, 0).applyQuaternion(qPInv).normalize();
            vSideScratch.crossVectors(vWorldUpLocalScratch, vForwardScratch).normalize();
            vUpScratch.crossVectors(vForwardScratch, vSideScratch).normalize();

            mRotMatrixScratch.makeBasis(vSideScratch, vUpScratch, vForwardScratch);
            gun.quaternion.setFromRotationMatrix(mRotMatrixScratch);

            // Aim adjustment: restore exact horizontal angle aligned with extended front hand
            gun.quaternion.multiply(qAimAdjustScratch);

            // Grip seat offset: slide forward along barrel (-0.32 X), down into hands (-0.12 Y), away from cheek (-0.06 Z)
            vImpactScratch.set(-0.32, -0.12, -0.06).applyQuaternion(gun.quaternion);
            gun.position.add(vImpactScratch);
          } else {
            rightHand.getWorldQuaternion(qRHandWorldScratch);
            gun.quaternion.copy(parentWorldQuat.invert().multiply(qRHandWorldScratch));
            gun.quaternion.multiply(qAimAdjustScratch);
            vImpactScratch.set(-0.32, -0.12, -0.06).applyQuaternion(gun.quaternion);
            gun.position.add(vImpactScratch);
          }
        } else {
          rightHand.getWorldQuaternion(qRHandWorldScratch);
          gun.quaternion.copy(parentWorldQuat.invert().multiply(qRHandWorldScratch));
          gun.quaternion.multiply(qAimAdjustScratch);
          vImpactScratch.set(-0.32, -0.12, -0.06).applyQuaternion(gun.quaternion);
          gun.position.add(vImpactScratch);
        }

        // Keep muzzle flash group tracked at muzzle position
        if (flashGroupRef.current) {
          if (leftHandBoneRef.current) {
            const leftHand = leftHandBoneRef.current;
            leftHand.updateWorldMatrix(true, false);
            leftHand.getWorldPosition(vHandLScratch);

            const aimDirWorld = vAimDirScratch.subVectors(vHandLScratch, vHandRScratch).normalize();
            vMuzzlePosScratch.copy(vHandLScratch)
              .addScaledVector(aimDirWorld, 0.38)
              .add({x: 0, y: 0.14, z: 0});

            flashGroupRef.current.position.copy(vMuzzlePosScratch);
            if (flashGroupRef.current.parent) {
              flashGroupRef.current.parent.worldToLocal(flashGroupRef.current.position);
            }
          } else {
            const muzzleObj = gun.getObjectByName('muzzleAnchor');
            if (muzzleObj) {
              muzzleObj.getWorldPosition(vMuzzlePosScratch);
              flashGroupRef.current.position.copy(vMuzzlePosScratch);
              if (flashGroupRef.current.parent) {
                flashGroupRef.current.parent.worldToLocal(flashGroupRef.current.position);
              }
            }
          }
        }
      }
    }

    if (soldierRootRef.current && onDebugReport) {
      soldierRootRef.current.getWorldPosition(vTargetPosScratch);
      soldierRootRef.current.getWorldScale(vMuzzlePosScratch);
      onDebugReport({
        worldPos: `[${vTargetPosScratch.x.toFixed(1)}, ${vTargetPosScratch.y.toFixed(2)}, ${vTargetPosScratch.z.toFixed(1)}]`,
        scale: `[${vMuzzlePosScratch.x.toFixed(2)}, ${vMuzzlePosScratch.y.toFixed(2)}, ${vMuzzlePosScratch.z.toFixed(2)}]`,
        activeAnim: activeAnimRef.current,
      });
    }
  });

  const switchAnimation = useCallback((targetAnimName: 'idle' | 'shoot' | 'fall') => {
    const actions = actionsRef.current;
    if (!actions) return;

    const prevName = activeAnimRef.current;
    const prevAction = actions[prevName];
    const nextAction = actions[targetAnimName] || actions.idle;

    if (!nextAction) return;

    if (prevAction && prevAction !== nextAction) {
      prevAction.fadeOut(0.2);
    }

    nextAction.reset();
    if (targetAnimName === 'fall') {
      nextAction.setLoop(THREE.LoopOnce, 1);
      nextAction.clampWhenFinished = true;
    } else {
      nextAction.setLoop(THREE.LoopRepeat, Infinity);
      nextAction.clampWhenFinished = false;
    }

    nextAction.fadeIn(0.2).play();
    activeAnimRef.current = targetAnimName;
  }, []);

  useEffect(() => {
    switchAnimation(currentAnim);
  }, [currentAnim, switchAnimation]);

  // Flash emissive color on bullet impact and reset on respawn
  useEffect(() => {
    if (!modelGroup) return;

    if (!alive) {
      modelGroup.traverse((node: any) => {
        if (node.isMesh && node.material) {
          if (Array.isArray(node.material)) {
            node.material.forEach((m: any) => {
              m.emissive?.set?.('#000000');
              if (m.color) m.color.setHex(0xffffff);
            });
          } else {
            if (node.material.emissive) node.material.emissive.set('#000000');
            if (node.material.color) node.material.color.setHex(0xffffff);
          }
        }
      });
      return;
    }

    if (hitAnim > 0.05) {
      modelGroup.traverse((node: any) => {
        if (node.isMesh && node.material) {
          if (Array.isArray(node.material)) {
            node.material.forEach((m: any) => m.emissive?.set?.('#ff2222'));
          } else if (node.material.emissive) {
            node.material.emissive.set('#ff2222');
          }
        }
      });
      const timer = setTimeout(() => {
        modelGroup.traverse((node: any) => {
          if (node.isMesh && node.material) {
            if (Array.isArray(node.material)) {
              node.material.forEach((m: any) => {
                m.emissive?.set?.('#000000');
                if (m.color) m.color.setHex(0xffffff); // Restore original embedded texture color
              });
            } else if (node.material.emissive) {
              node.material.emissive.set('#000000');
              if (node.material.color) node.material.color.setHex(0xffffff);
            }
          }
        });
      }, 90);
      return () => clearTimeout(timer);
    } else {
      modelGroup.traverse((node: any) => {
        if (node.isMesh && node.material) {
          if (Array.isArray(node.material)) {
            node.material.forEach((m: any) => {
              m.emissive?.set?.('#000000');
              if (m.color) m.color.setHex(0xffffff);
            });
          } else {
            if (node.material.emissive) node.material.emissive.set('#000000');
            if (node.material.color) node.material.color.setHex(0xffffff);
          }
        }
      });
    }
  }, [hitAnim, alive, modelGroup]);

  // Determine indoor vs outdoor dust color from soldier's actual world Z position
  useEffect(() => {
    if (rootWrapperRef.current) {
      rootWrapperRef.current.getWorldPosition(vTargetPosScratch);
      const isOutdoor = vTargetPosScratch.z <= -28;
      setDustColor(isOutdoor ? '#e0c394' : '#b8bec7');
    }
  }, [modelGroup]);

  if (!modelGroup) {
    return <ProceduralSoldierFallback hitAnim={hitAnim} />;
  }

  return (
    <group>
      <primitive object={modelGroup} />

      {/* Ground-impact dust puffs triggered during Fall animation */}
      {Array.from({length: 10}).map((_, i) => (
        <mesh
          key={`fall-dust-${i}`}
          ref={(el) => {
            dustMeshRefs.current[i] = el;
          }}
          visible={false}>
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial
            map={whiteDustTexture}
            transparent
            opacity={0.32}
            roughness={1.0}
            metalness={0.0}
            depthWrite={false}
            color={dustColor}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* Realistic Enemy Muzzle Flash on 2 crossed planes + brief PointLight at muzzleAnchor */}
      {gunAttachmentRef.current && (
        <group ref={flashGroupRef} visible={false}>
          {/* Plane 1 */}
          <mesh rotation={[0, 0, 0]}>
            <planeGeometry args={[0.55, 0.55]} />
            <meshBasicMaterial
              map={muzzleFlashTexture}
              transparent
              opacity={0.58}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              color="#e6d2b5"
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Plane 2 (Crossed at 90 deg around Z) */}
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <planeGeometry args={[0.55, 0.55]} />
            <meshBasicMaterial
              map={muzzleFlashTexture}
              transparent
              opacity={0.58}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              color="#d4b483"
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* Brief PointLight for realistic muzzle illumination */}
          <pointLight
            ref={flashLightRef}
            color="#e0c69f"
            intensity={4.5}
            distance={5.5}
            decay={2}
            visible={false}
          />
        </group>
      )}
    </group>
  );
}

/**
 * Tactical Soldier Target Standing Directly On Ground (No Stands/Boxes)
 * Controls animation state defaulting to Shoot stance, falling on defeat, and cleanly respawning
 */
function TacticalTarget({
  target,
  targetMeshRef,
  testAnim = 'shoot',
  onDebugReport,
  onEnemyFire,
}: {
  target: TargetData;
  targetMeshRef: (el: THREE.Group | null) => void;
  testAnim?: 'idle' | 'shoot' | 'fall';
  onDebugReport?: (info: Partial<SoldierDebugInfo>) => void;
  onEnemyFire?: (muzzleWorldPos: THREE.Vector3, aimWorldDir: THREE.Vector3) => void;
}) {
  // Default to 'shoot' combat aiming pose instead of static T-pose
  const activeAnim: 'idle' | 'shoot' | 'fall' = !target.alive ? 'fall' : (testAnim === 'idle' ? 'shoot' : testAnim);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (target.hitAnim > 0) {
      target.hitAnim = Math.max(0, target.hitAnim - dt * 4);
    }
  });

  // 2. Keep Defeated Soldiers Down Permanently:
  // Once a soldier's hp <= 0 (target.alive = false), he plays Fall once and stays lying on the floor permanently without respawning.

  return (
    <group
      ref={targetMeshRef}
      position={[target.position[0], 0, target.position[2]]}>
      <GLTFErrorBoundary
        fallback={<ProceduralSoldierFallback hitAnim={target.hitAnim} />}>
        <AnimatedSoldierModel
          hitAnim={target.hitAnim}
          alive={target.alive}
          currentAnim={activeAnim}
          initialYaw={target.initialYaw ?? 0}
          onDebugReport={target.id === 1 ? onDebugReport : undefined}
          onEnemyFire={onEnemyFire}
        />
      </GLTFErrorBoundary>
    </group>
  );
}

/**
 * FPS Scene & PointerLock Camera Controller
 */
function FPSScene({
  gameState,
  setGameState,
  inputRef,
  exitChat,
  gameStateRef,
  ammo,
  setAmmo,
  setIsLocked,
  showHitMarker,
  triggerHitMarker,
  isGameMenuOpen,
  testAnim = 'shoot',
  onUpdateDebug,
}: SceneProps) {
  const {camera, gl} = useThree();
  const playerBodyRef = useRef<RapierRigidBody>(null);

  const cameraEuler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'));
  const isPointerLocked = useRef(false);

  const recoilRef = useRef({time: 0, amount: 0});
  const muzzleFlashRef = useRef(false);
  const footstepTimerRef = useRef(0);

  // 2. Vary Initial Look Angles for the 3 Soldiers:
  // Keep the exact same 3 spawn locations, with distinct initial guard facing angles
  const targetsRef = useRef<TargetData[]>([
    {
      id: 1,
      position: getClearSpawnPosition([-3.8, 0, -11.5]),
      hp: 3,
      maxHp: 3,
      hitAnim: 0,
      alive: true,
      initialYaw: -0.35, // Watching toward CQB entrance doorway
    },
    {
      id: 2,
      position: getClearSpawnPosition([-2.0, 0, -39.0]),
      hp: 3,
      maxHp: 3,
      hitAnim: 0,
      alive: true,
      initialYaw: 0.75, // Watching diagonally toward the left sandbag bunker
    },
    {
      id: 3,
      position: getClearSpawnPosition([5.2, 0, -56.5]),
      hp: 3,
      maxHp: 3,
      hitAnim: 0,
      alive: true,
      initialYaw: -1.45, // Watching across toward the right shipping container flank
    },
  ]);

  const targetGroupMap = useRef<Map<number, THREE.Group>>(new Map());

  const sparksRef = useRef<
    {pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number}[]
  >([]);
  const sparksInstancedRef = useRef<THREE.InstancedMesh>(null);
  const sparkDummy = useMemo(() => new THREE.Object3D(), []);

  // Enemy gunfire tracers and impact sparks
  const enemyTracersRef = useRef<EnemyTracer[]>([]);
  const enemySparksRef = useRef<EnemySpark[]>([]);
  const enemyTracersInstancedRef = useRef<THREE.InstancedMesh>(null);
  const enemySparksInstancedRef = useRef<THREE.InstancedMesh>(null);
  const tracerDummy = useMemo(() => new THREE.Object3D(), []);
  const enemySparkDummy = useMemo(() => new THREE.Object3D(), []);

  const handleEnemyFire = useCallback((mPos: THREE.Vector3, dir: THREE.Vector3) => {
    // Play concussive distant gunfire sound with transient punch
    gameAudio.playGunshotBlast();

    // Spawn fast glowing tracer streak towards player's position
    const tracerSpeed = 110.0; // fast realistic projectile speed
    const maxDist = 80.0;
    enemyTracersRef.current.push({
      pos: mPos.clone(),
      dir: dir.clone(),
      dist: 0,
      maxDist,
      speed: tracerSpeed,
    });
  }, []);

  useEffect(() => {
    const dom = gl.domElement;

    const handlePointerLockChange = () => {
      const locked = document.pointerLockElement === dom;
      isPointerLocked.current = locked;
      setIsLocked(locked);
    };

    const handlePointerLockError = () => {
      console.warn('PointerLock encountered an error.');
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPointerLocked.current || isGameMenuOpen) return;
      const sensitivity = 0.0022 * getConfig('mouseSensitivity');
      cameraEuler.current.y -= e.movementX * sensitivity;
      cameraEuler.current.x -= e.movementY * sensitivity;
      const maxPitch = THREE.MathUtils.degToRad(88);
      cameraEuler.current.x = Math.max(-maxPitch, Math.min(maxPitch, cameraEuler.current.x));
    };

    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('pointerlockerror', handlePointerLockError);
    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('pointerlockerror', handlePointerLockError);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [gl, setIsLocked, isGameMenuOpen]);

  const handleCanvasClick = useCallback(() => {
    if (gameState.status !== 'PLAYING' || isGameMenuOpen) return;
    if (!isPointerLocked.current && gl.domElement.requestPointerLock) {
      Promise.resolve(gl.domElement.requestPointerLock()).catch(() => {});
    }
  }, [gl, gameState.status, isGameMenuOpen]);

  useEffect(() => {
    const dom = gl.domElement;
    dom.addEventListener('click', handleCanvasClick);
    return () => {
      dom.removeEventListener('click', handleCanvasClick);
    };
  }, [gl, handleCanvasClick]);

  const shoot = useCallback(() => {
    if (gameStateRef.current.status !== 'PLAYING' || isGameMenuOpen) return;

    if (ammo.mag <= 0) {
      gameAudio.playCrispClick();
      return;
    }

    setAmmo((prev) => ({...prev, mag: prev.mag - 1}));

    gameAudio.playGunshotBlast();
    setTimeout(() => {
      gameAudio.playShellCasingDrop();
    }, 180);
    recoilRef.current.amount = getConfig('recoilImpulse');
    muzzleFlashRef.current = true;

    camera.getWorldPosition(vRayOrigin);
    camera.getWorldDirection(vRayDir);
    raycaster.set(vRayOrigin, vRayDir);
    raycaster.far = 120;

    let hitTarget = false;

    for (const target of targetsRef.current) {
      if (!target.alive) continue;
      const group = targetGroupMap.current.get(target.id);
      if (!group) continue;

      const intersects = raycaster.intersectObjects(group.children, true);
      if (intersects.length > 0) {
        const hit = intersects[0];
        hitTarget = true;
        target.hp -= 1;
        target.hitAnim = 1.0;
        triggerHitMarker();
        gameAudio.playShieldBlock();

        for (let i = 0; i < 8; i++) {
          vSparksVelScratch.set(
            (Math.random() - 0.5) * 4,
            Math.random() * 3 + 1,
            (Math.random() - 0.5) * 4
          );
          sparksRef.current.push({
            pos: hit.point.clone(),
            vel: vSparksVelScratch.clone(),
            life: 0.35,
            maxLife: 0.35,
          });
        }

        if (target.hp <= 0) {
          target.alive = false;
          gameAudio.playMeleePunch();
          setGameState((prev) => ({...prev, score: prev.score + 100}));

          const allDead = targetsRef.current.every((t) => !t.alive);
          if (allDead) {
            setGameState((prev) => ({...prev, status: 'VICTORY'}));
          }
        }
        break;
      }
    }

    if (!hitTarget) {
      setTimeout(() => {
        setAmmo((curr) => {
          if (curr.mag <= 0 && curr.reserve <= 0) {
            const allDead = targetsRef.current.every((t) => !t.alive);
            if (!allDead && gameStateRef.current.status === 'PLAYING') {
              gameAudio.playDefeatMotif();
              setGameState((prev) => ({...prev, status: 'GAME_OVER'}));
            }
          }
          return curr;
        });
      }, 100);
    }
  }, [
    ammo.mag,
    camera,
    gameStateRef,
    isGameMenuOpen,
    setAmmo,
    setGameState,
    triggerHitMarker,
  ]);

  const reload = useCallback(() => {
    if (!['PLAYING', 'VICTORY'].includes(gameStateRef.current.status)) return;
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
  }, [gameStateRef, setAmmo]);

  const wasShootingRef = useRef(false);
  const prevGamepadButtonsRef = useRef<{
    shoot: boolean;
    reload: boolean;
    pause: boolean;
  }>({shoot: false, reload: false, pause: false});

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        reload();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reload]);

  useEffect(() => {
    const dom = gl.domElement;
    const handlePointerDown = (e: PointerEvent) => {
      if (e.button === 0 && isPointerLocked.current) {
        shoot();
      }
    };
    dom.addEventListener('pointerdown', handlePointerDown);
    return () => dom.removeEventListener('pointerdown', handlePointerDown);
  }, [gl, shoot]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const body = playerBodyRef.current;
    if (!body) return;

    // 1. Safe Gamepad Polling: only process if connected
    const gp = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()?.[0] : null;
    if (gp && gp.connected) {
      // 4. Edge-Triggered Controller Buttons
      // Right Trigger (buttons[7]?.value > 0.3) or A (buttons[0]?.pressed): Shoot once per press
      const isShootPressed = Boolean(
        (gp.buttons[7] && (gp.buttons[7].value > 0.3 || gp.buttons[7].pressed)) ||
        gp.buttons[0]?.pressed
      );
      if (isShootPressed && !prevGamepadButtonsRef.current.shoot) {
        shoot();
      }
      prevGamepadButtonsRef.current.shoot = isShootPressed;

      // X button (buttons[2]?.pressed): Reload once per press
      const isReloadPressed = Boolean(gp.buttons[2]?.pressed);
      if (isReloadPressed && !prevGamepadButtonsRef.current.reload) {
        reload();
      }
      prevGamepadButtonsRef.current.reload = isReloadPressed;

      // Menu / Start button (buttons[9]?.pressed): Toggle pause (PLAYING <-> PAUSED) once per press
      const isPausePressed = Boolean(gp.buttons[9]?.pressed);
      if (isPausePressed && !prevGamepadButtonsRef.current.pause) {
        if (gameStateRef.current.status === 'PLAYING') {
          setGameState((prev) => ({...prev, status: 'PAUSED'}));
        } else if (gameStateRef.current.status === 'PAUSED') {
          setGameState((prev) => ({...prev, status: 'PLAYING'}));
        }
      }
      prevGamepadButtonsRef.current.pause = isPausePressed;

      // 3. Additive Right Stick Look (Axes 2 & 3)
      if (['PLAYING', 'VICTORY'].includes(gameState.status) && !isGameMenuOpen) {
        const rx = gp.axes[2] ?? 0;
        const ry = gp.axes[3] ?? 0;
        if (Math.hypot(rx, ry) > 0.15) {
          const lookSpeed = 2.4 * dt;
          cameraEuler.current.y -= rx * lookSpeed;
          cameraEuler.current.x -= ry * lookSpeed;
          const maxPitch = THREE.MathUtils.degToRad(88);
          cameraEuler.current.x = Math.max(-maxPitch, Math.min(maxPitch, cameraEuler.current.x));
        }
      }
    } else {
      prevGamepadButtonsRef.current.shoot = false;
      prevGamepadButtonsRef.current.reload = false;
      prevGamepadButtonsRef.current.pause = false;
    }

    const isConfirm = inputRef.current?.actions?.confirm;
    if (isConfirm && !wasShootingRef.current) {
      shoot();
    }
    wasShootingRef.current = Boolean(isConfirm);

    if (inputRef.current?.actions?.cancel) {
      if (['PLAYING', 'VICTORY'].includes(gameStateRef.current.status)) {
        setGameState((prev) => ({...prev, status: 'PAUSED'}));
      }
    }

    camera.quaternion.setFromEuler(cameraEuler.current);

    vForward.set(0, 0, -1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, cameraEuler.current.y);
    vRight.set(1, 0, 0).applyAxisAngle(THREE.Object3D.DEFAULT_UP, cameraEuler.current.y);

    vMove.set(0, 0, 0);
    const actions = inputRef.current?.actions;
    const analog = inputRef.current?.analogMove;

    if (['PLAYING', 'VICTORY'].includes(gameState.status) && !isGameMenuOpen) {
      if (actions?.up) vMove.add(vForward);
      if (actions?.down) vMove.sub(vForward);
      if (actions?.right) vMove.add(vRight);
      if (actions?.left) vMove.sub(vRight);

      if (analog && Math.hypot(analog.x, analog.y) > 0.05) {
        vMove.addScaledVector(vRight, analog.x);
        vMove.addScaledVector(vForward, -analog.y);
      }

      // 2. Additive Left Stick Movement (Axes 0 & 1)
      if (gp && gp.connected) {
        const lx = gp.axes[0] ?? 0;
        const ly = gp.axes[1] ?? 0;
        if (Math.hypot(lx, ly) > 0.15) {
          vMove.addScaledVector(vRight, lx);
          vMove.addScaledVector(vForward, -ly);
        }
      }
    }

    if (vMove.lengthSq() > 1e-4) {
      vMove.normalize();
      footstepTimerRef.current += dt;
      if (footstepTimerRef.current >= 0.38) {
        footstepTimerRef.current = 0;
        gameAudio.playFootstepStone();
      }
    } else {
      footstepTimerRef.current = 0.3;
    }

    const speed = getConfig('playerSpeed');
    const currentVel = body.linvel();
    body.setLinvel(
      {
        x: vMove.x * speed,
        y: currentVel.y,
        z: vMove.z * speed,
      },
      true,
    );

    const t = body.translation();
    camera.position.set(t.x, t.y + getConfig('cameraY'), t.z);

    // Update Spark Particles
    const sparks = sparksRef.current;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i];
      sp.life -= dt;
      sp.vel.y -= 9.8 * dt;
      sp.pos.addScaledVector(sp.vel, dt);
      if (sp.life <= 0) {
        sparks.splice(i, 1);
      }
    }

    if (sparksInstancedRef.current) {
      const inst = sparksInstancedRef.current;
      for (let i = 0; i < 40; i++) {
        if (i < sparks.length) {
          const sp = sparks[i];
          sparkDummy.position.copy(sp.pos);
          const sc = (sp.life / sp.maxLife) * 0.08;
          sparkDummy.scale.set(sc, sc, sc);
          sparkDummy.updateMatrix();
          inst.setMatrixAt(i, sparkDummy.matrix);
        } else {
          sparkDummy.position.set(0, -999, 0);
          sparkDummy.updateMatrix();
          inst.setMatrixAt(i, sparkDummy.matrix);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
    }

    // Update Enemy Gunfire Tracers
    const tracers = enemyTracersRef.current;
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      const step = tr.speed * dt;
      tr.pos.addScaledVector(tr.dir, step);
      tr.dist += step;

      // Check for ground impact or maximum range
      if (tr.pos.y <= 0.05 || tr.dist >= tr.maxDist) {
        // Spawn small ground impact sparks
        vImpactScratch.copy(tr.pos);
        vImpactScratch.y = Math.max(0.05, vImpactScratch.y);
        for (let s = 0; s < 4; s++) {
          vSparksVelScratch.set(
            (Math.random() - 0.5) * 3,
            Math.random() * 2.5 + 0.5,
            (Math.random() - 0.5) * 3
          );
          enemySparksRef.current.push({
            pos: [vImpactScratch.x, vImpactScratch.y, vImpactScratch.z],
            vel: [vSparksVelScratch.x, vSparksVelScratch.y, vSparksVelScratch.z],
            life: 0.22,
            maxLife: 0.22,
          });
        }
        tracers.splice(i, 1);
      }
    }

    // Render Enemy Tracers via InstancedMesh
    if (enemyTracersInstancedRef.current) {
      const inst = enemyTracersInstancedRef.current;
      for (let i = 0; i < 20; i++) {
        if (i < tracers.length) {
          const tr = tracers[i];
          tracerDummy.position.copy(tr.pos);
          // Align Z-aligned box geometry along movement direction
          vLookAtScratch.copy(tr.pos).add(tr.dir);
          tracerDummy.lookAt(vLookAtScratch);
          tracerDummy.scale.set(1, 1, 1.5);
          tracerDummy.updateMatrix();
          inst.setMatrixAt(i, tracerDummy.matrix);
        } else {
          tracerDummy.position.set(0, -999, 0);
          tracerDummy.updateMatrix();
          inst.setMatrixAt(i, tracerDummy.matrix);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
    }

    // Update Enemy Impact Sparks
    const eSparks = enemySparksRef.current;
    for (let i = eSparks.length - 1; i >= 0; i--) {
      const sp = eSparks[i];
      sp.life -= dt;
      sp.vel[1] -= 9.8 * dt;
      sp.pos[0] += sp.vel[0] * dt;
      sp.pos[1] += sp.vel[1] * dt;
      sp.pos[2] += sp.vel[2] * dt;
      if (sp.life <= 0) {
        eSparks.splice(i, 1);
      }
    }

    if (enemySparksInstancedRef.current) {
      const inst = enemySparksInstancedRef.current;
      for (let i = 0; i < 30; i++) {
        if (i < eSparks.length) {
          const sp = eSparks[i];
          enemySparkDummy.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
          const sc = (sp.life / sp.maxLife) * 0.025;
          enemySparkDummy.scale.set(sc, sc, sc);
          enemySparkDummy.updateMatrix();
          inst.setMatrixAt(i, enemySparkDummy.matrix);
        } else {
          enemySparkDummy.position.set(0, -999, 0);
          enemySparkDummy.updateMatrix();
          inst.setMatrixAt(i, enemySparkDummy.matrix);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group>
      <RigidBody
        ref={playerBodyRef}
        colliders={false}
        mass={1}
        type="dynamic"
        position={[0, 0, 10]}
        lockRotations>
        <CapsuleCollider args={[0.7, 0.45]} position={[0, 1.1, 0]} friction={0} />
      </RigidBody>

      <primitive object={camera}>
        <FPSWeapon recoilRef={recoilRef} muzzleFlashRef={muzzleFlashRef} />
      </primitive>

      <SeamlessBreachEnvironment />

      <OutdoorSkyDome />

      {/* Targets with debug report for Target 1 */}
      {targetsRef.current.map((tgt) => (
        <TacticalTarget
          key={tgt.id}
          target={tgt}
          targetMeshRef={(el) => {
            if (el) targetGroupMap.current.set(tgt.id, el);
          }}
          testAnim={testAnim}
          onDebugReport={tgt.id === 1 ? onUpdateDebug : undefined}
          onEnemyFire={handleEnemyFire}
        />
      ))}

      <instancedMesh
        ref={sparksInstancedRef}
        args={[undefined, undefined, 40]}
        frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 8]} />
        <meshBasicMaterial color="#ffcc33" />
      </instancedMesh>

      {/* Enemy Tracers: thin, fast, glowing streaks */}
      <instancedMesh
        ref={enemyTracersInstancedRef}
        args={[undefined, undefined, 20]}
        frustumCulled={false}>
        <boxGeometry args={[0.008, 0.008, 1]} />
        <meshBasicMaterial
          color="#efe2cc"
          transparent
          opacity={0.6}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>

      {/* Enemy Impact Sparks */}
      <instancedMesh
        ref={enemySparksInstancedRef}
        args={[undefined, undefined, 30]}
        frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 8]} />
        <meshBasicMaterial
          color="#8a7963"
          blending={THREE.NormalBlending}
        />
      </instancedMesh>
    </group>
  );
}

/**
 * Main Game Viewport Wrapper
 */
export function Game({
  gameState,
  setGameState,
  exitChat,
  gameStateRef,
  externalInputRef,
  ammo,
  setAmmo,
  setIsLocked,
  showHitMarker,
  triggerHitMarker,
  isGameMenuOpen,
  testAnim = 'shoot',
  onUpdateDebug,
}: {
  gameState: GameState;
  setGameState: React.Dispatch<React.SetStateAction<GameState>>;
  exitChat: (payload: Record<string, unknown>) => Promise<void>;
  gameStateRef: React.MutableRefObject<GameState>;
  externalInputRef?: React.MutableRefObject<InputSnapshot>;
  ammo: {mag: number; reserve: number};
  setAmmo: React.Dispatch<React.SetStateAction<{mag: number; reserve: number}>>;
  setIsLocked: (locked: boolean) => void;
  showHitMarker: boolean;
  triggerHitMarker: () => void;
  isGameMenuOpen: boolean;
  testAnim?: 'idle' | 'shoot' | 'fall';
  onUpdateDebug?: (info: Partial<SoldierDebugInfo>) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useInput(containerRef, {enabled: true, externalInputRef});

  return (
    <div ref={containerRef} className="w-full h-full canvas-wrapper relative">
      <Canvas
        shadows
        dpr={[1, 1.5]}
        camera={{
          fov: getConfig('fov'),
          near: 0.1,
          far: 1000,
          position: [0, 1.7, 10],
        }}
        scene={{
          background: new THREE.Color(getConfig('backgroundColor')),
          fog: new THREE.FogExp2(getConfig('backgroundColor'), 0.038),
        }}>
        <Suspense fallback={null}>
          <ambientLight
            color={getConfig('ambientColor')}
            intensity={getConfig('ambientIntensity')}
          />
          <directionalLight
            position={[25, 45, 18]}
            intensity={getConfig('sunIntensity')}
            color={getConfig('sunColor')}
            castShadow
            shadow-mapSize={[1024, 1024]}
            shadow-camera-left={-60}
            shadow-camera-right={60}
            shadow-camera-top={60}
            shadow-camera-bottom={-60}
            shadow-bias={-0.0004}
          />
          <hemisphereLight
            color={getConfig('hemiSkyColor')}
            groundColor={getConfig('hemiGroundColor')}
            intensity={getConfig('hemiIntensity')}
          />

          <Physics gravity={[0, getConfig('gravity'), 0]} paused={isGameMenuOpen}>
            <FPSScene
              gameState={gameState}
              setGameState={setGameState}
              inputRef={inputRef}
              exitChat={exitChat}
              gameStateRef={gameStateRef}
              ammo={ammo}
              setAmmo={setAmmo}
              setIsLocked={setIsLocked}
              showHitMarker={showHitMarker}
              triggerHitMarker={triggerHitMarker}
              isGameMenuOpen={isGameMenuOpen}
              testAnim={testAnim}
              onUpdateDebug={onUpdateDebug}
            />
          </Physics>

          <EffectComposer>
            <Bloom
              luminanceThreshold={0.85}
              luminanceSmoothing={0.3}
              intensity={0.4}
              mipmapBlur
            />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}

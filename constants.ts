import {MusicTrack} from './utils/helper';

/** Game configuration schema. */
export const CONFIG = {
  // --- Game ---
  title: {
    value: 'Tactical Breach',
    type: 'string',
    label: 'Game Title',
    group: 'Game',
  },

  // --- Camera ---
  fov: {
    value: 75,
    type: 'number',
    label: 'Field of View',
    group: 'Camera',
    min: 50,
    max: 100,
    step: 5,
  },
  cameraX: {
    value: 0,
    type: 'number',
    label: 'Camera X',
    group: 'Camera',
  },
  cameraY: {
    value: 1.7,
    type: 'number',
    label: 'Camera Y',
    group: 'Camera',
  },
  cameraZ: {
    value: 0,
    type: 'number',
    label: 'Camera Z',
    group: 'Camera',
  },

  // --- Visuals: Classic 2000s Ochre Desert Range & CQB Killhouse ---
  backgroundColor: {
    value: '#ba9d75', // Exact desaturated ochre dust color
    type: 'color',
    label: 'Background Color',
    group: 'Visuals',
  },
  ambientColor: {
    value: '#5c5243',
    type: 'color',
    label: 'Ambient Light Color',
    group: 'Visuals',
  },
  ambientIntensity: {
    value: 2.0,
    type: 'number',
    label: 'Ambient Intensity',
    group: 'Visuals',
    min: 0.5,
    max: 5,
    step: 0.1,
  },
  sunColor: {
    value: '#ffd699', // Warm golden/ochre sunlight
    type: 'color',
    label: 'Sun Color',
    group: 'Visuals',
  },
  sunIntensity: {
    value: 3.4,
    type: 'number',
    label: 'Sun Intensity',
    group: 'Visuals',
    min: 1,
    max: 10,
    step: 0.1,
  },
  hemiSkyColor: {
    value: '#94a9ba', // Pale dusty sky tone
    type: 'color',
    label: 'Hemisphere Sky Color',
    group: 'Visuals',
  },
  hemiGroundColor: {
    value: '#9e8156', // Warm ochre ground bounce
    type: 'color',
    label: 'Hemisphere Ground Color',
    group: 'Visuals',
  },
  hemiIntensity: {
    value: 1.5,
    type: 'number',
    label: 'Hemisphere Intensity',
    group: 'Visuals',
    min: 0.2,
    max: 3,
    step: 0.1,
  },

  // --- Physics & Locomotion ---
  gravity: {
    value: -9.81,
    type: 'number',
    label: 'Gravity',
    group: 'Physics',
    min: -30,
    max: 0,
    step: 0.5,
  },
  playerSpeed: {
    value: 7.0,
    type: 'number',
    label: 'Player Speed',
    group: 'Physics',
    min: 3,
    max: 14,
    step: 0.5,
  },
  mouseSensitivity: {
    value: 1.0,
    type: 'number',
    label: 'Mouse Sensitivity',
    group: 'Physics',
    min: 0.2,
    max: 3.0,
    step: 0.1,
  },

  // --- Tactical Shooting Rules ---
  magCapacity: {
    value: 15,
    type: 'number',
    label: 'Magazine Capacity',
    group: 'Rules',
    min: 5,
    max: 40,
    step: 1,
  },
  startingAmmo: {
    value: 60,
    type: 'number',
    label: 'Starting Ammo Reserves',
    group: 'Rules',
    min: 15,
    max: 120,
    step: 5,
  },
  recoilImpulse: {
    value: 0.08,
    type: 'number',
    label: 'Gun Recoil Impulse',
    group: 'Rules',
    min: 0.02,
    max: 0.2,
    step: 0.01,
  },

  // --- System ---
  targetFPS: {
    value: 60,
    type: 'number',
    label: 'Target FPS',
    group: 'System',
  },
  stepMs: {
    value: 1000 / 60,
    type: 'number',
    label: 'Step MS',
    group: 'System',
  },
  maxSubSteps: {
    value: 5,
    type: 'number',
    label: 'Max Sub Steps',
    group: 'System',
  },

  // --- Audio ---
  backgroundMusicUrl: {
    value: '',
    type: 'string',
    label: 'Background Music URL',
    group: 'Audio',
  },
};

// Merge customized config values if present (injected by Playground)
const {playgroundConfig} = globalThis as {
  playgroundConfig?: Record<string, unknown>;
};
if (playgroundConfig) {
  for (const [key, value] of Object.entries(playgroundConfig)) {
    if (key in CONFIG) {
      Object.assign(CONFIG[key as keyof typeof CONFIG], {value});
    }
  }
}

/** Type helper for reading values in game code. */
export type ConfigKey = keyof typeof CONFIG;

/**
 * Gets a configuration value by key.
 * @param key The configuration key.
 * @return The configuration value.
 */
export function getConfig<K extends ConfigKey>(
  key: K,
): (typeof CONFIG)[K]['value'] {
  return CONFIG[key].value;
}

/** Optional presets for the game. */
export const PRESETS = {};

/** Background music tracks available for the game to use. */
export const AVAILABLE_MUSIC_TRACKS: readonly MusicTrack[] = [];

import {useEffect, useRef, type MutableRefObject, type RefObject} from 'react';

/** Actions that can be triggered by the user. */
export type InputAction =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'confirm'
  | 'cancel'
  | 'tap';

/** Represents the state of the pointer (mouse/touch). */
export interface PointerState {
  /** Pointer position in NDC (-1..1) for raycasting. */
  nx: number;
  ny: number;
  /** Pointer position in client pixels (relative to container). */
  clientX: number;
  clientY: number;
  down: boolean;
}

/** Snapshot of the input state at a given frame. */
export interface InputSnapshot {
  actions: Record<InputAction, boolean>;
  pointer: PointerState;
  /** Normalized analog movement vector (-1..1 on x and y; +y is down/backward). */
  analogMove?: {x: number; y: number};
}

const ACTION_KEYS: Record<string, InputAction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
  Enter: 'confirm',
  ' ': 'confirm',
  Escape: 'cancel',
};

function createEmptyActions(): Record<InputAction, boolean> {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    confirm: false,
    cancel: false,
    tap: false,
  };
}

/** Creates a fresh, zeroed InputSnapshot for 3D games and mobile overlays. */
export function createInitialInputSnapshot(): InputSnapshot {
  return {
    actions: createEmptyActions(),
    pointer: {nx: 0, ny: 0, clientX: 0, clientY: 0, down: false},
    analogMove: {x: 0, y: 0},
  };
}

/**
 * Converts a pointer event on the renderer container to NDC coordinates (-1..1).
 * These can be passed directly to raycastGround() or Raycaster.setFromCamera().
 */
function getPointerNDC(
  event: PointerEvent,
  container: HTMLElement,
): {nx: number; ny: number; clientX: number; clientY: number} {
  const rect = container.getBoundingClientRect();
  const width = rect.width || 1;
  const height = rect.height || 1;
  const clientX = event.clientX - rect.left;
  const clientY = event.clientY - rect.top;
  const nx = (clientX / width) * 2 - 1;
  const ny = -(clientY / height) * 2 + 1;
  return {nx, ny, clientX, clientY};
}

/**
 * Unified input hook for 3D games.
 *
 * pointer.nx / pointer.ny are in NDC (-1..1) — ready for raycasting.
 * Keyboard and multi-touch pointer inputs are handled, and an optional
 * externalInputRef allows HUD touch overlays (e.g. virtual joystick) to feed
 * analogMove and action buttons into the same snapshot.
 *
 * Works both with the R3F Canvas container and standalone divs.
 *
 * @param containerRef — ref to the div wrapping the Canvas / renderer
 * @param options — configuration options (enabled: disable input when game is paused / in menus)
 */
export function useInput(
  containerRef: RefObject<HTMLDivElement>,
  options: {
    enabled?: boolean;
    externalInputRef?: MutableRefObject<InputSnapshot>;
  } = {},
): MutableRefObject<InputSnapshot> {
  const {enabled = true, externalInputRef} = options;
  const internalInputRef = useRef<InputSnapshot>(createInitialInputSnapshot());
  const inputRef = externalInputRef ?? internalInputRef;

  useEffect(() => {
    if (!enabled) {
      Object.assign(inputRef.current, createInitialInputSnapshot());
      return;
    }

    const activePointers = new Map<
      number,
      {nx: number; ny: number; clientX: number; clientY: number}
    >();

    const handleKeyDown = (event: KeyboardEvent) => {
      const action = ACTION_KEYS[event.key];
      if (!action) return;
      inputRef.current.actions[action] = true;
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const action = ACTION_KEYS[event.key];
      if (!action) return;
      inputRef.current.actions[action] = false;
    };

    const container = containerRef.current;
    const handlePointerDown = (event: PointerEvent) => {
      if (!container) return;
      const pos = getPointerNDC(event, container);
      activePointers.set(event.pointerId, pos);
      inputRef.current.pointer = {...pos, down: true};
      inputRef.current.actions.tap = true;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!container) return;
      const pos = getPointerNDC(event, container);
      if (activePointers.has(event.pointerId)) {
        activePointers.set(event.pointerId, pos);
      }
      inputRef.current.pointer = {...pos, down: activePointers.size > 0};
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!container) return;
      activePointers.delete(event.pointerId);
      inputRef.current.actions.tap = false;
      if (activePointers.size > 0) {
        const latestPos = Array.from(activePointers.values()).pop();
        if (latestPos) {
          inputRef.current.pointer = {...latestPos, down: true};
        }
      } else {
        const pos = getPointerNDC(event, container);
        inputRef.current.pointer = {...pos, down: false};
      }
    };

    const handleBlur = () => {
      activePointers.clear();
      Object.assign(inputRef.current, createInitialInputSnapshot());
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleBlur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (container) {
      container.addEventListener('pointerdown', handlePointerDown);
      container.addEventListener('pointermove', handlePointerMove);
      container.addEventListener('pointerup', handlePointerUp);
      container.addEventListener('pointercancel', handlePointerUp);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      if (container) {
        container.removeEventListener('pointerdown', handlePointerDown);
        container.removeEventListener('pointermove', handlePointerMove);
        container.removeEventListener('pointerup', handlePointerUp);
        container.removeEventListener('pointercancel', handlePointerUp);
      }
    };
  }, [containerRef, enabled, inputRef]);

  return inputRef;
}

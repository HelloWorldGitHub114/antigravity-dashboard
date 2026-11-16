import type { UpdatePluginState, UpdateProgress } from '../../contracts/ipc.ts';
import { setAttr, setText } from '../../shared/dom.ts';
import type { UpdateCopy } from './copy.ts';

const COMPLETE_STATES = new Set(['current', 'available', 'installed']);
const ACTIVE_STATES = new Set(['checking', 'installing', 'reloading']);
const CHECKMARK_PATH = 'M4.5 10l3.5 3.5 7.5-7.5';
const REFRESH_PATH = 'M15.7 8a6 6 0 1 0-.2 4.5M16 3.5V8h-4.5';
const BYTES_PER_MIB = 1048576;

export interface ProgressElements {
  dialog: HTMLDialogElement;
  icon: HTMLElement;
  symbol: SVGPathElement;
  label: HTMLElement;
  value: HTMLElement;
  track: HTMLElement;
  fill: HTMLElement;
}

export interface ProgressController {
  render(state: UpdatePluginState, copy: UpdateCopy): void;
  dispose(): void;
}

function isKnownDownload(state: UpdatePluginState, progress: Partial<UpdateProgress>): boolean {
  return (
    state.state === 'installing' &&
    progress.phase === 'download' &&
    typeof progress.total === 'number' &&
    Number.isSafeInteger(progress.total) &&
    progress.total > 0 &&
    typeof progress.received === 'number' &&
    Number.isSafeInteger(progress.received) &&
    progress.received >= 0 &&
    progress.received <= progress.total
  );
}

function resolveProgressLabel(state: UpdatePluginState, copy: UpdateCopy): string {
  if (state.state === 'checking') return copy.phases.check;
  if (state.state === 'current') return copy.checkComplete;
  if (state.state === 'available') return copy.readyToUpdate;
  if (state.state === 'installed') return copy.phases.complete;
  if (state.state === 'reloading') return copy.reloadingPlugin;
  if (state.state === 'error') return copy.notCompleted;
  const phase = state.progress?.phase;
  return (phase && copy.phases[phase]) || copy.working;
}

export function createProgressController(elements: ProgressElements): ProgressController {
  const { dialog, icon, symbol, label: labelEl, value: valueEl, track, fill } = elements;
  let disposed = false;
  let meterPhase: string | null = null;
  let meterFrame: number | null = null;
  let meterRestoreFrame: number | null = null;

  function clearFrames(): void {
    if (meterFrame !== null) {
      cancelAnimationFrame(meterFrame);
      meterFrame = null;
    }
    if (meterRestoreFrame !== null) {
      cancelAnimationFrame(meterRestoreFrame);
      meterRestoreFrame = null;
    }
  }

  function render(state: UpdatePluginState, copy: UpdateCopy): void {
    const progress: Partial<UpdateProgress> = state.progress ?? {};
    const phase = progress.phase;
    const complete = COMPLETE_STATES.has(state.state);
    const active = ACTIVE_STATES.has(state.state);
    const known = isKnownDownload(state, progress);
    const fraction = known
      ? (progress.received as number) / (progress.total as number)
      : complete
        ? 1
        : null;

    const nextMeterPhase = `${state.state}:${known ? 'download' : phase || 'unknown'}`;
    if (meterPhase !== nextMeterPhase) {
      meterPhase = nextMeterPhase;
      clearFrames();
      // A finished check is a different task from a fresh download. Do not
      // animate its 100% backwards into the new download's measured fraction.
      fill.style.transition = 'none';
      meterFrame = requestAnimationFrame(() => {
        meterRestoreFrame = requestAnimationFrame(() => {
          if (!disposed) fill.style.removeProperty('transition');
        });
      });
    }

    const label = resolveProgressLabel(state, copy);
    setText(labelEl, label);
    setText(
      valueEl,
      known && fraction !== null
        ? `${((progress.received as number) / BYTES_PER_MIB).toFixed(1)} / ${((progress.total as number) / BYTES_PER_MIB).toFixed(1)} MB · ${Math.floor(fraction * 100)}%`
        : complete
          ? '100%'
          : '',
    );

    dialog.dataset.progress =
      state.state === 'error' ? 'error' : fraction === null ? 'unknown' : 'known';
    setAttr(track, 'aria-label', label);
    if (fraction !== null) {
      setAttr(track, 'aria-valuenow', Math.floor(fraction * 100));
      fill.style.transform = `scaleX(${fraction})`;
    } else {
      setAttr(track, 'aria-valuenow', null);
      fill.style.removeProperty('transform');
    }

    icon.dataset.busy = String(active);
    icon.dataset.complete = String(complete);
    setAttr(symbol, 'd', complete ? CHECKMARK_PATH : REFRESH_PATH);
  }

  return {
    render,
    dispose() {
      disposed = true;
      clearFrames();
    },
  };
}

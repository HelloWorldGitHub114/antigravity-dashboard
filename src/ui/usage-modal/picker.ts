import { createDomNode } from './dom-shell.ts';

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PopoverListboxOptions {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  labelEl: HTMLElement;
  dialog: HTMLDialogElement;
  view: ShadowRoot;
  setMarkup: (element: Element | ShadowRoot, markup: string) => void;
  getSelected: () => string;
  onSelect: (value: string) => void;
  placeholder?: () => string;
}

export interface PopoverListboxHandle {
  setOptions(options: readonly PickerOption[], menuLabel?: string): void;
  sync(): void;
  open(): void;
  close(restore?: boolean): void;
  isOpen(): boolean;
  position(): void;
  dispose(): void;
}

const CHECK_SVG =
  '<span></span><span class="picker-hint"></span><svg class="picker-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';

/**
 * Shared accessible popover listbox controller used by the usage modal's
 * dimension selector, model-view selector, and project-detail selector.
 */
export function createPopoverListbox(opts: PopoverListboxOptions): PopoverListboxHandle {
  const { trigger, menu, labelEl, dialog, view, setMarkup, getSelected, onSelect } = opts;
  let currentOptions: PickerOption[] = [];

  const isOpen = (): boolean => menu.matches(':popover-open');

  const position = (): void => {
    if (!isOpen()) return;
    const r = trigger.getBoundingClientRect();
    const bounds = dialog.getBoundingClientRect();
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 120;
    menu.style.left = `${Math.max(bounds.left + 12, Math.min(r.left, bounds.right - width - 12))}px`;
    const below = r.bottom + 6;
    menu.style.top = `${below + height <= bounds.bottom - 12 ? below : Math.max(bounds.top + 12, r.top - height - 6)}px`;
  };

  const close = (restore = true): void => {
    if (!isOpen()) return;
    menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (restore) trigger.focus({ preventScroll: true });
  };

  const sync = (): void => {
    const selected = getSelected();
    const matched = currentOptions.find((o) => o.value === selected);
    const labelText = matched?.label ?? opts.placeholder?.() ?? selected;
    if (labelEl.textContent !== labelText) labelEl.textContent = labelText;
    for (const child of menu.children) {
      const btn = child as HTMLElement;
      btn.setAttribute('aria-selected', String(btn.dataset.value === selected));
    }
  };

  const open = (): void => {
    menu.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    position();
    ((menu.querySelector('[aria-selected=true]') || menu.firstElementChild) as HTMLElement | null)?.focus({
      preventScroll: true,
    });
  };

  const setOptions = (options: readonly PickerOption[], menuLabel?: string): void => {
    currentOptions = [...options];
    if (menuLabel) menu.setAttribute('aria-label', menuLabel);
    const sig = currentOptions.map((o) => `${o.value}\t${o.label}\t${o.hint || ''}`).join('\n');
    if (menu.dataset.sig !== sig) {
      menu.dataset.sig = sig;
      menu.replaceChildren(
        ...currentOptions.map((item) => {
          const btn = createDomNode('button', 'picker-option');
          btn.type = 'button';
          btn.dataset.value = item.value;
          btn.setAttribute('role', 'option');
          btn.tabIndex = -1;
          setMarkup(btn, CHECK_SVG);
          const spans = btn.querySelectorAll('span');
          spans[0].textContent = item.label;
          if (item.hint) spans[1].textContent = item.hint;
          else spans[1].remove();
          return btn;
        }),
      );
    }
    sync();
  };

  const onTriggerClick = (): void => {
    if (isOpen()) close(false);
    else open();
  };

  const onTriggerKeyDown = (e: KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (!isOpen()) open();
  };

  const onMenuClick = (e: MouseEvent): void => {
    const opt = (e.target as Element | null)?.closest<HTMLElement>('.picker-option');
    if (!opt || opt.dataset.value == null) return;
    const next = opt.dataset.value;
    close();
    if (next !== getSelected()) {
      onSelect(next);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent): void => {
    const options = [...menu.querySelectorAll<HTMLElement>('.picker-option')];
    const index = options.indexOf(view.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      options[(Math.max(index, 0) + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus({
        preventScroll: true,
      });
    } else if (e.key === 'Home') {
      e.preventDefault();
      options[0]?.focus({ preventScroll: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      options.at(-1)?.focus({ preventScroll: true });
    }
  };

  const onDocPointerDown = (e: PointerEvent): void => {
    if (!isOpen()) return;
    const path = e.composedPath();
    if (path.includes(menu) || path.includes(trigger)) return;
    close(false);
  };

  trigger.addEventListener('click', onTriggerClick);
  trigger.addEventListener('keydown', onTriggerKeyDown);
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onMenuKeyDown);
  document.addEventListener('pointerdown', onDocPointerDown, true);

  return {
    setOptions,
    sync,
    open,
    close,
    isOpen,
    position,
    dispose: () => {
      close(false);
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKeyDown);
      menu.removeEventListener('click', onMenuClick);
      menu.removeEventListener('keydown', onMenuKeyDown);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    },
  };
}

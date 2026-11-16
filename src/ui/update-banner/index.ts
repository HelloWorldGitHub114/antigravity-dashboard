import type { UpdateAction, UpdatePluginRequest, UpdatePluginState } from '../../contracts/ipc.ts';
import { createEl, setAttr, setMarkup as defaultSetMarkup, setText } from '../../shared/dom.ts';
import { formatReleaseNotes, getUpdateCopy } from './copy.ts';
import { createProgressController } from './progress.ts';
import updateCss from './update.css';

export interface UpdateMenuLanguage {
  language: string;
}

export interface UpdateMenuOptions {
  root: ShadowRoot | HTMLElement | DocumentFragment;
  row: Element;
  language: UpdateMenuLanguage;
  setMarkup?: (element: Element, markup: string) => void;
  request: (input: UpdatePluginRequest) => Promise<UpdatePluginState>;
  onOpen?: () => void;
}

export interface UpdateMenuController {
  localize(): void;
  open(): void;
  dispose(): void;
}

const ACTIONABLE_STATES = new Set(['available', 'installed', 'error']);
const BUSY_STATES = new Set(['checking', 'installing', 'reloading']);

const MENU_MARKUP =
  '<button type="button" id="check-update" role="menuitem"><span></span>' +
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 6a5 5 0 1 0 0 4M12 2v4H8"/></svg></button>';

const DIALOG_MARKUP =
  '<header><strong id="update-title"></strong><button id="update-close" type="button">' +
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></header>' +
  '<div class="update-status"><span id="update-icon" aria-hidden="true">' +
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path id="update-symbol" d="M15.7 8a6 6 0 1 0-.2 4.5M16 3.5V8h-4.5"/></svg>' +
  '</span><strong id="update-status"></strong></div>' +
  '<div class="update-progress"><div class="update-progress-caption">' +
  '<span id="update-progress-label"></span><span id="update-progress-value"></span></div>' +
  '<div id="update-progress-track" class="update-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">' +
  '<i id="update-progress-fill"></i><i class="update-progress-sheen"></i></div></div>' +
  '<dl><div><dt id="update-current-label"></dt><dd id="update-current"></dd></div>' +
  '<div><dt id="update-latest-label"></dt><dd id="update-latest"></dd></div>' +
  '<div><dt id="update-host-label"></dt><dd>Antigravity App</dd></div></dl>' +
  '<section id="update-notes-wrap" hidden><h2 id="update-notes-label"></h2><p id="update-notes"></p></section>' +
  '<footer><span id="update-feedback" role="status"></span><button id="update-action" type="button" hidden></button></footer>';

/**
 * Mounts the plugin update menu button, dropdown menu, and modal dialog.
 */
export default function createUpdateMenu({
  root,
  row,
  language,
  setMarkup = defaultSetMarkup,
  request,
  onOpen,
}: UpdateMenuOptions): UpdateMenuController {
  const button = createEl('button', {
    type: 'button',
    class: 'update-menu-button',
    id: 'plugin-menu-button',
    text: '⋯',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  });
  row.append(button);

  const menu = createEl('div', {
    class: 'update-menu',
    id: 'plugin-menu',
    role: 'menu',
  });
  menu.hidden = true;
  setMarkup(menu, MENU_MARKUP);
  row.append(menu);

  const dialog = createEl('dialog', {
    id: 'plugin-update-dialog',
    class: 'update-dialog',
  });
  setMarkup(dialog, DIALOG_MARKUP);
  root.append(dialog);

  const css = createEl('style');
  css.textContent = updateCss;
  root.append(css);

  const query = <T extends Element>(id: string): T => dialog.querySelector<T>(`#${id}`)!;
  const checkButton = menu.querySelector<HTMLButtonElement>('#check-update')!;
  const checkLabel = checkButton.querySelector('span')!;
  const titleEl = query<HTMLElement>('update-title');
  const closeButton = query<HTMLButtonElement>('update-close');
  const statusEl = query<HTMLElement>('update-status');
  const currentLabelEl = query<HTMLElement>('update-current-label');
  const currentEl = query<HTMLElement>('update-current');
  const latestLabelEl = query<HTMLElement>('update-latest-label');
  const latestEl = query<HTMLElement>('update-latest');
  const hostLabelEl = query<HTMLElement>('update-host-label');
  const notesWrapEl = query<HTMLElement>('update-notes-wrap');
  const notesLabelEl = query<HTMLElement>('update-notes-label');
  const notesEl = query<HTMLElement>('update-notes');
  const feedbackEl = query<HTMLElement>('update-feedback');
  const actionButton = query<HTMLButtonElement>('update-action');

  const progress = createProgressController({
    dialog,
    icon: query<HTMLElement>('update-icon'),
    symbol: query<SVGPathElement>('update-symbol'),
    label: query<HTMLElement>('update-progress-label'),
    value: query<HTMLElement>('update-progress-value'),
    track: query<HTMLElement>('update-progress-track'),
    fill: query<HTMLElement>('update-progress-fill'),
  });

  let state: UpdatePluginState = { state: 'idle', host: 'app', currentVersion: null };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let epoch = 0;
  let busy = false;
  let lastRender = '';

  function closeMenu(): void {
    menu.hidden = true;
    setAttr(button, 'aria-expanded', 'false');
  }

  function render(): void {
    const signature = JSON.stringify([language.language, state, busy]);
    if (signature === lastRender) return;
    lastRender = signature;

    const copy = getUpdateCopy(language.language);
    setAttr(button, 'aria-label', copy.pluginMenu);
    button.title = copy.pluginMenu;
    setText(checkLabel, copy.checkUpdates);
    setText(titleEl, copy.title);
    setAttr(closeButton, 'aria-label', copy.close);

    setText(statusEl, copy.statuses[state.state] || copy.statuses.error);
    setAttr(dialog, 'aria-busy', String(BUSY_STATES.has(state.state)));
    progress.render(state, copy);

    setText(currentLabelEl, copy.currentVersion);
    setText(latestLabelEl, copy.latestVersion);
    setText(hostLabelEl, copy.installation);
    setText(currentEl, state.currentVersion ? `v${state.currentVersion}` : '—');
    setText(latestEl, state.latestVersion ? `v${state.latestVersion}` : '—');

    notesWrapEl.hidden = state.state !== 'available' || !state.notes;
    setText(notesLabelEl, copy.whatsNew);
    setText(notesEl, formatReleaseNotes(state.notes));

    const feedbackText =
      state.state === 'error'
        ? (state.error && copy.errors[state.error]) || copy.errors.network
        : state.state === 'available'
          ? copy.retained
          : '';
    setText(feedbackEl, feedbackText);

    actionButton.hidden = !ACTIONABLE_STATES.has(state.state);
    actionButton.disabled = busy;
    setText(
      actionButton,
      state.state === 'installed'
        ? copy.reloadPlugin
        : state.state === 'error'
          ? copy.retry
          : copy.update,
    );
  }

  async function call(action: UpdateAction): Promise<void> {
    const ticket = ++epoch;
    busy = true;
    if (action === 'check') {
      state = { ...state, state: 'checking', progress: { phase: 'check' } };
    } else if (action === 'apply') {
      state = { ...state, state: 'installing', progress: { phase: 'verify' } };
    }
    render();

    try {
      const payload: UpdatePluginRequest =
        action === 'apply' ? { action, version: state.latestVersion } : { action };
      const result = await request(payload);
      if (disposed || ticket !== epoch) return;
      if (!result || (result.error && !result.state)) {
        throw new Error('network');
      }
      state = result;
    } catch {
      if (!disposed && ticket === epoch) {
        state = { ...state, state: 'error', error: 'network' };
      }
    } finally {
      if (!disposed && ticket === epoch) {
        busy = false;
        render();
        if (state.state === 'checking' || state.state === 'installing') {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            void call('status');
          }, 800);
        }
      }
    }
  }

  function open(): void {
    if (disposed) return;
    closeMenu();
    onOpen?.();
    if (!dialog.open) dialog.showModal();
    void call('check');
  }

  const onButtonClick = (): void => {
    menu.hidden = !menu.hidden;
    setAttr(button, 'aria-expanded', String(!menu.hidden));
    render();
  };

  const onCheckClick = (): void => {
    open();
  };

  const onCloseClick = (): void => {
    if (dialog.open) dialog.close();
    closeMenu();
  };

  const onActionClick = (): void => {
    const nextAction: UpdateAction =
      state.state === 'installed' ? 'reload' : state.state === 'error' ? 'check' : 'apply';
    void call(nextAction);
  };

  const onRootPointerDown = (event: Event): void => {
    const path = event.composedPath();
    if (!path.includes(menu) && !path.includes(button)) closeMenu();
  };

  const onMenuKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      button.focus();
    }
  };

  button.addEventListener('click', onButtonClick);
  checkButton.addEventListener('click', onCheckClick);
  closeButton.addEventListener('click', onCloseClick);
  actionButton.addEventListener('click', onActionClick);
  root.addEventListener('pointerdown', onRootPointerDown);
  menu.addEventListener('keydown', onMenuKeyDown);

  render();

  return {
    localize: render,
    open,
    dispose() {
      disposed = true;
      epoch++;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      progress.dispose();
      root.removeEventListener('pointerdown', onRootPointerDown);
      if (dialog.open) dialog.close();
      dialog.remove();
      menu.remove();
      button.remove();
      css.remove();
    },
  };
}

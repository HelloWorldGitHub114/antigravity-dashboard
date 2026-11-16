import { cardVisibility, positionCardPopover } from './cards.ts';
import type { LanguageGuideController } from './language-guide.ts';
import type { ComposerMatch } from './types.ts';

const HOVER_DELAY = 250;
const WARM_WINDOW = 350;
const LEAVE_DELAY = 120;

export interface CardControllerDeps {
  getRoot: () => ShadowRoot | null;
  getNode: () => HTMLElement | null;
  getComposer: () => ComposerMatch | null;
  getConversationId: () => string | null;
  isDisposed: () => boolean;
  isUsageOpen: () => boolean;
  guide: LanguageGuideController;
  onChooseLanguage: (choice: 'en' | 'zh-CN') => Promise<void>;
  onRefreshManually: () => Promise<void>;
  onOpenSidebar: () => void;
}

export class CardInteractionController {
  cardName: string | null = null;
  groupMenu: HTMLElement | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private warmUntil = 0;
  private changingCards = false;
  private readonly deps: CardControllerDeps;

  constructor(deps: CardControllerDeps) {
    this.deps = deps;
  }

  get hasOpenGroupMenu(): boolean {
    return Boolean(this.groupMenu);
  }

  private isWarm(): boolean {
    return Boolean(this.cardName || Date.now() < this.warmUntil);
  }

  position(): void {
    positionCardPopover(this.deps.getRoot(), this.cardName);
  }

  closeGroup(): void {
    const root = this.deps.getRoot();
    for (const e of root?.querySelectorAll<HTMLElement>('.group-menu') ?? []) e.hidden = true;
    for (const e of root?.querySelectorAll<HTMLElement>('.group-trigger') ?? []) {
      e.setAttribute('aria-expanded', 'false');
    }
    this.groupMenu = null;
  }

  // Pointer clicks and dialog focus restoration leave buttons focused after
  // the pointer departs. Only keyboard-visible focus keeps a card engaged.
  // The explicit first-use action moves focus into language choices. Keep
  // that guided destination available until the user chooses or leaves it.
  private cardEngaged(): boolean {
    const root = this.deps.getRoot();
    const node = this.deps.getNode();
    return Boolean(
      root?.activeElement?.matches(':focus-visible') ||
        (this.deps.guide.guideOpened &&
          !this.deps.guide.guideDismissed &&
          this.cardName === 'context' &&
          root?.activeElement?.matches('[data-language-choice]')) ||
        this.groupMenu ||
        node?.matches(':hover') ||
        root?.querySelector('.card:not([hidden]):hover'),
    );
  }

  hide({ keepWarm = false }: { keepWarm?: boolean } = {}): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (!keepWarm) this.warmUntil = 0;
    this.changingCards = true;
    try {
      const root = this.deps.getRoot();
      this.closeGroup();
      this.cardName = null;
      for (const e of root?.querySelectorAll<HTMLElement>('[data-card]') ?? []) {
        e.setAttribute('aria-expanded', 'false');
      }
      for (const e of root?.querySelectorAll<HTMLElement>('.card') ?? []) {
        cardVisibility(e, false);
      }
    } finally {
      this.changingCards = false;
    }
    this.deps.guide.update();
  }

  show(name: string): void {
    const node = this.deps.getNode();
    const root = this.deps.getRoot();
    if (
      this.deps.isDisposed() ||
      !node?.isConnected ||
      !root ||
      this.changingCards ||
      this.deps.isUsageOpen() ||
      node.dataset.layout === 'blocked'
    ) {
      return;
    }
    if (this.cardName !== name) this.closeGroup();
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    this.cardName = name;
    this.warmUntil = 0;
    for (const e of root.querySelectorAll<HTMLElement>('[data-card]')) {
      e.setAttribute('aria-expanded', String(e.dataset.card === name));
    }
    this.changingCards = true;
    try {
      for (const e of root.querySelectorAll<HTMLElement>('.card')) {
        cardVisibility(e, e.id === `${name}-card`);
      }
    } finally {
      this.changingCards = false;
    }
    this.deps.guide.update();
    this.position();
  }

  hoverChip(name: string): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.isWarm()) {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      this.show(name);
      return;
    }
    if (this.openTimer) clearTimeout(this.openTimer);
    const anchor = this.deps.getNode();
    const chip = this.deps.getRoot()?.querySelector(`[data-card="${name}"]`);
    const editor = this.deps.getComposer()?.editor;
    const conversation = this.deps.getConversationId();
    this.openTimer = setTimeout(() => {
      this.openTimer = null;
      // A host route/composer replacement can detach the chip without a
      // pointerleave. Never show a stale or disconnected top-layer popover.
      if (
        this.deps.isDisposed() ||
        this.deps.getNode() !== anchor ||
        !anchor?.isConnected ||
        !chip?.isConnected ||
        !chip.matches(':hover') ||
        this.deps.getComposer()?.editor !== editor ||
        this.deps.getConversationId() !== conversation
      ) {
        return;
      }
      this.show(name);
    }, HOVER_DELAY);
  }

  leaveChip(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  scheduleHide(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    // Measure the warm window from pointer departure, not the later hide.
    if (this.cardName) this.warmUntil = Date.now() + WARM_WINDOW;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (!this.cardEngaged()) this.hide({ keepWarm: true });
    }, LEAVE_DELAY);
  }

  bindShadowInteractions(activeRoot: ShadowRoot, activeNode: HTMLElement): void {
    activeRoot.getElementById('guide-close')?.addEventListener('click', () => void this.deps.guide.dismiss());
    activeRoot.getElementById('guide-open')?.addEventListener('click', () => {
      this.deps.guide.guideOpened = true;
      this.show('context');
      const zhBtn = activeRoot.getElementById('card-language-zh');
      zhBtn?.scrollIntoView({ block: 'nearest' });
      zhBtn?.focus({ preventScroll: true });
    });

    for (const chip of activeRoot.querySelectorAll<HTMLElement>('[data-card]')) {
      const name = chip.dataset.card || '';
      chip.addEventListener('pointerenter', () => this.hoverChip(name));
      chip.addEventListener('pointerleave', () => this.leaveChip());
      chip.addEventListener('focus', () => {
        if (chip.matches(':focus-visible')) this.show(name);
      });
      chip.addEventListener('click', () => this.show(name));
    }
    for (const card of activeRoot.querySelectorAll<HTMLElement>('.card')) {
      card.addEventListener('pointerenter', () => {
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
      });
      card.addEventListener('pointerleave', () => this.scheduleHide());
    }
    // A host composer may focus its editor on bubbled clicks. Keep plugin
    // controls' mouse actions inside the shadow root while retaining their
    // default focus/click behavior and document-level outside-click dismissal.
    for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
      activeRoot.addEventListener(type, (event) => event.stopPropagation());
    }
    activeNode.addEventListener('pointerenter', () => {
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
    });
    activeNode.addEventListener('pointerleave', () => this.scheduleHide());
    activeRoot.addEventListener('focusout', () =>
      setTimeout(() => {
        if (!this.cardEngaged()) this.hide();
      }, 0),
    );
    for (const button of activeRoot.querySelectorAll<HTMLElement>('.group-trigger')) {
      button.addEventListener('click', () => {
        const menu = button.parentElement?.querySelector<HTMLElement>('.group-menu');
        if (!menu) return;
        const opening = menu.hidden;
        this.closeGroup();
        if (opening) {
          this.groupMenu = menu;
          menu.hidden = false;
          button.setAttribute('aria-expanded', 'true');
        }
      });
    }
    for (const button of activeRoot.querySelectorAll('.refresh')) {
      button.addEventListener('click', () => void this.deps.onRefreshManually());
    }
    for (const button of activeRoot.querySelectorAll<HTMLElement>('[data-language-choice]')) {
      button.addEventListener('click', () => {
        this.closeGroup();
        const choice = button.dataset.languageChoice;
        if (choice === 'en' || choice === 'zh-CN') {
          void this.deps.onChooseLanguage(choice);
        }
      });
    }
    activeRoot.getElementById('open-sidebar')?.addEventListener('click', () => {
      this.hide();
      this.deps.onOpenSidebar();
    });
  }

  disposeTimers(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }
}

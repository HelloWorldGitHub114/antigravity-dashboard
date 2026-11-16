import type { ComposerMatch } from './types.ts';

export const WIDGET_CONTAINER_ID = 'ag-pulse-status-bar';

const INTERACTIVE_SELECTOR =
  'button,a,input,select,[contenteditable="true"],[role="button"],[role="combobox"],[aria-haspopup]';
const SEND_CONTROL_SELECTOR =
  '[data-testid="send-button"],[data-tooltip-id*="send-button"],[data-testid="stop-button"],[data-testid="cancel-button"],button[aria-label]';

export function isElementVisible(element: Element | null | undefined): element is HTMLElement {
  return Boolean(
    element &&
      element.isConnected &&
      !element.closest('[hidden],[inert]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );
}

export function badgeTextRects(badge: Element | null | undefined): DOMRect[] {
  if (!badge?.isConnected) return [];
  const walker = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const rects: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !node.textContent?.trim() ||
      !parent ||
      parent.closest('svg,[hidden],[inert]') ||
      getComputedStyle(parent).visibility === 'hidden'
    ) {
      continue;
    }
    range.selectNodeContents(node);
    rects.push(...range.getClientRects());
  }
  return rects.filter((r) => r.width > 0 && r.height > 0);
}

export function composerLayout({
  row,
  editor,
  branch,
}: Pick<ComposerMatch, 'row' | 'editor' | 'branch'>): boolean {
  // Containment alone can join an app header and a distant message editor.
  // Accept only a horizontal, normal-flow action row local to that editor.
  const style = getComputedStyle(row);
  if (
    !['flex', 'inline-flex'].includes(style.display) ||
    style.flexDirection !== 'row' ||
    ['absolute', 'fixed'].includes(style.position) ||
    row.closest('header,[role="banner"]')
  ) {
    return false;
  }
  if (['absolute', 'fixed'].includes(getComputedStyle(branch).position)) return false;
  const parent = row.parentElement;
  if (!parent) return false;
  const r = row.getBoundingClientRect();
  const e = editor.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  const gap = Math.max(0, r.top - e.bottom, e.top - r.bottom);
  const overlap = Math.min(r.bottom, e.bottom) - Math.max(r.top, e.top);
  return (
    r.width > 0 &&
    r.height > 0 &&
    e.width > 0 &&
    e.height > 0 &&
    gap <= 48 &&
    overlap <= 2 &&
    Math.min(r.right, e.right) > Math.max(r.left, e.left) &&
    p.height <= e.height + r.height + 96
  );
}

function isSendOrCancelControl(el: HTMLElement, allowSendLabels: boolean): boolean {
  if (el.hasAttribute('data-testid') && /^(send|stop|cancel)-button$/.test(el.dataset.testid || '')) {
    return true;
  }
  if (el.getAttribute('data-tooltip-id')?.includes('send-button')) return true;
  const label = el.getAttribute('aria-label') || '';
  return allowSendLabels
    ? /^(?:send|submit|cancel|stop|发送|提交|取消|停止)(?:\b|\s|生成|任务|响应|消息|$)/i.test(label)
    : /^(?:cancel|stop|取消|停止)(?:\b|\s|生成|任务|响应|$)/i.test(label);
}

function editorDistance(editor: HTMLElement, rootParent: HTMLElement | null): number {
  let distance = 0;
  for (let el: HTMLElement | null = editor; el && el !== rootParent; el = el.parentElement) {
    distance++;
  }
  return distance;
}

export function findPrimaryMatches(editors: HTMLElement[]): ComposerMatch[] {
  const stableModels = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="model-selector-trigger"]'),
  ).filter(isElementVisible);
  const models = stableModels.length
    ? stableModels
    : Array.from(
        document.querySelectorAll<HTMLElement>(
          'button[role="combobox"][aria-haspopup],button[aria-label^="Select model"]',
        ),
      ).filter(isElementVisible);
  const pairs: ComposerMatch[] = [];
  const ownsEditor = (element: Element, editor: Element): boolean =>
    element.closest('[data-testid="agent-input-box"]') ===
    editor.closest('[data-testid="agent-input-box"]');

  for (const model of models) {
    for (const editor of editors) {
      if (!ownsEditor(model, editor)) continue;
      let row = model.parentElement;
      let distance = 1;
      // The toolbar branch and editable branch meet at their nearest common
      // composer ancestor. Action-button labels and generation state are irrelevant.
      while (
        row?.parentElement &&
        !row.parentElement.contains(editor) &&
        row.parentElement !== document.body &&
        row.parentElement !== document.documentElement
      ) {
        row = row.parentElement;
        distance++;
      }
      if (
        !row ||
        row === document.body ||
        row.contains(editor) ||
        !row.parentElement?.contains(editor) ||
        row.parentElement === document.body ||
        row.parentElement === document.documentElement
      ) {
        continue;
      }
      distance += editorDistance(editor, row.parentElement);
      let branch: HTMLElement = model;
      while (branch.parentElement && branch.parentElement !== row) branch = branch.parentElement;
      const pair: ComposerMatch = {
        editor,
        model,
        row,
        branch,
        box: editor.closest<HTMLElement>('[data-testid="agent-input-box"]'),
        distance,
        kind: 'main',
      };
      if (composerLayout(pair)) pairs.push(pair);
    }
  }
  return pairs;
}

export function findSubagentMatches(
  editors: HTMLElement[],
  pairs: ComposerMatch[],
): Set<HTMLElement> {
  // Subagents have a static identity badge instead of a model selector.
  // Use only a bounded, stable host input box with a semantic send control;
  // never use the auxiliary pane's arbitrary comboboxes as an anchor.
  const ambiguousBoxes = new Set<HTMLElement>();
  for (const editor of editors) {
    const box = editor.closest<HTMLElement>('[data-testid="agent-input-box"]');
    if (!box || !isElementVisible(box)) continue;
    const owned = (e: Element): boolean => e.closest('[data-testid="agent-input-box"]') === box;
    const activeEditors = Array.from(box.querySelectorAll('[contenteditable="true"]')).filter(
      (e) => owned(e) && isElementVisible(e),
    );
    if (!activeEditors.includes(editor) || activeEditors.length !== 1) {
      ambiguousBoxes.add(box);
      continue;
    }
    if (
      Array.from(box.querySelectorAll('[data-testid="model-selector-trigger"]')).some(
        (e) => owned(e) && isElementVisible(e),
      )
    ) {
      continue;
    }
    const controls = Array.from(box.querySelectorAll<HTMLElement>(SEND_CONTROL_SELECTOR)).filter(
      (e) => owned(e) && isElementVisible(e) && isSendOrCancelControl(e, false),
    );
    for (const send of controls) {
      let row = send.parentElement;
      let distance = 1;
      while (row?.parentElement && row.parentElement !== box && !row.parentElement.contains(editor)) {
        row = row.parentElement;
        distance++;
      }
      if (!row || row.contains(editor) || !row.parentElement?.contains(editor) || !box.contains(row)) {
        continue;
      }
      // The smallest static icon+text badge is structural evidence, even
      // without title/span. Icon-only controls and ambiguous badges fail closed.
      const candidates = Array.from(row.querySelectorAll<HTMLElement>('*')).filter(
        (e) =>
          owned(e) &&
          isElementVisible(e) &&
          e.id !== WIDGET_CONTAINER_ID &&
          !e.closest(`#${WIDGET_CONTAINER_ID}`) &&
          Boolean(e.querySelector('svg')) &&
          badgeTextRects(e).length > 0 &&
          !e.contains(send) &&
          !send.contains(e) &&
          !e.matches(INTERACTIVE_SELECTOR) &&
          !e.closest(INTERACTIVE_SELECTOR) &&
          !e.querySelector(INTERACTIVE_SELECTOR),
      );
      const anchors = candidates.filter((e) => !candidates.some((other) => other !== e && e.contains(other)));
      if (anchors.length !== 1) {
        if (anchors.length > 1) ambiguousBoxes.add(box);
        continue;
      }
      const anchor = anchors[0];
      let branch: HTMLElement = anchor;
      while (branch.parentElement && branch.parentElement !== row) branch = branch.parentElement;
      if (branch.contains(send)) continue;
      distance += editorDistance(editor, row.parentElement);
      const pair: ComposerMatch = {
        editor,
        model: null,
        row,
        branch,
        anchor,
        box,
        distance,
        kind: 'subagent',
      };
      if (composerLayout(pair) && !pairs.some((p) => p.editor === editor && p.row === row && p.branch === branch)) {
        pairs.push(pair);
      }
    }
  }
  return ambiguousBoxes;
}

export function findFallbackMatches(
  editors: HTMLElement[],
  ambiguousBoxes: Set<HTMLElement>,
  pairs: ComposerMatch[],
): void {
  for (const editor of editors) {
    const box = editor.closest<HTMLElement>('[data-testid="agent-input-box"]');
    if (!box || !isElementVisible(box) || ambiguousBoxes.has(box)) continue;
    const owned = (e: Element): boolean => e.closest('[data-testid="agent-input-box"]') === box;
    const activeEditors = Array.from(box.querySelectorAll('[contenteditable="true"]')).filter(
      (e) => owned(e) && isElementVisible(e),
    );
    if (!activeEditors.includes(editor) || activeEditors.length !== 1) continue;
    const controls = Array.from(box.querySelectorAll<HTMLElement>(SEND_CONTROL_SELECTOR)).filter(
      (e) => owned(e) && isElementVisible(e) && isSendOrCancelControl(e, true),
    );
    for (const send of controls) {
      let row = send.parentElement;
      let distance = 1;
      while (row?.parentElement && row.parentElement !== box && !row.parentElement.contains(editor)) {
        row = row.parentElement;
        distance++;
      }
      if (!row || row.contains(editor) || !row.parentElement?.contains(editor) || !box.contains(row)) {
        continue;
      }
      let branch = row.firstElementChild as HTMLElement | null;
      while (branch && branch.contains(editor)) branch = branch.nextElementSibling as HTMLElement | null;
      if (!branch) branch = send;
      while (branch.parentElement && branch.parentElement !== row) branch = branch.parentElement;
      distance += editorDistance(editor, row.parentElement);
      const pair: ComposerMatch = {
        editor,
        model: null,
        row,
        branch,
        anchor: branch,
        box,
        distance,
        kind: 'main',
      };
      if (composerLayout(pair) && !pairs.some((p) => p.editor === editor && p.row === row && p.branch === branch)) {
        pairs.push(pair);
      }
    }
  }
}

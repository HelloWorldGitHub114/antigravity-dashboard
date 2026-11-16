// Dedicated IDE DOM adapter. No host classes, model labels or translated copy
// are used to identify the composer; only its stable ID and semantic controls.
import { setMarkup } from '../shared/dom.ts';
import {
  readIdeConversationId,
  readIdeConversationState,
  type ComposerTarget,
  type ConversationState,
} from '../ui/host-adapter/index.ts';

export interface IdeComposer extends ComposerTarget {
  editor: Element;
  model: Element;
  row: Element;
  branch: Element;
  box: Element;
  kind: 'ide';
}

export interface IdeSurface {
  findComposer(previous?: IdeComposer | null): IdeComposer | null;
  conversationId(composer?: ComposerTarget | null): string | null;
  conversationState(composer?: ComposerTarget | null): ConversationState;
  nativeReserve(target: { branch: Element; model: Element }): number;
  setMarkup: typeof setMarkup;
  showEmpty: boolean;
  usageHostLabel: string;
}

const isVisible = (element: Element | null | undefined): element is Element =>
  Boolean(
    element?.isConnected &&
      !element.closest('[hidden],[inert]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );

/**
 * Creates the Antigravity IDE renderer surface adapter for the inline dashboard widget.
 */
export default function createIdeSurface(): IdeSurface {
  function findComposer(previous?: IdeComposer | null): IdeComposer | null {
    const boxes = [...document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]')].filter(
      isVisible,
    );
    const pairs: IdeComposer[] = [];

    for (const box of boxes) {
      const editors = [
        ...box.querySelectorAll(
          '[contenteditable="true"][role="combobox"],[contenteditable="true"][role="textbox"]',
        ),
      ].filter(isVisible);
      const models = [...box.querySelectorAll('[data-testid="model-selector-trigger"]')].filter(
        isVisible,
      );
      if (editors.length !== 1 || models.length !== 1) continue;

      const editor = editors[0];
      const model = models[0];
      let row = model.parentElement;
      while (row && row !== box && !row.parentElement?.contains(editor)) {
        row = row.parentElement;
      }
      if (!row || row === box || row.contains(editor)) continue;

      const style = getComputedStyle(row);
      const rowRect = row.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      if (
        style.display !== 'flex' ||
        style.flexDirection !== 'row' ||
        ['absolute', 'fixed'].includes(style.position) ||
        rowRect.width < 1 ||
        Math.max(0, rowRect.top - editorRect.bottom) > 48
      ) {
        continue;
      }

      let branch = model;
      while (branch.parentElement && branch.parentElement !== row) {
        branch = branch.parentElement;
      }
      pairs.push({ editor, model, row, branch, box, kind: 'ide' });
    }

    if (pairs.length === 1) return pairs[0];
    return (
      pairs.find((p) => p.editor === document.activeElement) ||
      pairs.find((p) => p.editor === previous?.editor) ||
      null
    );
  }

  function nativeReserve({ branch, model }: { branch: Element; model: Element }): number {
    const style = getComputedStyle(branch);
    const label = model.querySelector('span');
    const modelStyle = getComputedStyle(model);
    const labelWidth = label
      ? Math.max(label.scrollWidth, label.getBoundingClientRect().width)
      : model.scrollWidth;
    const icons = [...model.querySelectorAll('svg')];
    const gap = parseFloat(modelStyle.columnGap) || 0;
    const modelWidth =
      labelWidth +
      icons.reduce((sum, el) => sum + Math.max(14, el.getBoundingClientRect().width), 0) +
      gap * icons.length +
      (parseFloat(modelStyle.paddingLeft) || 0) +
      (parseFloat(modelStyle.paddingRight) || 0);
    const children = [...branch.children].filter(
      (el) => isVisible(el) && el.id !== 'ag-pulse-status-bar',
    );
    const childrenWidth = children.reduce(
      (sum, el) =>
        sum + (el.contains(model) ? Math.max(modelWidth, el.getBoundingClientRect().width) : el.getBoundingClientRect().width),
      0,
    );
    return Math.ceil(
      childrenWidth +
        (parseFloat(style.columnGap) || 0) * Math.max(0, children.length - 1) +
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0) +
        2,
    );
  }

  return {
    findComposer,
    conversationId: readIdeConversationId,
    conversationState: readIdeConversationState,
    nativeReserve,
    setMarkup,
    showEmpty: true,
    usageHostLabel: 'Antigravity IDE',
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ALLOWED_MARKUP_TAGS = new Set(
  'style div span button strong section dl dt dd p i svg path circle ellipse rect header h1 h2 nav footer table thead tbody tr th td details summary'.split(
    ' ',
  ),
);

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (all, key: string) => {
      if (key[0] === '#') {
        const isHex = key[1]?.toLowerCase() === 'x';
        const code = parseInt(key.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : all;
      }
      return HTML_ENTITIES[key.toLowerCase()] ?? all;
    },
  );
}

/**
 * Escapes HTML special characters for safe text interpolation.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => HTML_ESCAPE_MAP[ch] ?? ch,
  );
}

/**
 * Trusted-Types-safe DOM template builder matching the IDE surface allowlist.
 * Builds elements via `createElement` / `createElementNS` without `innerHTML`,
 * rejects disallowed tags, `on*` handlers, `src`/`href`/`srcdoc`, and unbalanced markup.
 */
export function setMarkup(
  target: Element | ShadowRoot,
  markup: string,
  doc: Document = target.ownerDocument ?? document,
): void {
  const fragment = doc.createDocumentFragment();
  const stack: Array<DocumentFragment | Element> = [fragment];
  let offset = 0;
  const token = /<\/?([a-z][\w-]*)(\s[^<>]*?)?\s*\/?\s*>/gi;

  for (let match: RegExpExecArray | null; (match = token.exec(markup)); ) {
    if (match.index > offset) {
      stack
        .at(-1)!
        .append(doc.createTextNode(decodeEntities(markup.slice(offset, match.index))));
    }
    const tag = match[1].toLowerCase();
    const closing = match[0][1] === '/';
    if (!ALLOWED_MARKUP_TAGS.has(tag)) {
      throw new Error('Unsupported dashboard template element');
    }
    if (closing) {
      const top = stack.at(-1) as { localName?: string } | undefined;
      if (stack.length === 1 || top?.localName !== tag) {
        throw new Error('Unbalanced dashboard template');
      }
      stack.pop();
    } else {
      const parent = stack.at(-1)! as { namespaceURI?: string | null; append(node: Node): void };
      const isSvg = tag === 'svg' || parent.namespaceURI === SVG_NS;
      const element = isSvg
        ? doc.createElementNS(SVG_NS, tag)
        : doc.createElement(tag);
      const attrs = match[2] || '';
      const attrRe = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
      for (let attr: RegExpExecArray | null; (attr = attrRe.exec(attrs)); ) {
        const name = attr[1];
        if (name === '/' || /^on/i.test(name) || /^(src|href|srcdoc)$/i.test(name)) {
          throw new Error('Unsupported dashboard template attribute');
        }
        element.setAttribute(name, decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''));
      }
      parent.append(element);
      if (tag === 'style') {
        const end = markup.indexOf('</style>', token.lastIndex);
        if (end < 0) throw new Error('Unclosed dashboard style');
        element.textContent = markup.slice(token.lastIndex, end);
        token.lastIndex = end + 8;
      } else if (!match[0].endsWith('/>')) {
        stack.push(element);
      }
    }
    offset = token.lastIndex;
  }

  if (stack.length !== 1) {
    throw new Error('Unclosed dashboard template');
  }
  if (offset < markup.length) {
    fragment.append(doc.createTextNode(decodeEntities(markup.slice(offset))));
  }
  target.replaceChildren(fragment);
}

export interface CreateElAttrs {
  text?: string | number | boolean | null;
  [attr: string]: string | number | boolean | null | undefined;
}

/**
 * Creates an HTML element with attributes and optional `text` content.
 */
export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: CreateElAttrs,
  doc?: Document,
): HTMLElementTagNameMap[K];
export function createEl(
  tag: string,
  attrs?: CreateElAttrs,
  doc?: Document,
): HTMLElement;
export function createEl(
  tag: string,
  attrs: CreateElAttrs = {},
  doc: Document = document,
): HTMLElement {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') {
      element.textContent = value == null ? '' : String(value);
    } else if (value !== false && value !== null && value !== undefined) {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  return element;
}

/**
 * Alias for {@link createEl}.
 */
export const createElement = createEl;

/**
 * Updates `el.textContent` only when changed.
 */
export function setText(el: Node | null | undefined, value: unknown): void {
  const next = value == null ? '' : String(value);
  if (el && el.textContent !== next) el.textContent = next;
}

/**
 * Sets or removes an attribute only when changed.
 */
export function setAttr(
  el: Element | null | undefined,
  name: string,
  value: string | number | boolean | null | undefined,
): void {
  if (!el) return;
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const next = String(value);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}

/**
 * Sets a CSS property or custom property on `el.style` only when changed.
 */
export function setStyle(
  el: HTMLElement | SVGElement | null | undefined,
  prop: string,
  value: string | number | null | undefined,
): void {
  if (!el) return;
  const next = value == null ? '' : String(value);
  if (prop.startsWith('--') || prop.includes('-')) {
    if (el.style.getPropertyValue(prop) !== next) {
      el.style.setProperty(prop, next);
    }
    return;
  }
  const styleObj = el.style as unknown as Record<string, string>;
  if (styleObj[prop] !== next) {
    styleObj[prop] = next;
  }
}

/**
 * Toggles `el.hidden` only when changed.
 */
export function setHidden(
  el: { hidden: boolean | string } | null | undefined,
  hidden: boolean,
): void {
  const next = Boolean(hidden);
  if (el && el.hidden !== next) el.hidden = next;
}

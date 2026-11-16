// Incremental JSON projection for trajectory RPCs. Large prompts, tool results,
// images and executor payloads are validated and skipped, never buffered.
import { normalizeConversationId } from '../delegation/delegation.ts';
import {
  calls,
  dropEmptyNodes,
  durationNode,
  guid,
  nonempty,
  presence,
  scalar,
  schema,
  timelineSchema,
  trajectoryBase,
  trajectorySummaries,
  trajectoryTimeline,
  updateBase,
  updateTimeline,
  userInputMeta,
  type ProjectionNode,
} from './schema.ts';

export type { ProjectionNode };

export interface TrajectoryJsonOptions {
  maxRetainedBytes?: number;
  projection?: ProjectionNode | null;
  modelTimelineEnabled?: boolean;
}

type ExpectState = 'key' | 'keyOrEnd' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd';

interface StackFrame {
  node: ProjectionNode | undefined;
  array: boolean;
  out: Record<string, unknown> | unknown[] | null;
  count: number;
  key: string | null;
  expect: ExpectState;
}

type TokenState =
  | {
      kind: 'string';
      key: boolean;
      node: ProjectionNode | undefined;
      buffer: string;
      overflow: boolean;
      escape: 0 | 1 | 2;
      hex: string;
      any: boolean;
      ascii: number;
      other: number;
    }
  | { kind: 'literal'; node: ProjectionNode | undefined; buffer: string };

const DROP = Symbol('discard');
const ESCAPE_DECODE: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const PLAN_MODEL_NODES = new Set<ProjectionNode>([trajectoryBase, trajectoryTimeline, updateBase, updateTimeline]);

/**
 * Streaming JSON parser and schema-driven projector that validates all tokens while
 * retaining only statistical and structural fields within a strict memory budget.
 */
export class TrajectoryJson {
  maxRetainedBytes: number;
  modelTimelineEnabled: boolean;
  projection: ProjectionNode;
  stack: StackFrame[] = [];
  token: TokenState | null = null;
  result: unknown = undefined;
  done = false;
  retained = 0;
  capturedPlanModel: string | null = null;

  constructor({ maxRetainedBytes = 8 * 1024 * 1024, projection = null, modelTimelineEnabled = false }: TrajectoryJsonOptions = {}) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.modelTimelineEnabled = modelTimelineEnabled === true;
    this.projection = projection || (this.modelTimelineEnabled ? timelineSchema : schema);
  }

  private fail(): never {
    throw new Error('Antigravity 接口返回了无法解析的数据');
  }

  private charge(n: number): void {
    if ((this.retained += n) > this.maxRetainedBytes) throw new Error('会话统计数据超过采集上限');
  }

  private node(): ProjectionNode | undefined {
    const f = this.stack.at(-1);
    if (!f) return this.projection;
    if (!f.node || typeof f.node !== 'object') return undefined;
    if (f.array) return Object.hasOwn(f.node, '*') ? f.node['*'] : undefined;
    if (f.key && Object.hasOwn(f.node, f.key)) return f.node[f.key];
    if (f.node === trajectorySummaries && Object.hasOwn(f.node, '*')) return f.node['*'];
    return undefined;
  }

  private valueAllowed(): boolean {
    const f = this.stack.at(-1);
    return f ? f.expect === 'value' || f.expect === 'valueOrEnd' : !this.done;
  }

  private finishValue(value: unknown): void {
    const f = this.stack.at(-1);
    if (!f) {
      if (this.done) this.fail();
      if (this.capturedPlanModel && value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'trajectory') && Object.hasOwn(value, 'steps') && !(value as Record<string, unknown>).planModel) {
        (value as Record<string, unknown>).planModel = this.capturedPlanModel;
      }
      this.result = value;
      this.done = true;
      return;
    }
    if (f.expect !== 'value' && f.expect !== 'valueOrEnd') this.fail();
    if (value !== DROP && f.out && (f.array || f.key !== null)) {
      this.charge(32);
      if (Array.isArray(f.out)) f.out.push(value);
      else if (f.key !== null) Object.defineProperty(f.out, f.key, { value, writable: true, enumerable: true, configurable: true });
    }
    f.count++;
    f.expect = 'commaOrEnd';
    f.key = null;
  }

  private closeContainer(c: string): void {
    const f = this.stack.at(-1);
    const expectedEnd = f?.array ? 'valueOrEnd' : 'keyOrEnd';
    if (!f || f.array !== (c === ']') || (f.expect !== 'commaOrEnd' && f.expect !== expectedEnd)) this.fail();
    this.stack.pop();
    const val: unknown = f.node === presence ? true : f.node === calls ? (f.count ? [{}] : []) : f.out || DROP;
    let finalVal = val;
    if (f.node === userInputMeta && val && typeof val === 'object' && !Array.isArray(val)) {
      const pm = (val as { userConfig?: { plannerConfig?: { planModel?: unknown } } }).userConfig?.plannerConfig?.planModel;
      if (typeof pm === 'string' && pm.trim()) this.capturedPlanModel = pm.trim().slice(0, 256);
      if (!this.modelTimelineEnabled || !pm) finalVal = DROP;
    } else if (f.node !== undefined && PLAN_MODEL_NODES.has(f.node) && val && typeof val === 'object' && !Array.isArray(val) && this.capturedPlanModel && !(val as Record<string, unknown>).planModel) {
      (val as Record<string, unknown>).planModel = this.capturedPlanModel;
    } else if (f.node !== undefined && dropEmptyNodes.has(f.node) && val && typeof val === 'object' && !Object.keys(val).length) {
      finalVal = DROP;
    }
    this.finishValue(finalVal);
  }

  private punctuation(c: string): void {
    const f = this.stack.at(-1);
    if (c === '{' || c === '[') {
      if (!this.valueAllowed() || this.stack.length >= 64) this.fail();
      const array = c === '[';
      const node = f && !f.array && !f.key ? undefined : this.node();
      const isObjNode = node !== undefined && typeof node === 'object';
      const out = isObjNode ? (array ? (Object.hasOwn(node, '*') && node !== trajectorySummaries ? [] : null) : {}) : null;
      if (out) this.charge(64);
      this.stack.push({ node, array, out, count: 0, key: null, expect: array ? 'valueOrEnd' : 'keyOrEnd' });
      return;
    }
    if (c === '}' || c === ']') { this.closeContainer(c); return; }
    if (c === ':') { if (!f || f.array || f.expect !== 'colon') this.fail(); f.expect = 'value'; return; }
    if (c === ',') { if (!f || f.expect !== 'commaOrEnd') this.fail(); f.expect = f.array ? 'value' : 'key'; return; }
    this.fail();
  }

  private startString(): void {
    const f = this.stack.at(-1);
    const key = Boolean(f && !f.array && (f.expect === 'key' || f.expect === 'keyOrEnd'));
    if (!key && !this.valueAllowed()) this.fail();
    this.token = { kind: 'string', key, node: key ? undefined : this.node(), buffer: '', overflow: false, escape: 0, hex: '', any: false, ascii: 0, other: 0 };
  }

  private stringPart(text: string): void {
    const t = this.token;
    if (!t || t.kind !== 'string') return;
    if ((t.node === nonempty && /\S/u.test(text)) || (t.node === presence && text.length > 0)) t.any = true;
    if (t.node === 'textEstimate') {
      const other = (text.match(/[^\x00-\x7f]/g) || []).length;
      t.ascii += text.length - other;
      t.other += other;
      if (t.buffer.length < 256) t.buffer += text.slice(0, 256 - t.buffer.length);
    }
    if (t.node === guid) {
      if (t.overflow) return;
      t.buffer += text;
      if (t.buffer.length > 64) { t.buffer = ''; t.overflow = true; }
      return;
    }
    if (t.key || t.node === scalar || t.node === durationNode) {
      if (t.overflow) return;
      t.buffer += text;
      if (t.buffer.length > (t.key ? 1024 : 16384)) {
        if (!t.key) throw new Error('会话统计字段超过采集上限');
        t.buffer = '';
        t.overflow = true;
      }
    }
  }

  private endString(): void {
    const t = this.token;
    this.token = null;
    if (!t || t.kind !== 'string') return;
    if (t.key) {
      const f = this.stack.at(-1)!;
      f.key = f.node === trajectorySummaries ? normalizeConversationId(t.buffer) : (t.overflow ? null : t.buffer);
      f.expect = 'colon';
      return;
    }
    let value: unknown = DROP;
    if (t.node === guid) { const norm = normalizeConversationId(t.buffer); value = norm !== null ? norm : DROP; }
    else if (t.node === nonempty) value = t.any ? '1' : '';
    else if (t.node === 'textEstimate') value = { tokens: Math.ceil(t.ascii / 4 + t.other / 1.5), prefix: t.buffer };
    else if (t.node === presence) value = t.any;
    else if (t.node === scalar || t.node === durationNode) { value = t.buffer; this.charge(t.buffer.length * 2); }
    this.finishValue(value);
  }

  private literalEnd(): void {
    const t = this.token;
    this.token = null;
    if (!t || t.kind !== 'literal') return;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(t.buffer)) this.fail();
    const value: unknown = JSON.parse(t.buffer);
    this.finishValue(t.node && t.node !== guid ? value : DROP);
  }

  write(text: string): void {
    let i = 0;
    while (i < text.length) {
      const t = this.token;
      if (t?.kind === 'string') {
        if (t.escape === 1) {
          const c = text[i++];
          if (c === 'u') { t.escape = 2; t.hex = ''; continue; }
          const decoded = ESCAPE_DECODE[c];
          if (decoded === undefined) this.fail();
          this.stringPart(decoded); t.escape = 0; continue;
        }
        if (t.escape === 2) {
          const c = text[i++];
          if (!/[0-9a-f]/i.test(c)) this.fail();
          t.hex += c;
          if (t.hex.length === 4) { this.stringPart(String.fromCharCode(parseInt(t.hex, 16))); t.escape = 0; }
          continue;
        }
        const special = /["\\\x00-\x1f]/g;
        special.lastIndex = i;
        const hit = special.exec(text);
        const end = hit ? hit.index : text.length;
        this.stringPart(text.slice(i, end));
        i = end;
        if (!hit) continue;
        const c = text[i++];
        if (c === '"') this.endString();
        else if (c === '\\') t.escape = 1;
        else this.fail();
        continue;
      }
      if (t?.kind === 'literal') {
        const start = i;
        while (i < text.length && /[a-zA-Z0-9+\-.]/.test(text[i])) i++;
        t.buffer += text.slice(start, i);
        if (t.buffer.length > 1024) this.fail();
        if (i < text.length) this.literalEnd();
        continue;
      }
      const c = text[i++];
      if (/[ \r\n\t]/.test(c)) continue;
      if (c === '"') { this.startString(); continue; }
      if ('{}[]:,'.includes(c)) { this.punctuation(c); continue; }
      if (!this.valueAllowed() || !/[tfn\d-]/.test(c)) this.fail();
      this.token = { kind: 'literal', node: this.node(), buffer: c };
    }
  }

  end<T = Record<string, unknown>>(): T {
    if (this.token?.kind === 'literal') this.literalEnd();
    if (this.token || this.stack.length || !this.done || !this.result || typeof this.result !== 'object') this.fail();
    return this.result as T;
  }
}

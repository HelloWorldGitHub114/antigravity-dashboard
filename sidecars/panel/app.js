import { percent, rate, count, elapsed, countdown, resetDate } from './format.mjs';
import { createI18n } from './i18n.js';
import { createTheme } from './theme.js';
function initPanel(){
if(!document.querySelector('.widget')||window.__agPulsePanelInstalled)return;
window.__agPulsePanelInstalled=true;
const theme=createTheme();
let themeController=theme.attach(document.documentElement);
window.addEventListener('pagehide',()=>themeController.dispose());
window.addEventListener('pageshow',event=>{if(event.persisted)themeController=theme.attach(document.documentElement);});
const localGet=key=>{try{return localStorage.getItem(key);}catch{return null;}};
const localSet=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
const language=createI18n(localGet('ag-pulse-language'));
const t=language.t;

const domCache = new Map();
const $ = id => {
  let el = domCache.get(id);
  if (!el || !el.isConnected) {
    el = document.getElementById(id);
    if (el) domCache.set(id, el);
  }
  return el;
};
const setText = (el, value) => {
  const next = value == null ? '' : String(value);
  if (el && el.textContent !== next) el.textContent = next;
};
const setAttr = (el, name, value) => {
  if (!el) return;
  if (value === null || value === undefined) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const next = String(value);
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
};
const setStyle = (el, prop, value) => {
  if (!el) return;
  const next = value == null ? '' : String(value);
  if (el.style[prop] !== next) el.style[prop] = next;
};
const setHidden = (el, hidden) => { if (el && el.hidden !== !!hidden) el.hidden = !!hidden; };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const compact=n=>typeof n!=='number'||!Number.isFinite(n)?'—':n>=1e9?`${(n/1e9).toFixed(1).replace(/\.0$/,'')}B`:n>=1e6?`${(n/1e6).toFixed(1).replace(/\.0$/,'')}M`:n>=1e3?`${(n/1e3).toFixed(1).replace(/\.0$/,'')}K`:String(n);
const chips = [...document.querySelectorAll('[data-card]')];
const i18nTextNodes = [...document.querySelectorAll('[data-i18n]')];
const i18nAriaNodes = [...document.querySelectorAll('[data-i18n-aria]')];
const i18nTitleNodes = [...document.querySelectorAll('[data-i18n-aria][title]')];
const groupNameNodes = [...document.querySelectorAll('.group-name')];
const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const isMotionReduced = () => Boolean(
  reducedMotionQuery?.matches ||
  document.documentElement.classList.contains('motion-reduced') ||
  document.body.classList.contains('motion-reduced') ||
  document.querySelector('.widget')?.classList.contains('motion-reduced')
);
let snapshot = null, selectedGroup = localGet('ag-pulse-group'), group = null;
let pending = false, timer = null, serverOffset = 0, lastExpiredRefresh = 0;
let selectedCard='speed',cardMotion=null;
const cardScroll = new Map();
let refreshRequest=null,manualRequest=null,syncingFromRefresh=false,lastThemeKey=null,lastLocalizedKey=null;
let mixMetric='total',mixScope='session',mixScopeManual=false,mixActiveId=null,mixHoverId=null,lastMixSig=null,mixDisplayModels=[];
let timelineEnabled=false,timelineEpoch=0,timelineBusy=false,timelineNoticeKey=null,timelineNoticeIsError=false,lastTimelineSig=null,lastTimelineRender=[],lastTimelineClearAt=0;
const timelineToggled=new Map();
const host = window.sidecar;
if (!host) document.body.classList.add('standalone');
const preferenceRequest=async(input)=>{
  const transport=host?.fetch?host.fetch.bind(host):fetch;
  const response=await transport('/api/preferences',input?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}:{cache:'no-store'});
  if(!response.ok)throw new Error('Preferences unavailable');return response.json();
};
const connectPreferences=()=>language.connectPreferences({read:()=>preferenceRequest(),write:preferenceRequest,
  cache:value=>localSet('ag-pulse-language',value),changed:()=>{localize();if(!syncingFromRefresh){render();updateCountdowns();}}});
let preferences=connectPreferences();

const panelMotion = new WeakMap();
const clearMotionProps = el => { el.style.maxHeight = ''; el.style.opacity = ''; el.style.overflow = ''; };
function setExpandedState(el, expanded, animate = true) {
  if (!el) return;
  const prev = panelMotion.get(el);
  const isVisible = !el.hidden && !(prev && !prev.expanding);
  if (!prev && isVisible === expanded) return;
  let fromHeight = null, fromOpacity = null;
  if (prev) {
    fromHeight = el.getBoundingClientRect().height;
    fromOpacity = parseFloat(getComputedStyle(el).opacity);
    prev.anim?.cancel();
    clearMotionProps(el);
    panelMotion.delete(el);
    if (isVisible === expanded) { el.hidden = !expanded; return; }
  }
  if (!animate || isMotionReduced() || typeof el.animate !== 'function') {
    el.hidden = !expanded;
    return;
  }
  el.hidden = false;
  const cssMax = parseFloat(getComputedStyle(el).maxHeight);
  const fullHeight = Number.isFinite(cssMax) && cssMax > 0 ? Math.min(el.scrollHeight, cssMax) : el.scrollHeight;
  if (fullHeight <= 0) { el.hidden = !expanded; return; }
  const startHeight = fromHeight !== null ? fromHeight : (expanded ? 0 : fullHeight);
  const endHeight = expanded ? fullHeight : 0;
  const startOpacity = Number.isFinite(fromOpacity) ? fromOpacity : (expanded ? 0 : 1);
  const endOpacity = expanded ? 1 : 0;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [{ maxHeight: `${startHeight}px`, opacity: startOpacity }, { maxHeight: `${endHeight}px`, opacity: endOpacity }],
    { duration: expanded ? 180 : 160, easing: 'cubic-bezier(.22,1,.36,1)' }
  );
  panelMotion.set(el, { anim, expanding: expanded });
  const settle = cancelled => {
    if (panelMotion.get(el)?.anim !== anim) return;
    clearMotionProps(el);
    panelMotion.delete(el);
    if (!cancelled && !expanded) el.hidden = true;
  };
  anim.onfinish = () => settle(false);
  anim.oncancel = () => settle(true);
}

function showCard(name,animate=false) {
  if(!['speed','cache','context'].includes(name))return;
  const prev=selectedCard,changed=prev!==name;
  if(changed){const prevEl=$(`${prev}-card`);if(prevEl)cardScroll.set(prev,prevEl.scrollTop);}
  selectedCard=name;
  cardMotion?.cancel();cardMotion=null;
  for (const chip of chips){const selected=chip.dataset.card===name;setAttr(chip,'aria-selected',String(selected));chip.tabIndex=selected?0:-1;}
  for (const nameKey of ['speed','cache','context']) setHidden($(`${nameKey}-card`), name !== nameKey);
  const card=$(`${name}-card`);
  if(card&&changed)card.scrollTop=cardScroll.get(name)??0;
  if(changed&&animate&&!isMotionReduced()&&card?.animate)cardMotion=card.animate([{opacity:.55,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:160,easing:'cubic-bezier(.22,1,.36,1)'});
}
for (const chip of chips) {
  chip.addEventListener('click', event => showCard(chip.dataset.card,event.detail>0));
  chip.addEventListener('keydown',event=>{
    const current=chips.indexOf(chip);let next;
    if(event.key==='ArrowRight')next=(current+1)%chips.length;else if(event.key==='ArrowLeft')next=(current+chips.length-1)%chips.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=chips.length-1;else return;
    event.preventDefault();showCard(chips[next].dataset.card,true);chips[next].focus();
  });
}
function localize(){
  const locKey=`${language.language}|${Boolean(preferences.error)}`;
  if(locKey===lastLocalizedKey)return;
  lastLocalizedKey=locKey;
  lastMixSig=null;
  lastTimelineSig=null;
  setAttr(document.documentElement,'lang',language.language);
  for(const e of i18nTextNodes){
    if(!e.isConnected)continue;
    if(e.dataset.i18n==='taskTokensSubagents'&&snapshot?.speed?.taskUsage?.subagents>0)continue;
    setText(e,t(e.dataset.i18n));
  }
  for(const e of i18nAriaNodes)setAttr(e,'aria-label',t(e.dataset.i18nAria));
  for(const e of i18nTitleNodes){
    if(e.id==='language-toggle')continue;
    const ariaTitle=t(e.dataset.i18nAria);
    if(e.title!==ariaTitle)e.title=ariaTitle;
  }
  const privacyEl=$('timeline-privacy-text');
  if(privacyEl)setAttr(privacyEl,'title',t('timelinePrivacySummary'));
  renderTimelineStatus();
  const toggle=$('language-toggle');
  setText(toggle,language.language==='en'?'EN':'中');
  const nextTitle=t('switchLanguage')+(preferences.error?' · '+t('languageSaveFailed'):'');
  if(toggle.title!==nextTitle)toggle.title=nextTitle;
  setAttr(toggle,'data-save-failed',String(preferences.error));
}

function chooseGroup(groups, speed) {
  if (selectedGroup && groups.some(g => g.id === selectedGroup)) return groups.find(g => g.id === selectedGroup);
  const model = String(speed?.activeModel || speed?.model || '').toLowerCase();
  return groups.find(g => /gemini/.test(model) ? /gemini/i.test(g.id) : /claude|gpt/.test(model) ? /3p|claude|gpt/i.test(g.id) : false) || groups[0] || null;
}
function groupLabel(value) {
  return /gemini/i.test(value.name) ? 'Gemini' : /claude|gpt/i.test(value.name) ? 'Claude / GPT' : value.name;
}
const quotaColor = remaining => typeof remaining === 'number' && remaining < .05 ? 'var(--pulse-danger)'
  : typeof remaining === 'number' && remaining < .2 ? 'var(--pulse-warning)' : '';
function applyQuotaFill(fill, remaining) {
  setStyle(fill, 'width', typeof remaining === 'number' ? `${Math.min(100, Math.max(0, remaining * 100))}%` : '0%');
  setStyle(fill, 'background', quotaColor(remaining));
}

function renderQuota(window, prefix) {
  const bucket = group?.windows?.[window];
  const remaining = bucket?.remaining;
  setText($(`${prefix}-balance`), percent(remaining));
  const fill = $(`${prefix}-fill`), track = $(`${prefix}-track`);
  applyQuotaFill(fill, remaining);
  if (typeof remaining === 'number') { setAttr(track,'aria-valuenow',String(remaining * 100)); setAttr(track,'aria-valuemin','0'); setAttr(track,'aria-valuemax','100'); }
  else setAttr(track,'aria-valuenow',null);
  setText($(`${prefix}-reset`), language.resetDate(bucket?.resetAt));
  setText($(`${prefix}-note`), !bucket?.available ? t('noQuota') : bucket.disabled ? t('disabledQuota') : remaining === null ? t('noFraction') : t('sharedQuota')+' '+t('quotaSource'));
}

const treeState = new Map();
const detailState = new Set();
let lastTaskId = null;

function buildSubagentTree(items) {
  const map = new Map(), roots = [];
  for (const item of items) {
    map.set(item.id, { ...item, children: [] });
  }
  const hasAncestor = (childId, ancestorId) => {
    let curr = map.get(ancestorId);
    while (curr && curr.parentId) {
      if (curr.parentId === childId) return true;
      curr = map.get(curr.parentId);
    }
    return false;
  };
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId) && node.parentId !== node.id && !hasAncestor(node.id, node.parentId)) {
      map.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const subagentRefs = new WeakMap();
let lastSubagentsSig = null;

function subagentLabels() {
  return language.language === 'zh-CN'
    ? { expand: '展开子代理', collapse: '折叠子代理', toggleAria: '切换子代理列表', detailTitle: '查看指标明细', detailAria: '切换详情', count: n => String(n), countTitle: n => `${n} 个子代理` }
    : { expand: 'Expand subagents', collapse: 'Collapse subagents', toggleAria: 'Toggle subagents', detailTitle: 'View metric details', detailAria: 'Toggle details', count: n => String(n), countTitle: n => `${n} ${n === 1 ? 'subagent' : 'subagents'}` };
}

const SUBAGENT_STATUS_MAP = {
  IDLE: { kind: 'idle', key: 'subagentStatusIdle' },
  DONE: { kind: 'done', key: 'subagentStatusDone' },
  COMPLETED: { kind: 'done', key: 'subagentStatusDone' },
  COMPLETE: { kind: 'done', key: 'subagentStatusDone' },
  FINISHED: { kind: 'done', key: 'subagentStatusDone' },
  SUCCEEDED: { kind: 'done', key: 'subagentStatusDone' },
  RUNNING: { kind: 'running', key: 'subagentStatusRunning', running: true },
  WORKING: { kind: 'running', key: 'subagentStatusRunning', running: true },
  IN_PROGRESS: { kind: 'running', key: 'subagentStatusRunning', running: true },
  WAITING_FOR_USER: { kind: 'waiting', key: 'subagentStatusWaitingUser' },
  WAITING: { kind: 'waiting', key: 'subagentStatusWaiting' },
  PENDING: { kind: 'waiting', key: 'subagentStatusWaiting' },
  QUEUED: { kind: 'waiting', key: 'subagentStatusWaiting' },
  ERROR: { kind: 'error', key: 'subagentStatusError', error: true },
  FAILED: { kind: 'error', key: 'subagentStatusError', error: true },
  CANCELLED: { kind: 'stopped', key: 'subagentStatusStopped' },
  CANCELED: { kind: 'stopped', key: 'subagentStatusStopped' },
  ABORTED: { kind: 'stopped', key: 'subagentStatusStopped' },
  STOPPED: { kind: 'stopped', key: 'subagentStatusStopped' },
  UNSPECIFIED: { kind: 'unknown', key: 'subagentStatusUnknown' }
};

function classifySubagentStatus(raw) {
  const rawText = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  const norm = rawText.toUpperCase().replace(/^CASCADE_RUN_STATUS_/, '');
  const match = norm ? SUBAGENT_STATUS_MAP[norm] : null;
  const label = match
    ? t(match.key)
    : norm
      ? norm.toLowerCase().replace(/_/g, ' ').replace(/^\w/, ch => ch.toUpperCase())
      : t('subagentStatusUnknown');
  return { raw: rawText, label, kind: match ? match.kind : 'unknown', running: Boolean(match?.running), error: Boolean(match?.error) };
}

function formatSubagentContext(ctx) {
  const hasUsed = ctx && typeof ctx.usedTokens === 'number' && Number.isFinite(ctx.usedTokens);
  const hasFraction = ctx && typeof ctx.usedFraction === 'number' && Number.isFinite(ctx.usedFraction) && typeof ctx.maxTokens === 'number' && Number.isFinite(ctx.maxTokens) && ctx.maxTokens > 0;
  if (hasFraction) {
    const pctText = percent(ctx.usedFraction);
    const usedPct = (ctx.usedFraction * 100).toFixed(1);
    const remainingPct = Math.max(0, 100 - ctx.usedFraction * 100).toFixed(1);
    const tokText = t('contextTokens', { used: count(ctx.usedTokens), max: count(ctx.maxTokens) });
    const clamped = Math.max(0, Math.min(1, ctx.usedFraction));
    const dashoffset = String(Math.round((1 - clamped) * 1000) / 10);
    const color = ctx.usedFraction >= 0.9 ? 'var(--pulse-danger)' : ctx.usedFraction >= 0.8 ? 'var(--pulse-warning)' : '';
    const summary = `${t('contextUsed', { used: usedPct, remaining: remainingPct })} · ${tokText}`;
    return {
      available: true,
      dashoffset,
      color,
      label: `${t('subagentContext')}: ${summary}`,
      detail: `${pctText} · ${tokText}`
    };
  }
  const partialTokens = hasUsed ? t('contextTokens', { used: count(ctx.usedTokens), max: '—' }) : null;
  return {
    available: false,
    dashoffset: '100',
    color: '',
    label: partialTokens ? `${t('subagentContext')}: ${t('contextUnknown')} · ${partialTokens}` : `${t('subagentContext')}: ${t('contextUnknown')}`,
    detail: partialTokens || '—'
  };
}

function createSubagentNodeElement() {
  const nodeEl = document.createElement('div');
  nodeEl.className = 'subagent-tree-node';
  nodeEl.innerHTML = `<div class="subagent-item"><div class="subagent-summary" tabindex="0" role="button"><div class="subagent-left"><span class="tree-bullet">•</span><span class="subagent-name"></span><span class="subagent-status-dot" role="img"></span></div><div class="subagent-right"><span class="subagent-badge"></span><span class="subagent-tps"></span><span class="subagent-tokens"></span><span class="subagent-context-ring" role="img"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="subagent-context-track" cx="8" cy="8" r="5.3"></circle><circle class="subagent-context-fill" cx="8" cy="8" r="5.3" pathLength="100"></circle></svg></span><button class="detail-toggle-btn" type="button">ℹ</button></div></div><div class="subagent-detail" hidden><dl><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt></dt><dd></dd></div><div><dt>ID</dt><dd></dd></div></dl></div></div>`;
  const itemEl = nodeEl.firstElementChild;
  const summaryEl = itemEl.firstElementChild;
  const leftEl = summaryEl.firstElementChild;
  const rightEl = summaryEl.lastElementChild;
  const detailEl = itemEl.lastElementChild;
  const rows = [...detailEl.firstElementChild.children];
  const contextRingEl = rightEl.children[3];
  subagentRefs.set(nodeEl, {
    itemEl, summaryEl, leftEl,
    treeBtn: null, bullet: leftEl.children[0], nameEl: leftEl.children[1], statusDotEl: leftEl.children[2], childCountEl: null,
    badgeEl: rightEl.children[0], tpsEl: rightEl.children[1], tokensEl: rightEl.children[2],
    contextRingEl, contextRingFillEl: contextRingEl.firstElementChild.lastElementChild,
    detailBtn: rightEl.children[4],
    detailEl, childrenEl: null,
    dts: rows.map(r => r.firstElementChild), dds: rows.map(r => r.lastElementChild)
  });
  return nodeEl;
}

function syncSubagentNode(nodeEl, node, depth, existingNodes) {
  const refs = subagentRefs.get(nodeEl);
  const id = String(node.id);
  const hasChildren = Boolean(node.children?.length);
  const isTreeExpanded = treeState.has(id) ? treeState.get(id) : depth <= 1;
  const isDetailExpanded = detailState.has(id);
  const shortId = node.id ? node.id.slice(0, 8) : 'agent';
  const displayName = node.role || shortId;
  const model = node.model || 'Gemini';
  const tpsStr = node.tps !== null && node.tps !== undefined ? `${rate(node.tps)} tok/s` : '—';
  const tokStr = node.totalTokens !== null && node.totalTokens !== undefined ? `${compact(node.totalTokens)} tok` : '—';
  const latestTpsStr = node.latestRateStatus === 'unreliable' ? t('timingUnreliable') : node.latestRateStatus === 'legacy' ? t('ratePending') : node.latestTps !== null && node.latestTps !== undefined ? `${rate(node.latestTps)} tok/s` : '—';
  const ctxInfo = formatSubagentContext(node.context);
  const statusInfo = classifySubagentStatus(node.status);
  const labels = subagentLabels();

  nodeEl.dataset.id = id;
  refs.itemEl.classList.toggle('is-running', statusInfo.running);
  refs.itemEl.classList.toggle('is-error', statusInfo.error);
  refs.statusDotEl.dataset.status = statusInfo.kind;
  const statusTooltip = `${t('subagentStatus')}: ${statusInfo.label}${statusInfo.raw ? ` (${statusInfo.raw})` : ''}`;
  setAttr(refs.statusDotEl, 'title', statusTooltip);
  setAttr(refs.statusDotEl, 'aria-label', statusTooltip);
  refs.summaryEl.dataset.id = id;
  setAttr(refs.summaryEl, 'aria-expanded', String(isDetailExpanded));

  if (hasChildren && !refs.treeBtn) {
    const btn = document.createElement('button');
    btn.className = 'tree-toggle-btn';
    btn.type = 'button';
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#chevron"/></svg>';
    refs.bullet.replaceWith(btn);
    refs.bullet = null;
    refs.treeBtn = btn;
  } else if (!hasChildren && refs.treeBtn) {
    const bullet = document.createElement('span');
    bullet.className = 'tree-bullet';
    bullet.textContent = '•';
    refs.treeBtn.replaceWith(bullet);
    refs.treeBtn = null;
    refs.bullet = bullet;
  }

  if (hasChildren) {
    refs.treeBtn.dataset.id = id;
    setAttr(refs.treeBtn, 'aria-expanded', String(isTreeExpanded));
    setAttr(refs.treeBtn, 'title', isTreeExpanded ? labels.collapse : labels.expand);
    setAttr(refs.treeBtn, 'aria-label', labels.toggleAria);
    if (!refs.childCountEl) {
      const span = document.createElement('span');
      span.className = 'subagent-child-count';
      refs.leftEl.appendChild(span);
      refs.childCountEl = span;
    }
    setText(refs.childCountEl, labels.count(node.children.length));
    setAttr(refs.childCountEl, 'title', labels.countTitle(node.children.length));
  } else if (refs.childCountEl) {
    refs.childCountEl.remove();
    refs.childCountEl = null;
  }

  setText(refs.nameEl, displayName);
  setAttr(refs.nameEl, 'title', node.role ? `${node.role} (${id})` : id);
  setText(refs.badgeEl, model);
  setAttr(refs.badgeEl, 'title', model);
  setText(refs.tpsEl, tpsStr);
  setText(refs.tokensEl, tokStr);
  refs.contextRingEl.classList.toggle('is-unavailable', !ctxInfo.available);
  setAttr(refs.contextRingEl, 'title', ctxInfo.label);
  setAttr(refs.contextRingEl, 'aria-label', ctxInfo.label);
  setStyle(refs.contextRingFillEl, 'strokeDashoffset', ctxInfo.dashoffset);
  setStyle(refs.contextRingFillEl, 'stroke', ctxInfo.color);
  refs.detailBtn.dataset.id = id;
  setAttr(refs.detailBtn, 'title', labels.detailTitle);
  setAttr(refs.detailBtn, 'aria-label', labels.detailAria);
  setAttr(refs.detailBtn, 'aria-pressed', String(isDetailExpanded));

  if (!panelMotion.has(refs.detailEl)) setHidden(refs.detailEl, !isDetailExpanded);
  const dtTexts = [t('subagentModel'), t('subagentTPS'), t('latest'), t('subagentSteps'), t('subagentTokensDetail'), t('subagentContext'), t('subagentStatus')];
  for (let i = 0; i < dtTexts.length; i++) setText(refs.dts[i], dtTexts[i]);
  const ddTexts = [model, tpsStr, latestTpsStr, node.steps || 0, `${node.totalTokens !== null && node.totalTokens !== undefined ? count(node.totalTokens) : '—'} tok`, ctxInfo.detail, statusInfo.label, shortId];
  for (let i = 0; i < ddTexts.length; i++) setText(refs.dds[i], ddTexts[i]);
  setAttr(refs.dds[5], 'title', ctxInfo.label);
  setAttr(refs.dds[6], 'title', statusInfo.raw || null);
  setAttr(refs.dds[7], 'title', id);

  if (hasChildren) {
    if (!refs.childrenEl) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'subagent-children';
      nodeEl.appendChild(childrenDiv);
      refs.childrenEl = childrenDiv;
    }
    refs.childrenEl.dataset.parentId = id;
    if (!panelMotion.has(refs.childrenEl)) setHidden(refs.childrenEl, !isTreeExpanded);
    syncSubagentChildren(refs.childrenEl, node.children, depth + 1, existingNodes);
  } else if (refs.childrenEl) {
    refs.childrenEl.remove();
    refs.childrenEl = null;
  }
}

function syncSubagentChildren(containerEl, nodes, depth, existingNodes) {
  const desiredIds = new Set(nodes.map(n => String(n.id)));
  for (const child of [...containerEl.children]) {
    if (!child.classList?.contains('subagent-tree-node') || !desiredIds.has(child.dataset?.id)) child.remove();
  }
  let cursor = containerEl.firstElementChild;
  for (const node of nodes) {
    const id = String(node.id);
    let nodeEl = existingNodes.get(id);
    if (nodeEl) existingNodes.delete(id);
    else nodeEl = createSubagentNodeElement();
    syncSubagentNode(nodeEl, node, depth, existingNodes);
    if (nodeEl !== cursor) containerEl.insertBefore(nodeEl, cursor);
    else cursor = cursor.nextElementSibling;
  }
}

function toggleSubagentTree(id, animate = true) {
  const list = $('subagents-list');
  const escaped = CSS.escape(id);
  const childDiv = list?.querySelector(`.subagent-children[data-parent-id="${escaped}"]`);
  const btn = list?.querySelector(`.tree-toggle-btn[data-id="${escaped}"]`);
  if (!childDiv || !btn) return;
  const nextOpen = btn.getAttribute('aria-expanded') !== 'true';
  treeState.set(id, nextOpen);
  setExpandedState(childDiv, nextOpen, animate);
  const labels = subagentLabels();
  setAttr(btn, 'aria-expanded', String(nextOpen));
  setAttr(btn, 'title', nextOpen ? labels.collapse : labels.expand);
}

function toggleSubagentDetail(id, animate = true) {
  const list = $('subagents-list');
  const detailBtn = list?.querySelector(`.detail-toggle-btn[data-id="${CSS.escape(id)}"]`);
  const node = detailBtn?.closest('.subagent-tree-node');
  const detail = node?.querySelector(':scope > .subagent-item > .subagent-detail');
  const summary = node?.querySelector(':scope > .subagent-item > .subagent-summary');
  if (!detail) return;
  const nextOpen = !detailState.has(id);
  if (nextOpen) detailState.add(id); else detailState.delete(id);
  setExpandedState(detail, nextOpen, animate);
  setAttr(summary, 'aria-expanded', String(nextOpen));
  setAttr(detailBtn, 'aria-pressed', String(nextOpen));
}

const MODEL_COLORS = ['var(--pulse-accent)', 'var(--pulse-success)', 'var(--pulse-warning)', '#c084fc', '#38bdf8', '#fb7185'];
function assignModelColors(models) {
  const used = new Set(), map = new Map();
  models.forEach((m, idx) => {
    const key = typeof m === 'string' ? m : (m.name || m.id);
    if (!key || map.has(key)) return;
    const role = typeof m === 'string' ? null : m.role;
    let cIdx = role === 'plan' ? 0 : role === 'worker' ? 1 : role === 'subagent' ? 2 : idx % MODEL_COLORS.length;
    if (used.has(cIdx)) {
      cIdx = MODEL_COLORS.findIndex((_, k) => !used.has(k));
      if (cIdx < 0) cIdx = idx % MODEL_COLORS.length;
    }
    used.add(cIdx);
    map.set(key, MODEL_COLORS[cIdx]);
  });
  return map;
}
function roleLabel(role) {
  return role === 'plan' ? t('modelRolePlan')
    : role === 'worker' ? t('modelRoleWorker')
    : role === 'subagent' ? t('modelRoleSubagent')
    : t('modelRoleModel');
}
function metricValueOf(model, metric) {
  return metric === 'calls' ? (Number(model.requests) || 0)
    : metric === 'output' ? (Number(model.outputTokens) || 0)
    : (Number(model.totalTokens) || 0);
}
function updateModelMixFocus() {
  const svg = $('model-mix-svg'), list = $('model-mix-list'), wrap = $('model-mix-ring-wrap');
  if (!svg || !list) return;
  const focusId = mixHoverId || mixActiveId;
  const focused = focusId ? mixDisplayModels.find(m => m.id === focusId) : null;
  svg.classList.toggle('has-focus', Boolean(focused));
  for (const seg of svg.querySelectorAll('.model-mix-segment')) {
    seg.classList.toggle('is-active', Boolean(focused && seg.dataset.modelId === focused.id));
  }
  for (const row of list.querySelectorAll('.model-mix-row')) {
    const active = Boolean(focused && row.dataset.modelId === focused.id);
    row.classList.toggle('is-active', active);
    setAttr(row, 'aria-pressed', String(mixActiveId === row.dataset.modelId));
  }
  if (focused) {
    const pctText = `${Math.round(focused.share * 100)}%`;
    setText($('model-mix-center-value'), pctText);
    setText($('model-mix-center-label'), mixMetric === 'calls' ? t('modelCallsCount', { count: focused.value }) : `${compact(focused.value)} · ${focused.name}`);
    setAttr(wrap, 'title', `${focused.name} (${pctText})`);
  } else {
    const total = mixDisplayModels.reduce((sum, item) => sum + item.value, 0);
    setText($('model-mix-center-value'), mixMetric === 'calls' ? count(total) : compact(total));
    setText($('model-mix-center-label'), mixMetric === 'calls' ? t('modelCallsUnit') : t('modelMixModelsCount', { count: mixDisplayModels.length }));
    setAttr(wrap, 'title', '');
  }
}
function renderModelMix(speed) {
  const mixSection = $('panel-model-mix');
  if (!mixSection) return;
  const sessionUsage = speed?.modelUsage;
  const sessionModels = Array.isArray(sessionUsage?.models) ? sessionUsage.models : [];
  const taskUsage = speed?.taskUsage?.modelUsage;
  const taskModels = Array.isArray(taskUsage?.models) ? taskUsage.models : [];
  if (sessionModels.length < 2 && taskModels.length < 2) {
    setHidden(mixSection, true);
    lastMixSig = null;
    mixDisplayModels = [];
    return;
  }
  setHidden(mixSection, false);
  const hasSubagents = Boolean(speed?.taskUsage?.subagents > 0 && taskModels.length > 0);
  const scopeGroup = $('model-mix-scope');
  setHidden(scopeGroup, !hasSubagents);
  const effectiveScope = !hasSubagents ? 'session' : mixScopeManual ? mixScope : (sessionModels.length < 2 && taskModels.length >= 2 ? 'task' : mixScope);
  mixScope = effectiveScope;
  for (const btn of mixSection.querySelectorAll('[data-mix-scope]')) setAttr(btn, 'aria-pressed', String(btn.dataset.mixScope === effectiveScope));
  for (const btn of mixSection.querySelectorAll('[data-mix-metric]')) setAttr(btn, 'aria-pressed', String(btn.dataset.mixMetric === mixMetric));
  const rawModels = (effectiveScope === 'task' && taskModels.length ? taskModels : sessionModels).slice();
  rawModels.sort((a, b) => metricValueOf(b, mixMetric) - metricValueOf(a, mixMetric) || (b.totalTokens || 0) - (a.totalTokens || 0) || (b.requests || 0) - (a.requests || 0));
  const capped = rawModels.length > 6
    ? [...rawModels.slice(0, 5), rawModels.slice(5).reduce((acc, m) => ({
      id: '__other__', name: t('modelMixOther'), role: 'model',
      requests: acc.requests + (Number(m.requests) || 0),
      outputTokens: acc.outputTokens + (Number(m.outputTokens) || 0),
      totalTokens: acc.totalTokens + (Number(m.totalTokens) || 0)
    }), { id: '__other__', name: t('modelMixOther'), role: 'model', requests: 0, outputTokens: 0, totalTokens: 0 })]
    : rawModels;
  const sig = `${language.language}|${mixMetric}|${effectiveScope}|${hasSubagents}|${capped.map(m => `${m.id}:${m.name}:${m.role}:${m.requests}:${m.outputTokens}:${m.totalTokens}`).join('|')}`;
  if (sig === lastMixSig) { updateModelMixFocus(); return; }
  lastMixSig = sig;
  const colorMap = assignModelColors(capped);
  const totalMetric = capped.reduce((sum, m) => sum + metricValueOf(m, mixMetric), 0);
  mixDisplayModels = capped.map(m => {
    const val = metricValueOf(m, mixMetric);
    return { ...m, value: val, share: totalMetric > 0 ? val / totalMetric : 0, color: colorMap.get(m.name || m.id) || MODEL_COLORS[0] };
  });
  if (mixActiveId && !mixDisplayModels.some(m => m.id === mixActiveId)) mixActiveId = null;
  if (mixHoverId && !mixDisplayModels.some(m => m.id === mixHoverId)) mixHoverId = null;
  const segHost = $('model-mix-segments'), listHost = $('model-mix-list');
  if (segHost) {
    segHost.textContent = '';
    let offset = 0;
    for (const item of mixDisplayModels) {
      if (item.share <= 0) continue;
      const pct = item.share * 100;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'model-mix-segment');
      circle.setAttribute('cx', '19'); circle.setAttribute('cy', '19'); circle.setAttribute('r', '15.9154943');
      circle.setAttribute('pathLength', '100');
      circle.setAttribute('stroke', item.color);
      circle.setAttribute('stroke-dasharray', `${pct.toFixed(3)} ${Math.max(0, 100 - pct).toFixed(3)}`);
      circle.setAttribute('stroke-dashoffset', String(100 - offset));
      circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button');
      circle.setAttribute('aria-label', `${item.name} (${Math.round(pct)}%)`);
      circle.dataset.modelId = item.id;
      segHost.appendChild(circle);
      offset += pct;
    }
  }
  if (listHost) {
    listHost.textContent = '';
    for (const item of mixDisplayModels) {
      const pctText = `${Math.round(item.share * 100)}%`;
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'model-mix-row'; row.dataset.modelId = item.id;
      const statTok = mixMetric === 'output' ? item.outputTokens : item.totalTokens;
      setAttr(row, 'title', `${item.name} · ${roleLabel(item.role)} · ${count(item.totalTokens)} tok / ${count(item.outputTokens)} out / ${t('modelCallsCount', { count: item.requests || 0 })}`);
      const top = document.createElement('div'); top.className = 'model-mix-row-top';
      const left = document.createElement('span'); left.className = 'model-mix-row-id';
      const dot = document.createElement('span'); dot.className = 'model-mix-dot'; dot.style.background = item.color;
      const name = document.createElement('span'); name.className = 'model-mix-name'; name.textContent = item.name;
      const badge = document.createElement('span'); badge.className = 'model-mix-role'; badge.dataset.role = item.role || 'model'; badge.textContent = roleLabel(item.role);
      left.append(dot, name, badge);
      const share = document.createElement('span'); share.className = 'model-mix-share'; share.textContent = pctText;
      top.append(left, share);
      const stats = document.createElement('div'); stats.className = 'model-mix-stats';
      stats.textContent = `${compact(statTok)} tok · ${t('modelCallsCount', { count: item.requests || 0 })}`;
      row.append(top, stats);
      listHost.appendChild(row);
    }
  }
  updateModelMixFocus();
}

function renderTimelineStatus() {
  const el = $('timeline-status');
  if (!el) return;
  if (!timelineNoticeKey) { setHidden(el, true); setText(el, ''); el.classList.remove('is-error'); return; }
  setHidden(el, false);
  el.classList.toggle('is-error', timelineNoticeIsError);
  setText(el, t(timelineNoticeKey));
}
function formatDurationMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
}
function formatClock(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(language.language, { hour12: false }) : '';
}
function timelineEventLabel(node) {
  if (node.event === 'model_switch') return t('timelineEventModelSwitch');
  switch (node.kind) {
    case 'turn': return t('timelineEventTurn');
    case 'handoff': return t('timelineEventHandoff');
    case 'tool_group': return t('timelineEventToolGroup');
    case 'subagent': return t('timelineEventSubagent');
    case 'error': return t('timelineEventError');
    case 'phase':
    case 'model_call': return node.role === 'plan' ? t('timelineEventPlan') : node.role === 'worker' ? t('timelineEventWorker') : roleLabel(node.role);
    default: return node.event || node.kind || 'step';
  }
}
function timelineNodeSummary(node) {
  const meta = node.meta || {};
  if (node.kind === 'turn') {
    const turnPart = meta.turnIndex ? `#${meta.turnIndex}` : '';
    const spanPart = meta.stepStart != null ? `#${meta.stepStart}${meta.stepEnd != null && meta.stepEnd !== meta.stepStart ? `–${meta.stepEnd}` : ''}` : '';
    return [turnPart, spanPart].filter(Boolean).join(' · ') || node.event || '';
  }
  if (node.kind === 'handoff' || node.event === 'model_switch') {
    return `${meta.fromModel || '?'} \u2192 ${meta.toModel || node.model || '?'}`;
  }
  if (node.kind === 'tool_group') {
    const callsText = t('modelCallsCount', { count: meta.calls || 1 });
    return meta.category ? `${meta.category} · ${callsText}` : callsText;
  }
  if (node.kind === 'subagent') {
    const title = meta.role || node.model || '';
    return meta.status ? `${title} · ${meta.status}` : title;
  }
  const stepPrefix = meta.stepIndex != null ? `#${meta.stepIndex} ` : '';
  return `${stepPrefix}${node.model || node.event || ''}`.trim();
}
function showSwimlaneTip(idx) {
  const tip = $('timeline-lane-tip'), swimHost = $('timeline-swimlanes');
  if (swimHost) {
    for (const segEl of swimHost.querySelectorAll('.timeline-seg')) {
      segEl.classList.toggle('is-active', Number(segEl.dataset.segIdx) === idx);
    }
  }
  if (!tip) return;
  if (idx < 0 || idx >= lastTimelineRender.length) { setHidden(tip, true); setText(tip, ''); return; }
  const seg = lastTimelineRender[idx];
  const stepLabel = seg.stepStart != null ? `#${seg.stepStart}${seg.stepEnd != null && seg.stepEnd !== seg.stepStart ? `–${seg.stepEnd}` : ''}` : '';
  const durLabel = formatDurationMs((seg.endMs ?? 0) - (seg.startMs ?? 0));
  const callsLabel = seg.calls > 0 ? t('modelCallsCount', { count: seg.calls }) : '';
  setText(tip, [seg.model || seg.label, stepLabel, durLabel, callsLabel].filter(Boolean).join(' · '));
  setHidden(tip, false);
}
function createChevronSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#chevron');
  svg.appendChild(use);
  return svg;
}
function buildTimelineTreeNode(node, depth) {
  const el = document.createElement('div');
  el.className = 'timeline-node';
  el.dataset.kind = node.kind || 'step';
  el.dataset.nodeId = node.id || '';
  if (node.meta?.stepStart != null) el.dataset.stepStart = String(node.meta.stepStart);
  if (node.meta?.stepEnd != null) el.dataset.stepEnd = String(node.meta.stepEnd);
  if (node.meta?.stepIndex != null) el.dataset.stepIndex = String(node.meta.stepIndex);
  const children = Array.isArray(node.children) ? node.children : [];
  const hasChildren = children.length > 0;
  const collapsed = hasChildren && (timelineToggled.has(node.id) ? timelineToggled.get(node.id) : depth >= 2);
  const row = document.createElement('div');
  row.className = 'timeline-node-row';
  if (hasChildren) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'timeline-toggle-btn';
    toggleBtn.dataset.nodeId = node.id;
    setAttr(toggleBtn, 'aria-expanded', String(!collapsed));
    setAttr(toggleBtn, 'aria-label', timelineEventLabel(node));
    toggleBtn.appendChild(createChevronSvg());
    row.appendChild(toggleBtn);
  } else {
    const bullet = document.createElement('span'); bullet.className = 'timeline-bullet'; bullet.textContent = '·';
    row.appendChild(bullet);
  }
  const eventBadge = document.createElement('span');
  eventBadge.className = 'timeline-event-badge';
  eventBadge.textContent = timelineEventLabel(node);
  const main = document.createElement('div'); main.className = 'timeline-node-main';
  const summary = document.createElement('span'); summary.className = 'timeline-node-summary';
  const summaryText = timelineNodeSummary(node);
  summary.textContent = summaryText;
  if (summaryText) setAttr(summary, 'title', summaryText);
  main.append(eventBadge, summary);
  const badges = document.createElement('div'); badges.className = 'timeline-node-badges';
  if (node.model && node.kind !== 'handoff' && !summaryText.includes(node.model)) {
    const mChip = document.createElement('span'); mChip.className = 'timeline-chip'; mChip.textContent = node.model; setAttr(mChip, 'title', node.model); badges.appendChild(mChip);
  }
  const tokTotal = node.tokens?.totalTokens || node.tokens?.outputTokens || 0;
  if (tokTotal > 0) {
    const tChip = document.createElement('span'); tChip.className = 'timeline-chip'; tChip.textContent = `${compact(tokTotal)} tok`; badges.appendChild(tChip);
  }
  const dur = formatDurationMs(node.durationMs);
  if (dur) {
    const dChip = document.createElement('span'); dChip.className = 'timeline-chip'; dChip.textContent = dur; badges.appendChild(dChip);
  }
  const clk = formatClock(node.time);
  if (clk) {
    const cChip = document.createElement('span'); cChip.className = 'timeline-chip is-time'; cChip.textContent = clk; badges.appendChild(cChip);
  }
  row.append(main, badges);
  el.appendChild(row);
  if (hasChildren) {
    const kidsEl = document.createElement('div');
    kidsEl.className = 'timeline-children';
    kidsEl.hidden = collapsed;
    for (const child of children) kidsEl.appendChild(buildTimelineTreeNode(child, depth + 1));
    el.appendChild(kidsEl);
  }
  return el;
}
function renderTimeline(speed) {
  const offBar = $('timeline-off-bar'), panel = $('timeline-panel');
  const swimWrap = $('timeline-swimlanes-wrap'), swimEl = $('timeline-swimlanes'), treeEl = $('timeline-tree');
  if (!offBar || !panel || !swimEl || !treeEl) return;
  for (const btnId of ['timeline-enable-btn', 'timeline-disable-btn', 'timeline-clear-btn']) {
    const btn = $(btnId);
    if (btn) btn.disabled = timelineBusy;
  }
  renderTimelineStatus();
  if (!timelineEnabled) {
    setHidden(offBar, false);
    setHidden(panel, true);
    if (swimEl.children.length) swimEl.textContent = '';
    if (treeEl.children.length) treeEl.textContent = '';
    lastTimelineRender = [];
    lastTimelineSig = null;
    return;
  }
  setHidden(offBar, true);
  setHidden(panel, false);
  const tl = speed?.modelTimeline || null;
  const nodes = Array.isArray(tl?.nodes) ? tl.nodes : [];
  const swimlanes = Array.isArray(tl?.swimlanes) ? tl.swimlanes : [];
  const countEl = $('timeline-count');
  setText(countEl, String(nodes.length));
  setHidden(countEl, nodes.length === 0);
  setHidden($('timeline-truncated'), !tl?.truncated);
  setHidden($('timeline-empty'), nodes.length > 0 || swimlanes.length > 0);
  setHidden(swimWrap, swimlanes.length === 0);
  const sig = `${language.language}|${tl?.cascadeId || ''}|${tl?.savedAt || ''}|${Boolean(tl?.truncated)}|${JSON.stringify(swimlanes)}|${JSON.stringify(nodes)}`;
  if (sig === lastTimelineSig) return;
  lastTimelineSig = sig;
  const colorModels = [...(speed?.modelUsage?.models || []), ...swimlanes.map(s => ({ name: s.model || s.label, role: s.kind === 'plan' || s.kind === 'worker' || s.kind === 'subagent' ? s.kind : 'model' }))];
  const colorMap = assignModelColors(colorModels);
  swimEl.textContent = '';
  lastTimelineRender = [];
  showSwimlaneTip(-1);
  if (swimlanes.length > 0) {
    const tracks = [
      { key: 'plan', label: t('timelineLanePlan'), match: s => s.kind === 'plan' },
      { key: 'worker', label: t('timelineLaneWorker'), match: s => s.kind === 'worker' },
      { key: 'tools', label: t('timelineLaneToolsAgents'), match: s => s.kind === 'tool' || s.kind === 'subagent' || s.kind === 'handoff' }
    ];
    for (const trackDef of tracks) {
      const lane = document.createElement('div'); lane.className = 'timeline-lane'; lane.dataset.lane = trackDef.key;
      const lbl = document.createElement('span'); lbl.className = 'timeline-lane-label'; lbl.textContent = trackDef.label; setAttr(lbl, 'title', trackDef.label);
      const track = document.createElement('div'); track.className = 'timeline-track';
      for (const seg of swimlanes.filter(trackDef.match)) {
        const idx = lastTimelineRender.length;
        lastTimelineRender.push(seg);
        const leftPct = Math.min(98.5, Math.max(0, (Number(seg.startRatio) || 0) * 100));
        const widthPct = Math.min(100 - leftPct, Math.max(1.5, (Number(seg.widthRatio) || 0.02) * 100));
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'timeline-seg';
        btn.dataset.segIdx = String(idx); btn.dataset.kind = seg.kind || 'step';
        btn.style.left = `${leftPct.toFixed(2)}%`;
        btn.style.width = `${widthPct.toFixed(2)}%`;
        btn.style.background = seg.kind === 'handoff' ? 'var(--pulse-warning)' : (colorMap.get(seg.model || seg.label) || MODEL_COLORS[idx % MODEL_COLORS.length]);
        const tipLabel = [seg.model || seg.label, seg.stepStart != null ? `#${seg.stepStart}${seg.stepEnd != null && seg.stepEnd !== seg.stepStart ? `–${seg.stepEnd}` : ''}` : '', formatDurationMs((seg.endMs ?? 0) - (seg.startMs ?? 0))].filter(Boolean).join(' · ');
        setAttr(btn, 'title', tipLabel);
        setAttr(btn, 'aria-label', tipLabel);
        track.appendChild(btn);
      }
      lane.append(lbl, track);
      swimEl.appendChild(lane);
    }
  }
  treeEl.textContent = '';
  for (const node of nodes) treeEl.appendChild(buildTimelineTreeNode(node, 0));
}

function render() {
  if (!snapshot) return;
  const groups = snapshot.groups || [], speed = snapshot.speed;
  group = chooseGroup(groups, speed);
  const optionsKey = `${language.language}:${groups.map(g => g.id).join('|')}`;
  const select = $('quota-group');
  if (select.dataset.options !== optionsKey) {
    select.replaceChildren(...(groups.length ? groups.map(g => new Option(groupLabel(g),g.id)) : [new Option(t('unavailableQuota'),'')]));
    select.dataset.options = optionsKey;
  }
  if (group && select.value !== group.id) select.value = group.id;
  const groupText = group ? groupLabel(group) : '—';
  for (const element of groupNameNodes) setText(element, groupText);
  renderQuota('5h','five'); renderQuota('weekly','week');
  setText($('strip-tps'), rate(speed?.tps));
  setAttr($('speed-tab'), 'title', rate(speed?.tps)+' tok/s');
  setText($('session-tps'), speed?.latestRateStatus==='legacy'?t('ratePending'):`${rate(speed?.tps)} tok/s`);
  const latestDisplay = speed?.latestRateStatus === 'unreliable' ? t('timingUnreliable') : speed?.latestRateStatus === 'legacy' ? t('ratePending') : speed?.latestTps !== null && speed?.latestTps !== undefined ? `${rate(speed.latestTps)} tok/s` : '—';
  setText($('latest-tps'), latestDisplay);
  setText($('request-count'), t('sampleCount',{n:speed?.measuredRequests??0}));
  setText($('session-steps'), speed ? t('rounds',{rounds:speed.rounds,steps:speed.steps}).replace(/\s*·\s*$/, '') : '');
  const planModel = speed?.planModel || null;
  const activeModel = speed?.activeModel || null;
  const isHybrid = Boolean(planModel && activeModel && planModel !== activeModel);
  const modelText = isHybrid ? `${planModel} \u2192 ${activeModel}` : (speed?.model || t('waitingRequest'));
  setText($('strip-model'), modelText);
  setAttr($('strip-model'), 'title', modelText);
  setText($('model-time'), language.elapsed(speed?.modelSeconds));
  setText($('tool-time'), language.elapsed(speed?.toolSeconds));
  setText($('ttft'), language.elapsed(speed?.ttftSeconds));
  setText($('token-detail'), speed ? `${count(speed.counts.responseOutput)} / ${count(speed.counts.thinkingOutput)} tok` : '—');
  const savedNote=speed?.restoredFromHistory?' '+t('savedStats',{time:speed.savedAt?language.resetDate(speed.savedAt):'—'}):'';
  const saveWarning=snapshot.persistenceError?' '+t('saveFailed'):'';
  setText($('speed-basis'), language.rateNote(speed)+savedNote+saveWarning);
  setHidden($('speed-basis'), true);
  const cache=speed?.cache;
  const context=speed?.context,hasCapacity=typeof context?.usedFraction==='number';
  setText($('strip-context'), hasCapacity?`${Math.round(context.usedFraction*100)}%`:'—');
  setText($('strip-context-size'), context?`${compact(context.usedTokens)} / ${context.maxTokens===null?'—':compact(context.maxTokens)}`:'—');
  setAttr($('context-tab'), 'title', context?t('contextTokens',{used:count(context.usedTokens),max:context.maxTokens===null?'—':count(context.maxTokens)}):t('contextUnknown'));
  setText($('context-summary'), hasCapacity?t('contextUsed',{used:Math.round(context.usedFraction*100),remaining:Math.round(context.remainingFraction*100)}):t('contextUnknown'));
  setText($('context-tokens'), context?t('contextTokens',{used:compact(context.usedTokens),max:context.maxTokens===null?'—':compact(context.maxTokens)}):'—');
  setText($('context-model'), context?.model||activeModel||'—');
  const sessionModelCount = speed?.modelUsage?.models?.length || 0;
  const showOrchContext = isHybrid || sessionModelCount >= 2;
  setHidden($('context-orchestrator-row'), !showOrchContext);
  setHidden($('context-orchestrator-note'), !showOrchContext);
  if (showOrchContext) {
    setText($('context-orchestrator'), planModel || t('modelMixModelsCount', { count: sessionModelCount }));
    setText($('context-orchestrator-note'), t(isHybrid ? 'contextQuotaSplit' : 'contextMultiModelHint'));
  }
  const ctxFill = $('context-fill'), ctxTrack = $('context-track');
  setStyle(ctxFill, 'width', hasCapacity?`${Math.min(1,Math.max(0,context.usedFraction))*100}%`:'0%');
  setStyle(ctxFill, 'background', hasCapacity&&context.usedFraction>=.9?'var(--pulse-danger)':'');
  if(hasCapacity){setAttr(ctxTrack,'aria-valuenow',String(Math.min(100,context.usedFraction*100)));setAttr(ctxTrack,'aria-valuemin','0');setAttr(ctxTrack,'aria-valuemax','100');}else setAttr(ctxTrack,'aria-valuenow',null);
  setText($('strip-cache'), percent(cache?.hitRate));
  setText($('cache-rate'), percent(cache?.hitRate));
  const tokens=speed?.tokens || cache;
  // Coverage remains available in raw statistics and documented separately.
  const hasTotal=tokens?.measuredRequests&&Number.isSafeInteger(tokens.totalTokens)&&tokens.totalTokens>=0;
  setText($('strip-cache-total'), hasTotal?`${compact(tokens.totalTokens)} tok`:'— tok');
  const inputCoverage={uncachedTokens:'uncachedRequests',cachedTokens:'cachedRequests',cacheWriteTokens:'cacheWriteRequests'};
  for(const [field,id]of[['cachedTokens','cache-read'],['uncachedTokens','cache-miss'],['cacheWriteTokens','cache-write'],['outputTokens','cache-output']]) {
    const available=field==='outputTokens'?(tokens?.outputAvailable??(tokens?.outputRequests??tokens?.measuredRequests)):(tokens?.[inputCoverage[field]]??tokens?.inputRequests??tokens?.measuredRequests);
    const known=Number.isSafeInteger(tokens?.[field])&&tokens[field]>=0;
    setText($(id), available&&known?`${count(tokens[field])} tok`:'—');
  }
  setText($('cache-coverage'), hasTotal?`${count(tokens.totalTokens)} tok`:'— tok');
  setHidden($('cache-write-row'), !(tokens?.cacheWriteTokens>0));
  const task=speed?.taskUsage;
  if(task&&task.subagents>0){
    setHidden($('panel-task-tokens-row'), false);
    setHidden($('panel-subagent-tokens-row'), false);
    setText($('panel-task-total-tokens'), `${count(task.tokens?.totalTokens)} tok${task.state==='loading'?' ('+t('loading')+')':''}`);
    setText($('panel-subagent-tokens'), `${count(task.subagentTokens)} tok`);
    setText($('panel-subagent-tokens-label'), t('taskTokensSubagents',{count:task.subagents}));
  } else {
    setHidden($('panel-task-tokens-row'), true);
    setHidden($('panel-subagent-tokens-row'), true);
  }
  const activeConvId = speed?.modelTimeline?.cascadeId || speed?.conversationId || snapshot?.conversationId || null;
  if (activeConvId && activeConvId !== lastTaskId) {
    treeState.clear();
    detailState.clear();
    timelineToggled.clear();
    mixScopeManual = false;
    mixActiveId = null;
    mixHoverId = null;
    lastTaskId = activeConvId;
    lastSubagentsSig = null;
    lastMixSig = null;
    lastTimelineSig = null;
  }
  renderModelMix(speed);
  const subSection=$('subagents-section');
  if(subSection){
    if(task&&task.subagents>0){
      setHidden(subSection, false);
      setText($('subagents-count'), String(task.subagents));
      const list=$('subagents-list');
      const items=Array.isArray(task.items)?task.items:[];
      const currentConvId=speed?.conversationId||snapshot?.conversationId;
      const nextSig = items.length
        ? `${currentConvId || ''}|${language.language}|${items.map(i => `${i.id}\u0001${i.parentId ?? ''}\u0001${i.role ?? ''}\u0001${i.model ?? ''}\u0001${i.tps ?? ''}\u0001${i.latestTps ?? ''}\u0001${i.latestRateStatus ?? ''}\u0001${i.steps ?? 0}\u0001${i.totalTokens ?? ''}\u0001${i.context?.usedTokens ?? ''}\u0001${i.context?.maxTokens ?? ''}\u0001${i.context?.usedFraction ?? ''}\u0001${i.status ?? ''}`).join('\u0002')}`
        : `EMPTY|${language.language}`;
      if (nextSig !== lastSubagentsSig || list.children.length === 0) {
        lastSubagentsSig = nextSig;
        if (items.length) {
          const container = $('subagents-container');
          const savedScroll = container ? container.scrollTop : 0;
          const existingNodes = new Map();
          for (const el of list.querySelectorAll('.subagent-tree-node[data-id]')) existingNodes.set(el.dataset.id, el);
          syncSubagentChildren(list, buildSubagentTree(items), 1, existingNodes);
          if (container) container.scrollTop = savedScroll;
        } else {
          list.innerHTML = `<div class="subagent-empty">${escapeHtml(t('transcriptLoading'))}</div>`;
        }
      }
    }else{
      setHidden(subSection, true);
      lastSubagentsSig = null;
    }
  }
  renderTimeline(speed);
  setHidden($('cache-note'), true);
  const dot = $('connection-dot');
  const dotClass = `connection-dot ${snapshot.connection}`;
  if (dot && dot.className !== dotClass) dot.className = dotClass;
  setAttr(dot, 'title', t(snapshot.connection === 'live'?'live':snapshot.connection === 'stale'?'stale':'offline'));
  const timestamp = snapshot.quotaUpdatedAt ? new Date(snapshot.quotaUpdatedAt).toLocaleTimeString(language.language,{hour12:false}) : null;
  const healthNote = $('health-note');
  setText(healthNote, language.errorMessage(snapshot.error||snapshot.sessionError) || (timestamp ? t('health',{time:timestamp}) : t('firstUpdate')));
  healthNote.classList.toggle('warning', snapshot.connection !== 'live' || !!snapshot.sessionError);
  const integration = snapshot.integration;
  setText($('integration-note'), integration && !['mounted','disabled'].includes(integration.state)
    ? (language.language === 'zh-CN' ? '内嵌栏正在自动重连；此面板仍可查看统计。' : 'Inline widget is reconnecting automatically; statistics remain available in this panel.') : '');
  updateCountdowns();
}

function updateCountdowns() {
  const now = Date.now() + serverOffset;
  for (const [window,prefix] of [['5h','five'],['weekly','week']]) {
    const bucket = group?.windows?.[window];
    setText($(`${prefix}-countdown`), language.countdown(bucket?.resetAt,now));
    setText($(`${prefix}-summary-countdown`), language.countdown(bucket?.resetAt,now,true));
    setText($(`${prefix}-summary-balance`), percent(bucket?.remaining));
    applyQuotaFill($(`${prefix}-summary-fill`), bucket?.remaining);
    if (bucket?.resetAt && Date.parse(bucket.resetAt) <= now && snapshot?.connection === 'live' && now - lastExpiredRefresh > 30000) {
      lastExpiredRefresh = now; setTimeout(() => refresh(true),0);
    }
  }
}

function refreshBusy(busy){
  const button=$('refresh-button');setAttr(button,'aria-busy',String(busy));setAttr(button,'aria-disabled',String(busy));
  button.dataset.i18nAria=busy?'refreshing':'refreshStats';button.title=t(button.dataset.i18nAria);setAttr(button,'aria-label',button.title);
}
function refreshManually(){
  if(manualRequest)return;
  refreshBusy(true);const started=performance.now();
  manualRequest=(async()=>{
    try{if(pending)await refreshRequest;await refresh(true);}
    finally{
      const remaining=250-(performance.now()-started);
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
      refreshBusy(false);manualRequest=null;
    }
  })();
}
function refresh(force = false) {
  if (pending) return refreshRequest;
  pending = true;
  const reqTimelineEpoch = timelineEpoch;
  refreshRequest=(async()=>{
  try {
    const params = new URLSearchParams();
    if (host?.conversationId) params.set('conversationId',host.conversationId);
    if (force) params.set('force','1');
    const transport = host?.fetch ? host.fetch.bind(host) : fetch;
    const response = await transport(`/api/metrics?${params}`,{cache:'no-store'});
    if (!response.ok) throw new Error(t('panelUnavailable'));
    const value = await response.json();
    if (!['live','stale','offline'].includes(value.connection)) throw new Error(t('invalidData'));
    snapshot = value;
    if (Object.hasOwn(value,'theme')) {
      const themeKey = JSON.stringify(value.theme ?? null);
      if (themeKey !== lastThemeKey) { lastThemeKey = themeKey; themeController.setHostTheme(value.theme); }
    }
    if (value.preferences) {
      if (reqTimelineEpoch === timelineEpoch) {
        const nextTl = value.preferences.modelTimelineEnabled === true;
        if (nextTl !== timelineEnabled) {
          timelineEnabled = nextTl;
          lastTimelineSig = null;
        }
      }
      syncingFromRefresh = true;
      try { preferences.sync(value.preferences); } finally { syncingFromRefresh = false; }
    }
    if (timelineNoticeKey === 'timelineCleared' && value.speed?.modelTimeline?.nodes?.length > 0 && Date.now() - lastTimelineClearAt > 1200) {
      timelineNoticeKey = null; timelineNoticeIsError = false;
    }
    serverOffset = Date.parse(value.serverTime) - Date.now();
    if (!Number.isFinite(serverOffset)) serverOffset = 0;
    render();
  } catch (error) {
    if (snapshot) { snapshot.connection = 'stale'; snapshot.error = error.message; render(); }
    else { setText($('health-note'), language.errorMessage(error.message)); $('health-note').classList.add('warning'); }
  } finally {
    pending = false; refreshRequest=null;
    clearTimeout(timer); timer = setTimeout(refresh, document.hidden ? 10000 : 2200);
  }
  })();
  return refreshRequest;
}
async function setTimelineEnabled(next) {
  if (timelineBusy) return;
  timelineBusy = true;
  timelineNoticeKey = null; timelineNoticeIsError = false;
  const myEpoch = ++timelineEpoch;
  renderTimeline(snapshot?.speed);
  try {
    const updated = await preferenceRequest({ modelTimelineEnabled: Boolean(next) });
    if (myEpoch !== timelineEpoch) return;
    timelineEnabled = Boolean(updated?.modelTimelineEnabled ?? next);
    if (snapshot?.preferences) snapshot.preferences.modelTimelineEnabled = timelineEnabled;
    if (!timelineEnabled) timelineToggled.clear();
    lastTimelineSig = null;
    timelineBusy = false;
    renderTimeline(snapshot?.speed);
    if (pending && refreshRequest) await refreshRequest;
    await refresh(true);
  } catch {
    timelineBusy = false;
    timelineNoticeKey = 'timelineSaveFailed'; timelineNoticeIsError = true;
    renderTimeline(snapshot?.speed);
  }
}
async function clearTimelineData() {
  if (timelineBusy) return;
  timelineBusy = true;
  timelineNoticeKey = null; timelineNoticeIsError = false;
  ++timelineEpoch;
  renderTimeline(snapshot?.speed);
  const rawConvId = host?.conversationId || snapshot?.speed?.modelTimeline?.cascadeId || snapshot?.speed?.conversationId || null;
  const guidConvId = typeof rawConvId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawConvId) ? rawConvId : null;
  const payload = guidConvId ? { conversationId: guidConvId } : {};
  try {
    if (typeof window.agPulseHost?.clearTimeline === 'function') {
      const clearRes = await window.agPulseHost.clearTimeline(payload);
      if (clearRes && typeof clearRes === 'object' && clearRes.error) throw new Error(clearRes.error);
    } else {
      const transport = host?.fetch ? host.fetch.bind(host) : fetch;
      const res = await transport('/api/timeline/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('Clear failed');
    }
    lastTimelineClearAt = Date.now();
    timelineToggled.clear();
    if (snapshot?.speed) snapshot.speed.modelTimeline = { ...(snapshot.speed.modelTimeline || {}), swimlanes: [], nodes: [], truncated: false };
    lastTimelineSig = null;
    timelineNoticeKey = 'timelineCleared'; timelineNoticeIsError = false;
    timelineBusy = false;
    renderTimeline(snapshot?.speed);
    setTimeout(() => {
      if (timelineNoticeKey === 'timelineCleared') { timelineNoticeKey = null; renderTimelineStatus(); }
    }, 2800);
    if (pending && refreshRequest) await refreshRequest;
    await refresh(true);
  } catch {
    timelineBusy = false;
    timelineNoticeKey = 'timelineClearFailed'; timelineNoticeIsError = true;
    renderTimeline(snapshot?.speed);
  }
}
function focusTimelineNodeByStep(stepStart) {
  const treeEl = $('timeline-tree');
  if (!treeEl || stepStart == null) return;
  let targetNode = null;
  for (const el of treeEl.querySelectorAll('.timeline-node')) {
    const row = el.querySelector(':scope > .timeline-node-row');
    if (row) row.classList.remove('is-active');
    const idx = el.dataset.stepIndex != null ? Number(el.dataset.stepIndex) : null;
    const s = el.dataset.stepStart != null ? Number(el.dataset.stepStart) : null;
    const e = el.dataset.stepEnd != null ? Number(el.dataset.stepEnd) : null;
    if (idx === stepStart || (s != null && s === stepStart) || (s != null && e != null && stepStart >= s && stepStart <= e)) {
      if (!targetNode || idx === stepStart || s === stepStart) targetNode = el;
    }
  }
  if (!targetNode) return;
  let cur = targetNode.parentElement;
  while (cur && cur !== treeEl) {
    if (cur.classList.contains('timeline-children')) {
      cur.hidden = false;
      const parentNode = cur.closest('.timeline-node');
      if (parentNode?.dataset.nodeId) {
        timelineToggled.set(parentNode.dataset.nodeId, false);
        const btn = parentNode.querySelector(':scope > .timeline-node-row > .timeline-toggle-btn');
        setAttr(btn, 'aria-expanded', 'true');
      }
    }
    cur = cur.parentElement;
  }
  const activeRow = targetNode.querySelector(':scope > .timeline-node-row');
  if (activeRow) { activeRow.classList.add('is-active'); activeRow.scrollIntoView({ block: 'nearest' }); }
}
$('quota-group').addEventListener('change', event => { selectedGroup = event.target.value; localSet('ag-pulse-group',selectedGroup); render(); });
$('subagents-toggle')?.addEventListener('click',()=>{
  const toggle=$('subagents-toggle'),container=$('subagents-container');
  if(!toggle||!container)return;
  const expanded=toggle.getAttribute('aria-expanded')!=='true';
  setAttr(toggle,'aria-expanded',String(expanded));
  setExpandedState(container,expanded,true);
});
const subList=$('subagents-list');
subList?.addEventListener('click',e=>{
  const treeBtn=e.target.closest('.tree-toggle-btn');
  if(treeBtn){e.stopPropagation();toggleSubagentTree(treeBtn.dataset.id,true);return;}
  const detailBtn=e.target.closest('.detail-toggle-btn');
  if(detailBtn){e.stopPropagation();toggleSubagentDetail(detailBtn.dataset.id,true);return;}
  const summary=e.target.closest('.subagent-summary');
  if(!summary)return;
  if(summary.querySelector('.tree-toggle-btn'))toggleSubagentTree(summary.dataset.id,true);
  else toggleSubagentDetail(summary.dataset.id,true);
});
subList?.addEventListener('dblclick',e=>{
  if(e.target.closest('button'))return;
  const summary=e.target.closest('.subagent-summary');
  if(!summary)return;
  e.stopPropagation();
  toggleSubagentDetail(summary.dataset.id,true);
});
subList?.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const summary=e.target.closest('.subagent-summary');
  if(!summary||e.target!==summary)return;
  e.preventDefault();
  if(summary.querySelector('.tree-toggle-btn'))toggleSubagentTree(summary.dataset.id,true);
  else toggleSubagentDetail(summary.dataset.id,true);
});
const mixCard = $('panel-model-mix');
mixCard?.addEventListener('click', e => {
  const scopeBtn = e.target.closest('[data-mix-scope]');
  if (scopeBtn) { mixScope = scopeBtn.dataset.mixScope; mixScopeManual = true; lastMixSig = null; render(); return; }
  const metricBtn = e.target.closest('[data-mix-metric]');
  if (metricBtn) { mixMetric = metricBtn.dataset.mixMetric; lastMixSig = null; render(); return; }
  const modelTarget = e.target.closest('[data-model-id]');
  if (modelTarget) {
    const id = modelTarget.dataset.modelId;
    mixActiveId = mixActiveId === id ? null : id;
    updateModelMixFocus();
  }
});
mixCard?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const seg = e.target.closest('.model-mix-segment[data-model-id]');
  if (!seg) return;
  e.preventDefault();
  const id = seg.dataset.modelId;
  mixActiveId = mixActiveId === id ? null : id;
  updateModelMixFocus();
});
for (const focusHost of [$('model-mix-segments'), $('model-mix-list')]) {
  focusHost?.addEventListener('pointerover', e => {
    const item = e.target.closest('[data-model-id]');
    if (!item || mixHoverId === item.dataset.modelId) return;
    mixHoverId = item.dataset.modelId;
    updateModelMixFocus();
  });
  focusHost?.addEventListener('pointerleave', () => {
    if (!mixHoverId) return;
    mixHoverId = null;
    updateModelMixFocus();
  });
  focusHost?.addEventListener('focusin', e => {
    const item = e.target.closest('[data-model-id]');
    if (!item) return;
    mixHoverId = item.dataset.modelId;
    updateModelMixFocus();
  });
  focusHost?.addEventListener('focusout', e => {
    if (focusHost.contains(e.relatedTarget)) return;
    if (mixHoverId) { mixHoverId = null; updateModelMixFocus(); }
  });
}
let pinnedSwimlaneIdx = -1;
$('timeline-enable-btn')?.addEventListener('click', () => { void setTimelineEnabled(true); });
$('timeline-disable-btn')?.addEventListener('click', () => { pinnedSwimlaneIdx = -1; void setTimelineEnabled(false); });
$('timeline-clear-btn')?.addEventListener('click', () => { pinnedSwimlaneIdx = -1; void clearTimelineData(); });
const swimlanesEl = $('timeline-swimlanes');
swimlanesEl?.addEventListener('pointerover', e => {
  const seg = e.target.closest('.timeline-seg[data-seg-idx]');
  if (seg) showSwimlaneTip(Number(seg.dataset.segIdx));
});
swimlanesEl?.addEventListener('pointerleave', () => showSwimlaneTip(pinnedSwimlaneIdx));
swimlanesEl?.addEventListener('focusin', e => {
  const seg = e.target.closest('.timeline-seg[data-seg-idx]');
  if (seg) showSwimlaneTip(Number(seg.dataset.segIdx));
});
swimlanesEl?.addEventListener('focusout', e => {
  if (!swimlanesEl.contains(e.relatedTarget)) showSwimlaneTip(pinnedSwimlaneIdx);
});
swimlanesEl?.addEventListener('click', e => {
  const segEl = e.target.closest('.timeline-seg[data-seg-idx]');
  if (!segEl) return;
  const idx = Number(segEl.dataset.segIdx);
  pinnedSwimlaneIdx = pinnedSwimlaneIdx === idx ? -1 : idx;
  showSwimlaneTip(pinnedSwimlaneIdx >= 0 ? pinnedSwimlaneIdx : idx);
  const segData = lastTimelineRender[idx];
  if (segData?.stepStart != null) focusTimelineNodeByStep(segData.stepStart);
});
$('timeline-tree')?.addEventListener('click', e => {
  const row = e.target.closest('.timeline-node-row');
  const nodeEl = row?.closest('.timeline-node');
  const btn = row?.querySelector(':scope > .timeline-toggle-btn');
  const kids = nodeEl?.querySelector(':scope > .timeline-children');
  if (!btn || !kids || !nodeEl?.dataset.nodeId) return;
  const expanded = btn.getAttribute('aria-expanded') !== 'true';
  timelineToggled.set(nodeEl.dataset.nodeId, !expanded);
  setAttr(btn, 'aria-expanded', String(expanded));
  kids.hidden = !expanded;
});
$('refresh-button').addEventListener('click', refreshManually);
$('language-toggle').addEventListener('click',()=>{void preferences.toggle();});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('pagehide',()=>preferences.dispose());
window.addEventListener('pageshow',event=>{if(event.persisted)preferences=connectPreferences();});
setInterval(updateCountdowns,1000);
localize();
showCard('speed');
refresh();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initPanel,{once:true});
else initPanel();

// 生成 README 使用的纯矢量 SVG 界面示意图（零外部依赖，兼容 GitHub SVG 消毒规则，使用脱敏示例数据）。
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT_DIR, 'docs', 'assets');

const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// 配色令牌严格对齐 src/ui/theme/palettes.ts (dark) 与 src/ui/usage-modal/palette.ts
const C = {
  backdrop: '#17191d',
  frameBorder: '#2d323b',
  bg: '#1c1d1f',
  cardStart: '#2a2c2f',
  cardEnd: '#303235',
  composer: '#20242a',
  composerBorder: '#363b44',
  control: '#383b3f',
  controlBg: '#25272b',
  hover: '#292b2e',
  border: '#41454d',
  fg: '#e1e3e7',
  emphasis: '#dbe5ff',
  label: '#b8bdc5',
  muted: '#adb2ba',
  subtle: '#8b92a0',
  accent: '#85a8ff',
  eyebrow: '#9fb9ee',
  success: '#8bb19b',
  warning: '#d7b079',
  danger: '#e99b9b',
  ringTrack: '#565c67',
  track: '#2f3238',
  modelNeon: '#7ca2ff',
  modelSonnet: '#9b8cff',
  modelFlash: '#68c2b3',
  modelArgon: '#e0a96d',
};

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function estimateTextWidth(str, fontSize, weight = 400) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      w += fontSize * 1.02;
    } else if (ch === ' ') {
      w += fontSize * 0.3;
    } else if ('·.,:;!|ilI1/\\()[]'.includes(ch)) {
      w += fontSize * 0.34;
    } else if ('—–Wmw@%&$'.includes(ch)) {
      w += fontSize * 0.82;
    } else if (ch >= 'A' && ch <= 'Z') {
      w += fontSize * 0.68;
    } else {
      w += fontSize * 0.56;
    }
  }
  return weight >= 600 ? w * 1.04 : w;
}

function svgDoc(width, height, defs, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">\n  <defs>\n${defs}\n  </defs>\n${body}\n</svg>\n`;
}

function cardGradDefs() {
  return `    <linearGradient id="cardGrad" x1="0" y1="0" x2="0.85" y2="1">
      <stop offset="0%" stop-color="${C.cardStart}"/>
      <stop offset="100%" stop-color="${C.cardEnd}"/>
    </linearGradient>
    <radialGradient id="heroGlow" cx="0.18" cy="0.06" r="0.62">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.11"/>
      <stop offset="100%" stop-color="${C.backdrop}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="forecastStripe" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="${C.accent}" fill-opacity="0.28"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="${C.cardStart}" stroke-width="2.5"/>
    </pattern>
    <pattern id="forecastStripeWarn" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="6" height="6" fill="${C.warning}" fill-opacity="0.34"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="${C.cardStart}" stroke-width="2.5"/>
    </pattern>`;
}

function text(x, y, content, opts = {}) {
  const {
    size = 12,
    fill = C.fg,
    weight = 400,
    anchor = 'start',
    opacity,
    family = FONT_SANS,
    letterSpacing,
    tabular = false,
  } = opts;
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `fill="${fill}"`,
    `font-family="${family}"`,
    `font-size="${size}"`,
    weight !== 400 ? `font-weight="${weight}"` : '',
    anchor !== 'start' ? `text-anchor="${anchor}"` : '',
    opacity !== undefined ? `fill-opacity="${opacity}"` : '',
    letterSpacing !== undefined ? `letter-spacing="${letterSpacing}"` : '',
    tabular ? 'font-variant-numeric="tabular-nums"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `  <text ${attrs}>${esc(content)}</text>`;
}

function rect(x, y, w, h, opts = {}) {
  const {
    rx = 0,
    fill = 'none',
    fillOpacity,
    stroke,
    strokeWidth = 1,
    strokeOpacity,
  } = opts;
  const attrs = [
    `x="${x}"`,
    `y="${y}"`,
    `width="${w}"`,
    `height="${h}"`,
    rx ? `rx="${rx}"` : '',
    `fill="${fill}"`,
    fillOpacity !== undefined ? `fill-opacity="${fillOpacity}"` : '',
    stroke ? `stroke="${stroke}"` : '',
    stroke && strokeWidth !== 1 ? `stroke-width="${strokeWidth}"` : '',
    stroke && strokeOpacity !== undefined ? `stroke-opacity="${strokeOpacity}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `  <rect ${attrs}/>`;
}

function line(x1, y1, x2, y2, stroke = '#ffffff', opacity = 0.08, width = 1, dash = '') {
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  return `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}"${dashAttr}/>`;
}

function pill(x, y, label, toneColor, opts = {}) {
  const {
    fontSize = 10.5,
    weight = 600,
    height = 20,
    padX = 8,
    minW = 0,
    fillOpacity = 0.15,
    strokeOpacity = 0.34,
    rx = height / 2,
    fillColor = toneColor,
    textColor = toneColor,
    anchorRight = false,
  } = opts;
  const estW = Math.ceil(estimateTextWidth(label, fontSize, weight) + padX * 2);
  const w = Math.max(minW, estW);
  const left = anchorRight ? x - w : x;
  const baselineY = y + height * 0.68;
  return {
    width: w,
    left,
    svg: [
      rect(left, y, w, height, {
        rx,
        fill: fillColor,
        fillOpacity,
        stroke: toneColor,
        strokeOpacity,
      }),
      text(left + w / 2, baselineY, label, {
        size: fontSize,
        weight,
        fill: textColor,
        anchor: 'middle',
        tabular: true,
      }),
    ].join('\n'),
  };
}

function iconSvg(kind, x, y, color = C.label, size = 14) {
  const scale = size / 16;
  let paths = '';
  switch (kind) {
    case 'speed':
      paths = `<path d="M3 12a6 6 0 1 1 10 0M8 9l3-4" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'cache':
      paths = `<ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="${color}" stroke-width="1.35"/><path d="M3 4v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0" fill="none" stroke="${color}" stroke-width="1.35"/>`;
      break;
    case 'context':
      paths = `<circle cx="8" cy="8" r="5.6" fill="none" stroke="${color}" stroke-width="1.35"/><path d="M8 2.4V8l4.8 2.8" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'five':
      paths = `<circle cx="8" cy="8" r="5.6" fill="none" stroke="${color}" stroke-width="1.35"/><path d="M8 4.7v3.6l2.3 1.4" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>`;
      break;
    case 'week':
      paths = `<rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="none" stroke="${color}" stroke-width="1.35"/><path d="M5 2v3m6-3v3M3 7h10" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>`;
      break;
    case 'alert':
      paths = `<path d="M8 2.4 14 13H2L8 2.4ZM8 6.4v3.1m0 1.8h.01" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'add':
      paths = `<path d="M8 3v10M3 8h10" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
      break;
    case 'mic':
      paths = `<rect x="5.5" y="2" width="5" height="8" rx="2.5" fill="none" stroke="${color}" stroke-width="1.35"/><path d="M3.5 7.5v1a4.5 4.5 0 0 0 9 0v-1M8 13v2" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round"/>`;
      break;
    case 'send':
      paths = `<path d="M8 13V3.5m-4 4 4-4 4 4" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'refresh':
      paths = `<path d="M13 7a5 5 0 1 0-1.3 4.4M13 3v4H9" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
    case 'close':
      paths = `<path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
      break;
    case 'arrowRight':
      paths = `<path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      break;
  }
  return `  <g transform="translate(${x} ${y}) scale(${scale})">${paths}</g>`;
}

function progressRing(cx, cy, r, pct, strokeWidth = 2.4, color = C.accent) {
  const circ = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(circ, circ * pct));
  return [
    `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.ringTrack}" stroke-width="${strokeWidth}"/>`,
    `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${dash.toFixed(2)} ${circ.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`,
  ].join('\n');
}

function buildHeroSvg(lang) {
  const zh = lang === 'zh';
  const title = zh
    ? '每条请求、额度周期与折算成本，就在输入框旁。'
    : 'Every request, quota cycle, and cost — right beside your input.';
  const subtitle = zh
    ? '真实生成速率、本轮缓存命中、上下文四段拆解、额度线性耗尽预测，与逐条请求耗时日志。'
    : 'Weighted TPS, latest-turn cache hits, 4-part context breakdown, linear quota forecasts, and per-request logs.';
  const placeholder = zh
    ? '输入消息，@ 提及，/ 选择操作'
    : 'Ask anything, @ to mention, / for actions';
  const chips = [
    { icon: 'speed', label: '104.2 tok/s', color: C.fg, active: true },
    {
      icon: 'cache',
      label: zh ? '116.8M tok · 缓存命中 86.4%' : '116.8M tok · Cache hit 86.4%',
      color: C.fg,
    },
    {
      ring: 0.58,
      label: zh ? '上下文 58%' : 'Ctx 58%',
      color: C.fg,
    },
    {
      icon: 'alert',
      label: zh ? '等待中 18s' : 'Waiting 18s',
      color: C.warning,
      alertBg: true,
    },
  ];

  const out = [];
  out.push(rect(0.5, 0.5, 1199, 439, { rx: 18, fill: C.backdrop, stroke: C.frameBorder }));
  out.push(rect(0.5, 0.5, 1199, 439, { rx: 18, fill: 'url(#heroGlow)' }));

  out.push(text(52, 54, 'ANTIGRATIVE DASHBOARD · ENHANCED FORK', {
    size: 12,
    weight: 600,
    fill: C.eyebrow,
    letterSpacing: 1.5,
  }));
  out.push(text(52, 108, title, {
    size: zh ? 34 : 33,
    weight: 650,
    fill: '#f0f3f8',
    letterSpacing: -0.6,
  }));
  out.push(text(52, 146, subtitle, {
    size: 15.5,
    fill: '#a6b1c2',
  }));

  // 宿主输入框容器
  out.push(rect(52, 180, 1096, 148, {
    rx: 16,
    fill: C.composer,
    stroke: C.composerBorder,
    strokeWidth: 1.2,
  }));
  out.push(text(78, 224, placeholder, { size: 14, fill: '#8e97a5' }));
  out.push(line(74, 266, 1126, 266, '#ffffff', 0.06));

  // 输入框底部操作栏（与真实宿主拓扑一致）
  out.push(iconSvg('add', 76, 289, '#b9c1cd', 16));
  const modelLabel = 'Gemini 4 Neon (XHigh) ⌃';
  out.push(text(108, 302, modelLabel, { size: 12.5, weight: 500, fill: '#c7cfd9' }));
  const stripX = 108 + Math.ceil(estimateTextWidth(modelLabel, 12.5, 500)) + 16;
  out.push(line(stripX, 287, stripX, 307, '#ffffff', 0.1));

  let cx = stripX + 14;
  out.push(`  <circle cx="${cx}" cy="297" r="3" fill="${C.success}"/>`);
  cx += 12;

  for (const ch of chips) {
    const labelW = Math.ceil(estimateTextWidth(ch.label, 12, 500));
    const chipW = 10 + 16 + labelW + 12;
    if (ch.active) {
      out.push(rect(cx, 283, chipW, 28, { rx: 6, fill: C.hover, stroke: C.border, strokeOpacity: 0.7 }));
    } else if (ch.alertBg) {
      out.push(rect(cx, 283, chipW, 28, {
        rx: 6,
        fill: C.warning,
        fillOpacity: 0.14,
        stroke: C.warning,
        strokeOpacity: 0.3,
      }));
    }
    if (ch.ring !== undefined) {
      out.push(progressRing(cx + 15, 297, 6.2, ch.ring, 2.2, C.accent));
    } else {
      out.push(iconSvg(ch.icon, cx + 9, 290, ch.alertBg ? C.warning : C.muted, 14));
    }
    out.push(text(cx + 29, 301.5, ch.label, {
      size: 12,
      weight: 500,
      fill: ch.color,
      tabular: true,
    }));
    cx += chipW + 8;
  }

  // 右侧原生麦克风和发送按钮
  out.push(iconSvg('mic', 1054, 289, '#b9c1cd', 16));
  out.push(`  <circle cx="1104" cy="297" r="15" fill="#343c49"/>`);
  out.push(iconSvg('send', 1096, 289, '#d5dcea', 16));

  // 底部四项特性亮点条
  const highlights = zh
    ? [
        { label: '逐条请求日志（首字 · 总耗时 · TPS）', color: C.accent },
        { label: '周额度 / 5h 重置周期视图', color: C.success },
        { label: 'API 等效美元计费', color: C.warning },
        { label: 'Rust 原生引擎 & 多账号隔离', color: C.modelSonnet },
      ]
    : [
        { label: 'Per-Request Log (TTFT · Total · TPS)', color: C.accent },
        { label: 'Weekly & 5h Quota Reset Cycles', color: C.success },
        { label: 'API-Equivalent USD Cost', color: C.warning },
        { label: 'Rust Native Engine & Account Isolation', color: C.modelSonnet },
      ];
  let hx = 52;
  for (const item of highlights) {
    out.push(`  <circle cx="${hx + 4}" cy="364" r="3.5" fill="${item.color}"/>`);
    out.push(text(hx + 15, 368.5, item.label, { size: 12.5, fill: '#c2cee0', weight: 500 }));
    hx += Math.ceil(estimateTextWidth(item.label, 12.5, 500)) + 44;
  }

  out.push(line(52, 392, 1148, 392, '#ffffff', 0.08));
  out.push(text(
    52,
    416,
    zh
      ? '基于当前源码界面矢量绘制 · 适配 Antigravity Desktop / IDE / CLI (v2.21.1 – v2.34.0+)'
      : 'Pure SVG UI illustration · Built for Antigravity Desktop / IDE / CLI (v2.21.1 – v2.34.0+)',
    { size: 11, fill: '#7f8c9f' },
  ));
  out.push(text(1148, 416, zh ? '脱敏示例数据' : 'Synthetic sample data', {
    size: 11,
    fill: '#7f8c9f',
    anchor: 'end',
  }));

  return svgDoc(1200, 440, cardGradDefs(), out.join('\n'));
}

function buildFeatureCardsSvg(lang) {
  const zh = lang === 'zh';
  const out = [];
  out.push(rect(0.5, 0.5, 1199, 547, { rx: 16, fill: C.backdrop, stroke: C.frameBorder }));

  // 列宽 370，三栏间隙 21
  const cols = [24, 415, 806];
  const cardW = 370;

  // --- 卡片 1：Token 用量 + 本轮缓存命中 + 多模型占比环 + API 等效费用 ---
  {
    const x = cols[0];
    const y = 24;
    const h = 500;
    const innerL = x + 18;
    const innerR = x + cardW - 18;
    out.push(rect(x, y, cardW, h, { rx: 14, fill: 'url(#cardGrad)', stroke: C.border }));
    out.push(iconSvg('cache', innerL, y + 17, C.label, 15));
    out.push(text(innerL + 22, y + 29, zh ? 'Token 用量' : 'Token cache', { size: 13, weight: 600 }));
    out.push(text(innerR, y + 29, '116,855,341 tok', {
      size: 11,
      fill: C.muted,
      anchor: 'end',
      tabular: true,
    }));
    out.push(line(innerL, y + 44, innerR, y + 44, '#ffffff', 0.08));

    // 本轮真实缓存命中
    out.push(text(innerL, y + 66, zh ? '本轮缓存命中' : 'Latest-turn cache', {
      size: 11.5,
      fill: C.label,
    }));
    out.push(text(innerR, y + 66, zh ? '98.6% · 极佳' : '98.6% · Hot', {
      size: 11.5,
      weight: 600,
      fill: C.success,
      anchor: 'end',
      tabular: true,
    }));
    out.push(rect(innerL, y + 76, innerR - innerL, 4, { rx: 2, fill: '#ffffff', fillOpacity: 0.1 }));
    out.push(rect(innerL, y + 76, (innerR - innerL) * 0.986, 4, { rx: 2, fill: C.success }));
    out.push(text(
      innerL,
      y + 96,
      zh ? '首击 96.2% → 末次 99.1% · 2.3M / 2.4M tok' : 'First 96.2% → Last 99.1% · 2.3M / 2.4M tok',
      { size: 10.5, fill: C.muted, tabular: true },
    ));
    out.push(line(innerL, y + 110, innerR, y + 110, '#ffffff', 0.08));

    // 四行明细
    const rows = zh
      ? [
          ['缓存命中', '86.4%'],
          ['未缓存输入', '15,820,410 tok'],
          ['缓存读取', '100,492,180 tok'],
          ['输出', '542,751 tok'],
        ]
      : [
          ['Cache hit rate', '86.4%'],
          ['Uncached input', '15,820,410 tok'],
          ['Cache read', '100,492,180 tok'],
          ['Output', '542,751 tok'],
        ];
    rows.forEach(([k, v], idx) => {
      const ry = y + 132 + idx * 24;
      out.push(text(innerL, ry, k, { size: 11.5, fill: C.label }));
      out.push(text(innerR, ry, v, { size: 11.5, fill: C.fg, anchor: 'end', tabular: true }));
    });
    out.push(line(innerL, y + 220, innerR, y + 220, '#ffffff', 0.08));

    // 36px 多模型 SVG 环形分布（对应 model-mix-compact）
    out.push(text(innerL, y + 242, zh ? '模型占比' : 'Model mix', { size: 11.5, fill: C.label }));
    out.push(text(innerR, y + 242, zh ? '3 个模型' : '3 models', {
      size: 10.5,
      fill: C.muted,
      anchor: 'end',
    }));
    const dCx = innerL + 20;
    const dCy = y + 278;
    const r = 13;
    const circ = 2 * Math.PI * r;
    const slices = [
      { frac: 0.64, color: C.modelNeon, name: 'Gemini 4 Neon', pct: '64%' },
      { frac: 0.24, color: C.modelSonnet, name: 'Claude Sonnet 4.6', pct: '24%' },
      { frac: 0.12, color: C.modelFlash, name: 'Gemini 4 Flash', pct: '12%' },
    ];
    out.push(`  <circle cx="${dCx}" cy="${dCy}" r="${r}" fill="none" stroke="${C.track}" stroke-width="5"/>`);
    let accFrac = 0;
    for (const sl of slices) {
      const len = circ * sl.frac;
      const offset = -circ * accFrac;
      out.push(
        `  <circle cx="${dCx}" cy="${dCy}" r="${r}" fill="none" stroke="${sl.color}" stroke-width="5" stroke-dasharray="${len.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 ${dCx} ${dCy})"/>`,
      );
      accFrac += sl.frac;
    }
    slices.forEach((sl, idx) => {
      const ly = y + 266 + idx * 17;
      out.push(`  <circle cx="${innerL + 54}" cy="${ly - 3.5}" r="3" fill="${sl.color}"/>`);
      out.push(text(innerL + 63, ly, sl.name, { size: 10.5, fill: C.fg }));
      out.push(text(innerR, ly, sl.pct, { size: 10.5, fill: C.muted, anchor: 'end', tabular: true }));
    });
    out.push(line(innerL, y + 322, innerR, y + 322, '#ffffff', 0.08));

    // 今日 / 本月用量 + 等效 USD 费用（使用原生 tspan 保持跨平台字体间距精准）
    const col2X = innerL + 170;
    out.push(text(innerL, y + 344, zh ? '今日用量' : 'Today', { size: 10.5, fill: C.muted }));
    out.push(text(col2X, y + 344, zh ? '本月用量' : 'This month', { size: 10.5, fill: C.muted }));
    out.push(
      `  <text x="${innerL}" y="${y + 372}" font-family="${FONT_SANS}" font-variant-numeric="tabular-nums"><tspan font-size="22" font-weight="600" fill="${C.fg}">38.9M</tspan><tspan font-size="10" fill="${C.muted}"> Token</tspan></text>`,
    );
    out.push(
      `  <text x="${col2X}" y="${y + 372}" font-family="${FONT_SANS}" font-variant-numeric="tabular-nums"><tspan font-size="22" font-weight="600" fill="${C.fg}">864.8M</tspan><tspan font-size="10" fill="${C.muted}"> Token</tspan></text>`,
    );
    out.push(text(innerL, y + 394, '≈ $58.40', { size: 11, weight: 500, fill: C.success, tabular: true }));
    out.push(text(col2X, y + 394, '≈ $542.60', { size: 11, weight: 500, fill: C.success, tabular: true }));

    out.push(line(innerL, y + 414, innerR, y + 414, '#ffffff', 0.08));
    out.push(text(innerL, y + 452, zh ? '查看用量统计' : 'View token usage', {
      size: 11.5,
      fill: C.label,
    }));
    out.push(iconSvg('arrowRight', innerR - 14, y + 440, C.muted, 14));
  }

  // --- 卡片 2：四段上下文拆解 + 额度线性耗尽预测与节奏徽章 ---
  {
    const x = cols[1];
    const y = 24;
    const h = 500;
    const innerL = x + 18;
    const innerR = x + cardW - 18;
    const trackW = innerR - innerL;
    out.push(rect(x, y, cardW, h, { rx: 14, fill: 'url(#cardGrad)', stroke: C.border }));
    out.push(iconSvg('context', innerL, y + 17, C.label, 15));
    out.push(text(innerL + 22, y + 29, zh ? '上下文窗口' : 'Context window', { size: 13, weight: 600 }));
    out.push(pill(innerR, y + 15, zh ? '压缩后动态估算' : 'Post-compact est.', C.accent, {
      fontSize: 9.5,
      height: 18,
      padX: 7,
      anchorRight: true,
    }));
    out.push(line(innerL, y + 44, innerR, y + 44, '#ffffff', 0.08));

    out.push(text(innerL, y + 68, zh ? '已用 58% · 剩余 42%' : '58% used · 42% left', {
      size: 16,
      weight: 600,
      fill: C.fg,
      tabular: true,
    }));
    out.push(text(innerL, y + 86, '296,960 / 512,000 tok · Gemini 4 Neon (XHigh)', {
      size: 11,
      fill: C.muted,
      tabular: true,
    }));
    out.push(rect(innerL, y + 96, trackW, 5, { rx: 2.5, fill: '#ffffff', fillOpacity: 0.1 }));
    out.push(rect(innerL, y + 96, trackW * 0.58, 5, { rx: 2.5, fill: C.accent }));

    // 上下文四段拆解条 + 2x2 图例
    out.push(text(innerL, y + 122, zh ? '上下文构成拆解' : 'Context breakdown', {
      size: 10.5,
      fill: C.muted,
    }));
    const segs = [
      { frac: 0.32, color: C.muted, label: zh ? '基线' : 'Baseline', val: '94.2K' },
      { frac: 0.49, color: C.accent, label: zh ? '工具读取' : 'Reads', val: '148.6K' },
      { frac: 0.13, color: C.warning, label: zh ? '思考' : 'Thinking', val: '38.4K' },
      { frac: 0.06, color: C.success, label: zh ? '输出' : 'Output', val: '15.8K' },
    ];
    let sx = innerL;
    segs.forEach((sg, idx) => {
      const sw = idx === segs.length - 1 ? innerR - sx : Math.round(trackW * sg.frac) - 1;
      out.push(rect(sx, y + 130, sw, 6, { rx: 2, fill: sg.color }));
      sx += sw + 2;
    });
    segs.forEach((sg, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const lx = innerL + col * 172;
      const ly = y + 153 + row * 19;
      out.push(rect(lx, ly - 7, 7, 7, { rx: 2, fill: sg.color }));
      out.push(text(lx + 12, ly, sg.label, { size: 10.5, fill: C.label }));
      out.push(text(lx + 160, ly, sg.val, {
        size: 10.5,
        weight: 500,
        fill: C.fg,
        anchor: 'end',
        tabular: true,
      }));
    });

    out.push(line(innerL, y + 188, innerR, y + 188, '#ffffff', 0.08));

    // 额度组标题 + 消耗节奏徽章 + 组切换器
    const quotaHeadingText = zh ? '共享额度' : 'Quota group';
    const quotaHeadingW = Math.ceil(estimateTextWidth(quotaHeadingText, 12, 600));
    out.push(text(innerL, y + 212, quotaHeadingText, { size: 12, weight: 600 }));
    const paceLabel = zh ? '● 偏紧' : '● Tight';
    out.push(
      pill(innerL + quotaHeadingW + 10, y + 198, paceLabel, C.warning, {
        fontSize: 10,
        height: 19,
        padX: 8,
      }).svg,
    );
    out.push(rect(innerR - 80, y + 197, 80, 22, { rx: 5, fill: C.control }));
    out.push(text(innerR - 40, y + 212, 'Gemini ▾', {
      size: 10.5,
      fill: '#c2c7d1',
      anchor: 'middle',
    }));

    // 5 小时额度（实际余额 68% + 斜纹线性预测 44%）
    out.push(iconSvg('five', innerL, y + 230, C.label, 14));
    out.push(text(innerL + 20, y + 241, zh ? '5 小时额度' : '5-hour quota', { size: 11.5, fill: C.fg }));
    out.push(text(innerR - 36, y + 241, '68%', {
      size: 13.5,
      weight: 600,
      fill: C.fg,
      anchor: 'end',
      tabular: true,
    }));
    out.push(text(innerR, y + 241, zh ? '剩余' : 'left', {
      size: 11,
      fill: C.muted,
      anchor: 'end',
    }));
    out.push(rect(innerL, y + 250, trackW, 6, { rx: 3, fill: '#ffffff', fillOpacity: 0.1 }));
    out.push(rect(innerL + trackW * 0.44, y + 250, trackW * 0.24, 6, { rx: 3, fill: 'url(#forecastStripe)' }));
    out.push(rect(innerL, y + 250, trackW * 0.44, 6, { rx: 3, fill: C.accent }));
    out.push(text(
      innerL,
      y + 271,
      zh ? '线性预测 · 按当前速率约 2h 15m 触底' : 'Linear forecast · ~2h 15m left at current pace',
      { size: 10.5, fill: C.accent },
    ));
    out.push(text(innerL, y + 290, zh ? '本周期已观测' : 'Window observed', { size: 11, fill: C.label }));
    out.push(text(innerR, y + 290, '42.8M tok', { size: 11, fill: C.fg, anchor: 'end', tabular: true }));
    out.push(text(innerL, y + 308, zh ? '距离重置' : 'Resets in', { size: 11, fill: C.label }));
    out.push(text(innerR, y + 308, zh ? '3h 42m (19:30)' : '3h 42m (19:30)', {
      size: 11,
      fill: C.fg,
      anchor: 'end',
      tabular: true,
    }));

    out.push(line(innerL, y + 324, innerR, y + 324, '#ffffff', 0.08));

    // 周额度（实际余额 41% + 橙黄斜纹线性预测 22%）
    out.push(iconSvg('week', innerL, y + 338, C.label, 14));
    out.push(text(innerL + 20, y + 349, zh ? '每周额度' : 'Weekly quota', { size: 11.5, fill: C.fg }));
    out.push(text(innerR - 36, y + 349, '41%', {
      size: 13.5,
      weight: 600,
      fill: C.warning,
      anchor: 'end',
      tabular: true,
    }));
    out.push(text(innerR, y + 349, zh ? '剩余' : 'left', {
      size: 11,
      fill: C.muted,
      anchor: 'end',
    }));
    out.push(rect(innerL, y + 358, trackW, 6, { rx: 3, fill: '#ffffff', fillOpacity: 0.1 }));
    out.push(rect(innerL + trackW * 0.22, y + 358, trackW * 0.19, 6, { rx: 3, fill: 'url(#forecastStripeWarn)' }));
    out.push(rect(innerL, y + 358, trackW * 0.22, 6, { rx: 3, fill: C.warning }));
    out.push(text(
      innerL,
      y + 379,
      zh ? '预计在重置前约 1 天 14 小时提前用尽' : 'Projected ~1d 14h before weekly reset',
      { size: 10.5, fill: C.warning },
    ));
    out.push(text(innerL, y + 398, zh ? '本周期已观测' : 'Window observed', { size: 11, fill: C.label }));
    out.push(text(innerR, y + 398, '214.6M tok', { size: 11, fill: C.fg, anchor: 'end', tabular: true }));
    out.push(text(innerL, y + 416, zh ? '距离重置' : 'Resets in', { size: 11, fill: C.label }));
    out.push(text(innerR, y + 416, zh ? '2 天 18 小时 (11/27)' : '2d 18h (11/27)', {
      size: 11,
      fill: C.fg,
      anchor: 'end',
      tabular: true,
    }));

    out.push(line(innerL, y + 438, innerR, y + 438, '#ffffff', 0.08));
    out.push(text(innerL, y + 468, zh ? '显示语言' : 'Language', { size: 10.5, fill: C.muted }));
    out.push(rect(innerR - 122, y + 451, 122, 24, { rx: 6, fill: C.control }));
    out.push(rect(innerR - (zh ? 60 : 120), y + 453, 58, 20, { rx: 4, fill: C.selected || '#444950' }));
    out.push(text(innerR - 91, y + 467, 'English', {
      size: 10,
      fill: zh ? C.muted : C.fg,
      weight: zh ? 400 : 600,
      anchor: 'middle',
    }));
    out.push(text(innerR - 31, y + 467, '简体中文', {
      size: 10,
      fill: zh ? C.fg : C.muted,
      weight: zh ? 600 : 400,
      anchor: 'middle',
    }));
  }

  // --- 卡片 3 上半部分：会话统计 + 本轮汇总 ---
  {
    const x = cols[2];
    const y = 24;
    const h = 308;
    const innerL = x + 18;
    const innerR = x + cardW - 18;
    out.push(rect(x, y, cardW, h, { rx: 14, fill: 'url(#cardGrad)', stroke: C.border }));
    out.push(iconSvg('speed', innerL, y + 17, C.label, 15));
    out.push(text(innerL + 22, y + 29, zh ? '会话统计' : 'Session statistics', { size: 13, weight: 600 }));
    out.push(text(innerR, y + 29, zh ? '42 次采样' : '42 samples', {
      size: 10.5,
      fill: C.muted,
      anchor: 'end',
    }));
    out.push(line(innerL, y + 44, innerR, y + 44, '#ffffff', 0.08));

    const speedRows = zh
      ? [
          ['模型用时', '12m 44s'],
          ['工具用时', '4m 18s'],
          ['平均首 Token (TTFT)', '9.4s'],
          ['会话加权速率', '88.4 tok/s'],
          ['最近一次请求', '104.2 tok/s'],
        ]
      : [
          ['Model time', '12m 44s'],
          ['Tool time', '4m 18s'],
          ['Avg TTFT', '9.4s'],
          ['Session TPS', '88.4 tok/s'],
          ['Last request', '104.2 tok/s'],
        ];
    speedRows.forEach(([k, v], idx) => {
      const ry = y + 66 + idx * 21;
      out.push(text(innerL, ry, k, { size: 11.5, fill: C.label }));
      out.push(text(innerR, ry, v, {
        size: 11.5,
        weight: idx >= 3 ? 600 : 400,
        fill: idx === 4 ? C.emphasis : C.fg,
        anchor: 'end',
        tabular: true,
      }));
    });

    out.push(line(innerL, y + 168, innerR, y + 168, '#ffffff', 0.08));
    out.push(text(innerL, y + 188, zh ? '本轮交互汇总' : 'Current turn', { size: 11.5, weight: 600 }));
    out.push(text(innerR, y + 188, zh ? '已结算' : 'Settled', {
      size: 10.5,
      fill: C.success,
      anchor: 'end',
    }));

    const turnRows = zh
      ? [
          ['本轮总耗时', '42.6s'],
          ['模型调用次数', '6 次'],
          ['思考 / 回复输出', '14.2K / 3.8K tok'],
        ]
      : [
          ['Turn duration', '42.6s'],
          ['Model requests', '6'],
          ['Think / Response', '14.2K / 3.8K tok'],
        ];
    turnRows.forEach(([k, v], idx) => {
      const ry = y + 209 + idx * 20;
      out.push(text(innerL, ry, k, { size: 11, fill: C.label }));
      out.push(text(innerR, ry, v, { size: 11, fill: C.fg, anchor: 'end', tabular: true }));
    });

    out.push(line(innerL, y + 266, innerR, y + 266, '#ffffff', 0.08));
    out.push(text(innerL, y + 291, zh ? '打开侧边栏' : 'Open sidebar', { size: 11.5, fill: C.label }));
    out.push(iconSvg('arrowRight', innerR - 14, y + 279, C.muted, 14));
  }

  // --- 卡片 3 下半部分：请求异常与长等待告警胶囊详情卡 ---
  {
    const x = cols[2];
    const y = 348;
    const h = 176;
    const innerL = x + 18;
    const innerR = x + cardW - 18;
    out.push(rect(x, y, cardW, h, { rx: 14, fill: 'url(#cardGrad)', stroke: C.border }));
    out.push(iconSvg('alert', innerL, y + 16, C.warning, 15));
    out.push(text(innerL + 22, y + 28, zh ? '请求告警与等待状态' : 'Request & wait alerts', {
      size: 13,
      weight: 600,
    }));
    out.push(line(innerL, y + 42, innerR, y + 42, '#ffffff', 0.08));

    out.push(pill(innerL, y + 52, 'HTTP 429', C.danger, { fontSize: 10, height: 19, padX: 7 }).svg);
    out.push(text(innerR, y + 65, zh ? '第 2 次自动重试 · 4s' : 'Retry #2 · 4s', {
      size: 10.5,
      fill: C.muted,
      anchor: 'end',
      tabular: true,
    }));
    out.push(text(
      innerL,
      y + 88,
      zh ? '触发上游限流，系统正在退避重连' : 'Upstream rate limit; backing off automatically',
      { size: 11, fill: C.fg },
    ));
    out.push(rect(innerL, y + 98, innerR - innerL, 24, { rx: 6, fill: '#ffffff', fillOpacity: 0.06 }));
    out.push(text(innerL + 8, y + 113.5, 'status=429 RESOURCE_EXHAUSTED · backoff=4000ms', {
      size: 9.8,
      fill: C.muted,
      family: FONT_MONO,
    }));

    out.push(line(innerL, y + 132, innerR, y + 132, '#ffffff', 0.08));
    const waitPill = pill(innerL, y + 143, zh ? '长等待' : 'Waiting', C.warning, {
      fontSize: 10,
      height: 19,
      padX: 7,
    });
    out.push(waitPill.svg);
    out.push(text(
      waitPill.left + waitPill.width + 10,
      y + 156,
      zh ? '工具执行等待已达 18s' : 'Tool step waiting (18s)',
      { size: 11, fill: C.label },
    ));
  }

  return svgDoc(1200, 548, cardGradDefs(), out.join('\n'));
}

function buildModalChrome(out, width, height, lang, activeTab) {
  const zh = lang === 'zh';
  out.push(rect(0.5, 0.5, width - 1, height - 1, { rx: 16, fill: C.backdrop, stroke: C.frameBorder }));
  out.push(rect(16, 16, width - 32, height - 32, { rx: 16, fill: C.bg, stroke: C.border }));

  // Header
  const left = 44;
  const right = width - 44;
  out.push(text(left, 44, 'ANTIGRATIVE DASHBOARD', {
    size: 10,
    fill: C.muted,
    letterSpacing: 1.7,
  }));
  out.push(text(left, 72, zh ? '用量统计' : 'Token usage', {
    size: 22,
    weight: 600,
    fill: C.fg,
    letterSpacing: -0.5,
  }));
  out.push(`  <circle cx="${left + 3}" cy="87" r="2.8" fill="${C.success}"/>`);
  out.push(text(left + 12, 91, zh ? '本机 Antigravity · 本地账本' : 'Local Antigravity · Usage ledger', {
    size: 11.5,
    fill: C.muted,
  }));

  // 顶部动作按钮组：+ 录入远程用量 | 中/EN | 刷新 | $ | Aa | 关闭
  const btnSize = 30;
  const btnY = 40;
  let rx = right - btnSize;
  out.push(rect(rx, btnY, btnSize, btnSize, { rx: 8, stroke: C.border }));
  out.push(iconSvg('close', rx + 7, btnY + 7, C.muted, 16));
  rx -= btnSize + 8;

  out.push(rect(rx, btnY, btnSize, btnSize, { rx: 8, stroke: C.border }));
  out.push(text(rx + btnSize / 2, btnY + 19, 'Aa', { size: 11.5, weight: 700, fill: C.muted, anchor: 'middle' }));
  rx -= btnSize + 8;

  out.push(rect(rx, btnY, btnSize, btnSize, {
    rx: 8,
    fill: C.accent,
    fillOpacity: 0.12,
    stroke: C.accent,
    strokeOpacity: 0.45,
  }));
  out.push(text(rx + btnSize / 2, btnY + 19.5, '$', { size: 13, weight: 700, fill: C.accent, anchor: 'middle' }));
  rx -= btnSize + 8;

  out.push(rect(rx, btnY, btnSize, btnSize, { rx: 8, stroke: C.border }));
  out.push(iconSvg('refresh', rx + 7, btnY + 7, C.muted, 16));
  rx -= btnSize + 8;

  out.push(rect(rx, btnY, btnSize, btnSize, { rx: 8, stroke: C.border }));
  out.push(text(rx + btnSize / 2, btnY + 19, zh ? 'EN' : '中', {
    size: 11,
    weight: 600,
    fill: C.muted,
    anchor: 'middle',
  }));
  rx -= 12;

  const manualText = zh ? '录入远程用量' : 'Remote Usage';
  const manualW = Math.ceil(estimateTextWidth(manualText, 11, 500)) + 34;
  out.push(rect(rx - manualW, btnY, manualW, btnSize, { rx: 8, fill: C.controlBg, stroke: C.border }));
  out.push(iconSvg('add', rx - manualW + 10, btnY + 8, C.fg, 14));
  out.push(text(rx - manualW + 27, btnY + 19, manualText, { size: 11, weight: 500, fill: C.fg }));

  // Tabs row
  const tabY = 122;
  const tabs = [
    { key: 'overview', label: zh ? '活动概览' : 'Activity' },
    { key: 'details', label: zh ? '用量详情' : 'Usage details' },
    { key: 'logs', label: zh ? '请求日志' : 'Request log' },
  ];
  let tx = left;
  for (const tb of tabs) {
    const active = tb.key === activeTab;
    const tw = Math.ceil(estimateTextWidth(tb.label, 13, active ? 600 : 400)) + 6;
    out.push(text(tx + 2, tabY, tb.label, {
      size: 13,
      weight: active ? 600 : 400,
      fill: active ? C.fg : C.muted,
    }));
    if (active) {
      out.push(rect(tx, tabY + 10, tw, 2, { fill: C.accent }));
    }
    tx += tw + 22;
  }

  // 右侧多账号切换器（严格使用虚构匿名邮箱）
  const accText = 'dev@example.com ▾';
  const accW = Math.ceil(estimateTextWidth(accText, 11)) + 20;
  out.push(rect(right - accW, tabY - 19, accW, 24, { rx: 6, fill: C.controlBg, stroke: C.border }));
  out.push(text(right - accW / 2, tabY - 3, accText, { size: 11, fill: C.fg, anchor: 'middle' }));
  out.push(line(left, tabY + 12, right, tabY + 12, '#ffffff', 0.08));
}

function buildRequestLogsSvg(lang) {
  const zh = lang === 'zh';
  const width = 1200;
  const height = 660;
  const left = 44;
  const right = width - 44;
  const out = [];

  buildModalChrome(out, width, height, lang, 'logs');

  // 工具栏：左日期分段按钮 + 右模型/缓存筛选下拉
  const toolY = 148;
  const ranges = [
    { label: zh ? '今日' : 'Today', active: true },
    { label: zh ? '近 7 天' : '7d', active: false },
    { label: zh ? '近 30 天' : '30d', active: false },
    { label: zh ? '全部' : 'All', active: false },
    { label: zh ? '自定义' : 'Custom', active: false },
  ];
  const rWidths = ranges.map((r) => Math.ceil(estimateTextWidth(r.label, 11, 500)) + 20);
  const segW = rWidths.reduce((a, b) => a + b, 0) + (ranges.length - 1) * 2 + 6;
  out.push(rect(left, toolY, segW, 28, { rx: 8, fill: C.hover }));
  let rx = left + 3;
  ranges.forEach((r, idx) => {
    const rw = rWidths[idx];
    if (r.active) out.push(rect(rx, toolY + 3, rw, 22, { rx: 5, fill: C.control }));
    out.push(text(rx + rw / 2, toolY + 18, r.label, {
      size: 11,
      weight: r.active ? 500 : 400,
      fill: r.active ? C.fg : C.muted,
      anchor: 'middle',
    }));
    rx += rw + 2;
  });

  // 右侧筛选器
  const cacheFilterText = zh ? '全部缓存 ▾' : 'All cache ▾';
  const modelFilterText = zh ? '全部模型 ▾' : 'All models ▾';
  const cfW = Math.ceil(estimateTextWidth(cacheFilterText, 11)) + 24;
  const mfW = Math.ceil(estimateTextWidth(modelFilterText, 11)) + 24;
  out.push(rect(right - cfW, toolY, cfW, 28, { rx: 7, fill: C.controlBg, stroke: C.border }));
  out.push(text(right - cfW / 2, toolY + 18, cacheFilterText, { size: 11, fill: C.fg, anchor: 'middle' }));
  out.push(rect(right - cfW - 8 - mfW, toolY, mfW, 28, { rx: 7, fill: C.controlBg, stroke: C.border }));
  out.push(text(right - cfW - 8 - mfW / 2, toolY + 18, modelFilterText, {
    size: 11,
    fill: C.fg,
    anchor: 'middle',
  }));

  // 汇总统计条（顺序严格对应 request-logs.ts: 等效花费 | 请求数 | 总 Token | 缓存命中率 | 首字/均速）
  const chipsY = 190;
  const summaryChips = [
    {
      label: zh ? '等效花费' : 'Est. cost',
      val: '$58.40',
      valColor: C.success,
    },
    {
      label: zh ? '请求数' : 'Requests',
      val: zh ? '148 次' : '148',
      valColor: C.fg,
    },
    {
      label: zh ? '总 Token' : 'Tokens',
      val: '38.9M',
      valColor: C.fg,
    },
    {
      label: zh ? '缓存命中率' : 'Cache hit',
      val: '82.4%',
      valColor: C.warning,
      extra: zh ? '热 106 / 未中 28' : '106 hot / 28 miss',
    },
    {
      label: zh ? '首字 / 均速' : 'TTFT / Speed',
      val: '14.2s',
      valColor: C.fg,
      extra: '54.8 t/s',
    },
  ];
  let sx = left;
  for (const ch of summaryChips) {
    const lblW = estimateTextWidth(ch.label, 11);
    const valW = estimateTextWidth(ch.val, 11, 600);
    const extraW = ch.extra ? estimateTextWidth(ch.extra, 10) + 14 : 0;
    const chipW = Math.ceil(12 + lblW + 8 + valW + (ch.extra ? 8 + extraW : 0) + 12);
    out.push(rect(sx, chipsY, chipW, 30, { rx: 9, fill: C.controlBg, stroke: C.border }));
    let cx = sx + 12;
    out.push(text(cx, chipsY + 19, ch.label, { size: 11, fill: C.muted }));
    cx += Math.ceil(lblW) + 8;
    out.push(text(cx, chipsY + 19, ch.val, { size: 11, weight: 600, fill: ch.valColor, tabular: true }));
    if (ch.extra) {
      cx += Math.ceil(valW) + 8;
      const ew = Math.ceil(estimateTextWidth(ch.extra, 10) + 12);
      out.push(rect(cx, chipsY + 6, ew, 18, {
        rx: 9,
        fill: C.bg,
        fillOpacity: 0.7,
        stroke: '#ffffff',
        strokeOpacity: 0.1,
      }));
      out.push(text(cx + ew / 2, chipsY + 18.5, ch.extra, {
        size: 10,
        fill: C.muted,
        anchor: 'middle',
        tabular: true,
      }));
    }
    sx += chipW + 9;
  }

  // 明细表格外框
  const tableX = left;
  const tableY = 234;
  const tableW = right - left; // 1112
  const headerH = 34;
  const rowH = 52;
  const rowsData = [
    {
      time: '2026-11-24 14:52:18',
      project: 'api-gateway',
      title: zh ? '鉴权中间件重构' : 'Auth middleware refactor',
      account: 'dev@example.com',
      model: 'Gemini 4 Neon (XHigh)',
      modelColor: C.modelNeon,
      ttft: '3.2s',
      ttftTone: C.success,
      total: '18.4s',
      totalTone: C.success,
      tps: '64.2 t/s',
      hit: '99.2%',
      hitTone: C.success,
      tokMain: ['312,480', '1,180'],
      tokSub: zh ? '缓存读 ↓ 309,980 · 未缓存 2,500' : 'Read ↓ 309,980 · Uncached 2,500',
      cost: '$0.068',
    },
    {
      time: '2026-11-24 14:49:05',
      project: 'api-gateway',
      title: zh ? '限流漏斗单元测试' : 'Rate-limiter unit tests',
      account: 'dev@example.com',
      model: 'Gemini 4 Neon (XHigh)',
      modelColor: C.modelNeon,
      ttft: '4.6s',
      ttftTone: C.success,
      total: '24.1s',
      totalTone: C.warning,
      tps: '58.9 t/s',
      hit: '96.8%',
      hitTone: C.success,
      tokMain: ['248,900', '1,420'],
      tokSub: zh ? '缓存读 ↓ 240,930 · 未缓存 7,970' : 'Read ↓ 240,930 · Uncached 7,970',
      cost: '$0.078',
    },
    {
      time: '2026-11-24 14:41:32',
      project: 'web-dashboard',
      title: zh ? '周期图表下钻交互' : 'Usage chart drilldown',
      account: 'dev@example.com',
      model: 'Gemini 4 Argon',
      modelColor: C.modelArgon,
      ttft: '11.8s',
      ttftTone: C.warning,
      total: '31.5s',
      totalTone: C.warning,
      tps: '41.5 t/s',
      hit: '74.5%',
      hitTone: C.warning,
      tokMain: ['196,400', '1,308'],
      tokSub: zh ? '缓存读 ↓ 146,320 · 未缓存 50,080' : 'Read ↓ 146,320 · Uncached 50,080',
      cost: '$0.188',
    },
    {
      time: '2026-11-24 14:35:19',
      project: 'rust-indexer',
      title: zh ? '增量流式分片解析' : 'Streaming frame parser',
      account: 'dev@example.com',
      model: 'Claude Sonnet 4.6',
      modelColor: C.modelSonnet,
      ttft: '4.2s',
      ttftTone: C.success,
      total: '19.8s',
      totalTone: C.success,
      tps: '78.4 t/s',
      hit: '98.9%',
      hitTone: C.success,
      tokMain: ['265,100', '1,552'],
      tokSub: zh ? '缓存读 ↓ 262,180 · 缓存写 ↑ 1,240 · 未缓存 1,680' : 'Read ↓ 262,180 · Write ↑ 1,240 · Uncached 1,680',
      cost: '$0.094',
    },
    {
      time: '2026-11-24 14:28:44',
      project: 'rust-indexer',
      title: zh ? '跨平台编译报错排查' : 'Cross-target build triage',
      account: 'dev@example.com',
      model: 'Gemini 4 Neon (XHigh)',
      modelColor: C.modelNeon,
      ttft: '31.4s',
      ttftTone: C.danger,
      total: '62.8s',
      totalTone: C.danger,
      tps: '24.6 t/s',
      hit: '0.0%',
      hitTone: C.danger,
      tokMain: ['320,800', '1,545'],
      tokSub: zh ? '未缓存 320,800' : 'Uncached 320,800',
      cost: '$0.985',
    },
    {
      time: '2026-11-24 14:19:10',
      project: 'cli-toolkit',
      title: zh ? '终端宽度断点适配' : 'Terminal width layout',
      account: 'dev@example.com',
      model: 'Gemini 4 Flash',
      modelColor: C.modelFlash,
      ttft: '2.1s',
      ttftTone: C.success,
      total: '12.6s',
      totalTone: C.success,
      tps: '92.4 t/s',
      hit: '98.5%',
      hitTone: C.success,
      tokMain: ['184,200', '1,164'],
      tokSub: zh ? '缓存读 ↓ 181,440 · 未缓存 2,760' : 'Read ↓ 181,440 · Uncached 2,760',
      cost: '$0.022',
    },
  ];
  const tableH = headerH + rowsData.length * rowH;

  out.push(rect(tableX, tableY, tableW, tableH, { rx: 12, fill: C.bg, stroke: C.border }));
  out.push(rect(tableX + 1, tableY + 1, tableW - 2, headerH, { rx: 11, fill: C.controlBg }));

  // 列坐标（确保第 5 列 Tokens 与第 6 列等效花费徽章之间保留 >=22px 安全间距）
  const colTime = tableX + 16;
  const colModel = tableX + 336;
  const colLat = tableX + 510;
  const colCacheCenter = tableX + 706;
  const colTokensRight = tableX + 1014;
  const colCostRight = tableX + 1096;

  out.push(text(colTime, tableY + 21, zh ? '时间' : 'Time', { size: 11, fill: C.muted }));
  out.push(text(colModel, tableY + 21, zh ? '模型' : 'Model', { size: 11, fill: C.muted }));
  out.push(text(colLat, tableY + 21, zh ? '耗时' : 'Latency', { size: 11, fill: C.muted }));
  out.push(text(colCacheCenter, tableY + 21, zh ? '缓存命中' : 'Cache', {
    size: 11,
    fill: C.muted,
    anchor: 'middle',
  }));
  out.push(text(colTokensRight, tableY + 21, zh ? 'Tokens（输入 / 输出）' : 'Tokens (In / Out)', {
    size: 11,
    fill: C.muted,
    anchor: 'end',
  }));
  out.push(text(colCostRight, tableY + 21, zh ? '等效花费' : 'Est. cost', {
    size: 11,
    fill: C.muted,
    anchor: 'end',
  }));

  rowsData.forEach((row, idx) => {
    const ry = tableY + headerH + idx * rowH;
    if (idx === 0) {
      out.push(rect(tableX + 1, ry, tableW - 2, rowH, { fill: C.hover, fillOpacity: 0.42 }));
    }
    if (idx > 0) {
      out.push(line(tableX, ry, tableX + tableW, ry, '#ffffff', 0.06));
    }

    // 1. 时间 + 项目标签 + 会话标题 + 账户标签
    out.push(text(colTime, ry + 20, row.time, { size: 11.5, weight: 500, fill: C.fg, tabular: true }));
    let tagX = colTime;
    const projW = Math.ceil(estimateTextWidth(row.project, 10) + 10);
    out.push(rect(tagX, ry + 28, projW, 16, { rx: 4, fill: C.controlBg, stroke: C.border }));
    out.push(text(tagX + projW / 2, ry + 39.5, row.project, { size: 10, fill: C.label, anchor: 'middle' }));
    tagX += projW + 6;

    out.push(text(tagX, ry + 39.5, row.title, { size: 10, fill: C.muted }));
    tagX += Math.ceil(estimateTextWidth(row.title, 10)) + 6;
    const accW = Math.ceil(estimateTextWidth(row.account, 9.5) + 10);
    if (tagX + accW < colModel - 10) {
      out.push(rect(tagX, ry + 28, accW, 16, { rx: 4, fill: C.controlBg, stroke: C.border }));
      out.push(text(tagX + accW / 2, ry + 39.5, row.account, { size: 9.5, fill: C.label, anchor: 'middle' }));
    }

    // 2. 模型
    out.push(`  <circle cx="${colModel + 4}" cy="${ry + 25}" r="3.5" fill="${row.modelColor}"/>`);
    out.push(text(colModel + 14, ry + 29, row.model, { size: 11.5, fill: C.fg }));

    // 3. 耗时（左首字，右总耗时，第二行综合 TPS）
    const ttftLabel = zh ? `首 ${row.ttft}` : `TTFT ${row.ttft}`;
    const totalLabel = zh ? `总 ${row.total}` : `Total ${row.total}`;
    const leftPill = pill(colLat, ry + 8, ttftLabel, row.ttftTone, {
      fontSize: 10,
      height: 18,
      padX: 6,
      rx: 5,
    });
    out.push(leftPill.svg);
    const rightPill = pill(leftPill.left + leftPill.width + 5, ry + 8, totalLabel, row.totalTone, {
      fontSize: 10,
      height: 18,
      padX: 6,
      rx: 5,
    });
    out.push(rightPill.svg);
    out.push(text(colLat, ry + 41, row.tps, { size: 10.5, weight: 500, fill: C.label, tabular: true }));

    // 4. 缓存命中率徽章（>90% 绿 / 50–90% 黄 / <50% 红）
    const cacheBadge = pill(colCacheCenter - 32, ry + 15, row.hit, row.hitTone, {
      fontSize: 10.5,
      height: 22,
      minW: 64,
      padX: 10,
    });
    out.push(cacheBadge.svg);

    // 5. Tokens（使用原生 tspan 确保跨平台右对齐间距精准）
    out.push(
      `  <text x="${colTokensRight}" y="${ry + 21}" text-anchor="end" font-family="${FONT_SANS}" font-size="11.5" font-variant-numeric="tabular-nums"><tspan font-weight="600" fill="${C.fg}">${esc(row.tokMain[0])}</tspan><tspan fill="${C.muted}" fill-opacity="0.7"> / </tspan><tspan fill="${C.label}">${esc(row.tokMain[1])}</tspan></text>`,
    );
    out.push(text(colTokensRight, ry + 39, row.tokSub, {
      size: 10,
      fill: C.muted,
      anchor: 'end',
      tabular: true,
    }));

    // 6. 单次请求费用
    out.push(
      pill(colCostRight, ry + 15, row.cost, C.border, {
        fontSize: 11,
        weight: 600,
        height: 22,
        padX: 8,
        rx: 6,
        fillColor: C.controlBg,
        fillOpacity: 0.9,
        strokeOpacity: 0.9,
        textColor: C.success,
        anchorRight: true,
      }).svg,
    );
  });

  // 分页条与底部注记
  const pagerY = tableY + tableH + 18;
  out.push(text(left, pagerY + 14, zh ? '显示第 1–6 条，共 148 条' : 'Showing 1–6 of 148', {
    size: 11,
    fill: C.muted,
    tabular: true,
  }));
  const prevLabel = zh ? '上一页' : 'Prev';
  const nextLabel = zh ? '下一页' : 'Next';
  let px = right - 26;
  out.push(rect(px, pagerY - 2, 26, 24, { rx: 6, fill: C.controlBg, stroke: C.border }));
  out.push(text(px + 13, pagerY + 14, '»', { size: 11, fill: C.fg, anchor: 'middle' }));
  px -= 6 + 52;
  out.push(rect(px, pagerY - 2, 52, 24, { rx: 6, fill: C.controlBg, stroke: C.border }));
  out.push(text(px + 26, pagerY + 14, nextLabel, { size: 11, fill: C.fg, anchor: 'middle' }));
  px -= 50;
  out.push(text(px + 25, pagerY + 14, '1 / 25', {
    size: 11,
    weight: 600,
    fill: C.fg,
    anchor: 'middle',
    tabular: true,
  }));
  px -= 52 + 6;
  out.push(rect(px, pagerY - 2, 52, 24, { rx: 6, fill: C.controlBg, stroke: C.border }));
  out.push(text(px + 26, pagerY + 14, prevLabel, { size: 11, fill: C.subtle, anchor: 'middle' }));
  px -= 26 + 6;
  out.push(rect(px, pagerY - 2, 26, 24, { rx: 6, fill: C.controlBg, stroke: C.border }));
  out.push(text(px + 13, pagerY + 14, '«', { size: 11, fill: C.subtle, anchor: 'middle' }));

  const footerY = height - 28;
  out.push(text(left, footerY, zh ? '已记录 1,842 次请求 · 始于 2026-09-14' : '1,842 requests recorded · since 2026-09-14', {
    size: 10,
    fill: C.subtle,
  }));
  out.push(text(right, footerY, zh ? 'Asia/Shanghai · 本地统计' : 'Asia/Shanghai · Local usage', {
    size: 10,
    fill: C.subtle,
    anchor: 'end',
  }));

  return svgDoc(width, height, cardGradDefs(), out.join('\n'));
}

function buildQuotaCycleSvg(lang) {
  const zh = lang === 'zh';
  const width = 1200;
  const height = 600;
  const left = 44;
  const right = width - 44;
  const out = [];

  buildModalChrome(out, width, height, lang, 'details');

  // 4 个顶部 KPI 指标卡
  const kpiY = 146;
  const kpiW = right - left; // 1112
  const kpis = [
    { label: zh ? '今日' : 'Today', val: '38.9M', cost: '≈ $58.40' },
    { label: zh ? '近 7 天' : 'Last 7 days', val: '214.6M', cost: '≈ $196.80' },
    { label: zh ? '本月' : 'This month', val: '864.8M', cost: '≈ $542.60' },
    { label: zh ? '总计' : 'All time', val: '1.94B', cost: '≈ $1,284.50' },
  ];
  out.push(rect(left, kpiY, kpiW, 72, { rx: 12, fill: C.controlBg, stroke: C.border }));
  kpis.forEach((k, idx) => {
    const colX = left + idx * (kpiW / 4);
    if (idx > 0) out.push(line(colX, kpiY + 14, colX, kpiY + 58, '#ffffff', 0.08));
    out.push(text(colX + 20, kpiY + 20, k.label, { size: 11, fill: C.muted }));
    out.push(
      `  <text x="${colX + 20}" y="${kpiY + 46}" font-family="${FONT_SANS}" font-variant-numeric="tabular-nums"><tspan font-size="22" font-weight="600" fill="${C.fg}">${esc(k.val)}</tspan><tspan font-size="10.5" fill="${C.muted}"> Token</tspan></text>`,
    );
    out.push(text(colX + 20, kpiY + 63, k.cost, { size: 11, weight: 500, fill: C.success, tabular: true }));
  });

  // 控制条：左下拉与周期切换 + 右范围导航与 Period 分段
  const ctrlY = 230;
  const pickers = [
    zh ? '按模型统计 ▾' : 'By Model ▾',
    zh ? '简易 ▾' : 'Simple ▾',
    'Gemini ▾',
  ];
  let lx = left;
  for (const label of pickers) {
    const pw = Math.ceil(estimateTextWidth(label, 11)) + 20;
    out.push(rect(lx, ctrlY, pw, 26, { rx: 7, fill: C.controlBg, stroke: C.border }));
    out.push(text(lx + pw / 2, ctrlY + 17, label, { size: 11, fill: C.fg, anchor: 'middle' }));
    lx += pw + 6;
  }

  // 周额度 / 5 小时切换
  const cwLabels = [
    { label: zh ? '周额度' : 'Weekly', active: true },
    { label: zh ? '5 小时' : '5h', active: false },
  ];
  const cwW = cwLabels.reduce((s, c) => s + Math.ceil(estimateTextWidth(c.label, 11, 500)) + 18, 8);
  out.push(rect(lx, ctrlY, cwW, 26, { rx: 7, fill: C.hover }));
  let cwx = lx + 3;
  for (const cw of cwLabels) {
    const bw = Math.ceil(estimateTextWidth(cw.label, 11, 500)) + 16;
    if (cw.active) out.push(rect(cwx, ctrlY + 3, bw, 20, { rx: 5, fill: C.control }));
    out.push(text(cwx + bw / 2, ctrlY + 17, cw.label, {
      size: 11,
      weight: cw.active ? 500 : 400,
      fill: cw.active ? C.fg : C.muted,
      anchor: 'middle',
    }));
    cwx += bw + 2;
  }
  lx += cwW + 8;

  // 状态胶囊
  out.push(
    pill(
      lx,
      ctrlY + 2,
      zh ? '当前周期 · 已用 59%（剩 41%）' : 'Current · 59% used (41% left)',
      C.success,
      { fontSize: 10.5, weight: 500, height: 22, padX: 8 },
    ).svg,
  );

  // 右侧时段分段
  const periods = [
    { label: zh ? '天' : 'Day', active: false },
    { label: zh ? '周' : 'Week', active: false },
    { label: zh ? '月' : 'Month', active: false },
    { label: zh ? '额度周期' : 'Quota cycle', active: true },
    { label: zh ? '自定义' : 'Custom', active: false },
  ];
  const pWidths = periods.map((p) => Math.ceil(estimateTextWidth(p.label, 11, 500)) + 18);
  const pSegW = pWidths.reduce((a, b) => a + b, 0) + (periods.length - 1) * 2 + 6;
  out.push(rect(right - pSegW, ctrlY, pSegW, 26, { rx: 7, fill: C.hover }));
  let prx = right - pSegW + 3;
  periods.forEach((p, idx) => {
    const pw = pWidths[idx];
    if (p.active) out.push(rect(prx, ctrlY + 3, pw, 20, { rx: 5, fill: C.control }));
    out.push(text(prx + pw / 2, ctrlY + 17, p.label, {
      size: 11,
      weight: p.active ? 500 : 400,
      fill: p.active ? C.fg : C.muted,
      anchor: 'middle',
    }));
    prx += pw + 2;
  });

  // 汇总行 + 周期范围导航 + 图例
  const sumY = 274;
  const reqText = zh ? ' · 892 次请求' : ' · 892 requests';
  out.push(
    `  <text x="${left}" y="${sumY}" font-family="${FONT_SANS}" font-variant-numeric="tabular-nums"><tspan font-size="12" font-weight="600" fill="${C.fg}">214.6M Token</tspan><tspan font-size="12" font-weight="600" fill="${C.success}"> · ≈ $196.80</tspan><tspan font-size="11.5" fill="${C.muted}">${esc(reqText)}</tspan></text>`,
  );
  out.push(text(right, sumY, '‹  11/17 16:50 – 11/24 16:50  ›', {
    size: 11.5,
    weight: 500,
    fill: C.fg,
    anchor: 'end',
    tabular: true,
  }));

  // 模型图例
  const legendItems = [
    { name: 'Gemini 4 Neon', color: C.modelNeon },
    { name: 'Gemini 4 Argon', color: C.modelArgon },
    { name: 'Gemini 4 Flash', color: C.modelFlash },
    { name: 'Claude Sonnet 4.6', color: C.modelSonnet },
  ];
  let legX = left;
  for (const lg of legendItems) {
    out.push(`  <circle cx="${legX + 4}" cy="${sumY + 18}" r="3.5" fill="${lg.color}"/>`);
    out.push(text(legX + 13, sumY + 22, lg.name, { size: 11, fill: C.label }));
    legX += Math.ceil(estimateTextWidth(lg.name, 11)) + 32;
  }

  // 堆叠柱状图区域
  const chartX = left + 46;
  const chartY = 314;
  const chartW = right - chartX;
  const chartH = 110;
  const maxVal = 60;
  const ticks = [0, 20, 40, 60];
  for (const tk of ticks) {
    const ty = chartY + chartH - (tk / maxVal) * chartH;
    out.push(line(chartX, ty, right, ty, '#ffffff', tk === 0 ? 0.14 : 0.06));
    out.push(text(chartX - 10, ty + 3.5, tk === 0 ? '0' : `${tk}M`, {
      size: 10,
      fill: C.muted,
      anchor: 'end',
      tabular: true,
    }));
  }

  // 7 个周期切片柱（单位 M tokens）
  const bars = [
    { label: '11/17', parts: [12, 4, 2, 1], total: 19 },
    { label: '11/18', parts: [20, 7, 3, 2], total: 32 },
    { label: '11/19', parts: [18, 6, 4, 2], total: 30 },
    { label: '11/20', parts: [24, 8, 4, 2], total: 38 },
    { label: '11/21', parts: [16, 6, 3, 2], total: 27 },
    { label: '11/22', parts: [31, 9, 5, 3.2], total: 48.2, selected: true },
    { label: '11/23', parts: [13, 4, 2, 1.4], total: 20.4 },
  ];
  const barColors = [C.modelNeon, C.modelArgon, C.modelFlash, C.modelSonnet];
  const slotW = chartW / bars.length;
  const barW = 34;

  bars.forEach((b, idx) => {
    const cx = chartX + idx * slotW + slotW / 2;
    const bx = cx - barW / 2;
    if (b.selected) {
      out.push(rect(bx - 10, chartY - 4, barW + 20, chartH + 8, {
        rx: 6,
        fill: C.accent,
        fillOpacity: 0.1,
        stroke: C.accent,
        strokeWidth: 1.5,
      }));
    }
    let curY = chartY + chartH;
    b.parts.forEach((pVal, pIdx) => {
      const ph = (pVal / maxVal) * chartH;
      curY -= ph;
      const isTop = pIdx === b.parts.length - 1;
      out.push(rect(bx, curY, barW, ph, { rx: isTop ? 3 : 0, fill: barColors[pIdx] }));
    });
    out.push(text(cx, chartY + chartH + 17, b.label, {
      size: 10.5,
      weight: b.selected ? 600 : 400,
      fill: b.selected ? C.fg : C.muted,
      anchor: 'middle',
      tabular: true,
    }));

    if (b.selected) {
      // 悬浮下钻提示卡置于左上方高处，避免遮挡相邻柱体
      const tipW = 196;
      const tipH = 42;
      const tipX = cx - barW / 2 - tipW - 14;
      const tipY = chartY + 2;
      out.push(rect(tipX, tipY, tipW, tipH, { rx: 8, fill: '#303338', stroke: C.border }));
      out.push(text(tipX + 12, tipY + 16.5, zh ? '11/22 · 48.2M Token' : '11/22 · 48.2M tok', {
        size: 11,
        weight: 600,
        fill: C.fg,
        tabular: true,
      }));
      out.push(text(tipX + 12, tipY + 33, zh ? '等效花费 ≈ $41.30 · 204 次' : 'Est. cost ≈ $41.30 · 204 reqs', {
        size: 10,
        fill: C.success,
        tabular: true,
      }));
    }
  });

  // 底部模型明细表（精确对齐 breakdown-table.ts 7 列）
  const tblY = 456;
  const colPositions = {
    model: left,
    total: left + 330,
    cost: left + 475,
    uncached: left + 635,
    read: left + 805,
    write: left + 960,
    output: right,
  };
  const headers = zh
    ? ['模型', '总 Token', '等效花费', '未缓存输入', '缓存读取', '缓存写入', '输出']
    : ['Model', 'Total tokens', 'Est. cost', 'Uncached input', 'Cache read', 'Cache write', 'Output'];

  out.push(text(colPositions.model, tblY + 14, headers[0], { size: 11, fill: C.muted }));
  out.push(text(colPositions.total, tblY + 14, headers[1], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(text(colPositions.cost, tblY + 14, headers[2], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(text(colPositions.uncached, tblY + 14, headers[3], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(text(colPositions.read, tblY + 14, headers[4], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(text(colPositions.write, tblY + 14, headers[5], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(text(colPositions.output, tblY + 14, headers[6], { size: 11, fill: C.muted, anchor: 'end' }));
  out.push(line(left, tblY + 23, right, tblY + 23, '#ffffff', 0.1));

  const tblRows = [
    ['Gemini 4 Neon', C.modelNeon, '134.0M', '$128.40', '28.4M', '104.2M', '0', '1.40M'],
    ['Gemini 4 Argon', C.modelArgon, '44.0M', '$38.90', '7.2M', '36.3M', '0', '510K'],
    ['Claude Sonnet 4.6', C.modelSonnet, '22.4M', '$25.10', '2.1M', '19.6M', '310K', '390K'],
    ['Gemini 4 Flash', C.modelFlash, '14.2M', '$4.40', '1.8M', '12.1M', '0', '280K'],
  ];
  tblRows.forEach((r, idx) => {
    const ry = tblY + 41 + idx * 25;
    if (idx > 0) out.push(line(left, ry - 16, right, ry - 16, '#ffffff', 0.06));
    out.push(`  <circle cx="${colPositions.model + 4}" cy="${ry - 3.5}" r="3.5" fill="${r[1]}"/>`);
    out.push(text(colPositions.model + 14, ry, r[0], { size: 11.5, weight: 500, fill: C.fg }));
    out.push(text(colPositions.total, ry, r[2], { size: 11.5, fill: C.fg, anchor: 'end', tabular: true }));
    out.push(text(colPositions.cost, ry, r[3], {
      size: 11.5,
      weight: 600,
      fill: C.success,
      anchor: 'end',
      tabular: true,
    }));
    out.push(text(colPositions.uncached, ry, r[4], { size: 11.5, fill: C.label, anchor: 'end', tabular: true }));
    out.push(text(colPositions.read, ry, r[5], { size: 11.5, fill: C.label, anchor: 'end', tabular: true }));
    out.push(text(colPositions.write, ry, r[6], { size: 11.5, fill: C.muted, anchor: 'end', tabular: true }));
    out.push(text(colPositions.output, ry, r[7], { size: 11.5, fill: C.label, anchor: 'end', tabular: true }));
  });

  return svgDoc(width, height, cardGradDefs(), out.join('\n'));
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const specs = [
    ['hero-enhanced.svg', () => buildHeroSvg('en')],
    ['hero-enhanced-zh.svg', () => buildHeroSvg('zh')],
    ['feature-cards.svg', () => buildFeatureCardsSvg('en')],
    ['feature-cards-zh.svg', () => buildFeatureCardsSvg('zh')],
    ['usage-request-logs.svg', () => buildRequestLogsSvg('en')],
    ['usage-request-logs-zh.svg', () => buildRequestLogsSvg('zh')],
    ['usage-quota-cycle.svg', () => buildQuotaCycleSvg('en')],
    ['usage-quota-cycle-zh.svg', () => buildQuotaCycleSvg('zh')],
  ];

  for (const [name, render] of specs) {
    const svg = render();
    await writeFile(join(OUT_DIR, name), svg, 'utf8');
    console.log(`Generated docs/assets/${name} (${svg.length} bytes)`);
  }
}

await main();

// Shared local usage views. Values and model labels are inserted as text.
module.exports = function createUsageDashboard({root,language,setMarkup,hostLabel='Antigravity',guideDismissed=false,onDismissGuide,onLanguage,onRefresh}) {
  const dialog=document.createElement('dialog');dialog.id='usage-dashboard';dialog.setAttribute('popover','manual');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label',language.language==='zh-CN'?'用量统计':'Token usage');
  dialog.style.cssText='width:min(1040px,calc(100vw - 40px));max-width:none;height:min(820px,calc(100dvh - 64px));max-height:none;box-sizing:border-box;overflow:hidden;visibility:visible;pointer-events:auto;padding:0;border:1px solid var(--pulse-border);border-radius:18px;background:var(--pulse-background);color:var(--pulse-foreground);box-shadow:0 24px 100px #0006';
  const shell=document.createElement('div'),view=shell.attachShadow({mode:'open'});shell.style.height='100%';dialog.append(shell);root.append(dialog);
  const backdrop=document.createElement('style');backdrop.textContent='#usage-dashboard{position:fixed;inset:0;margin:auto;opacity:1;transition:opacity 150ms cubic-bezier(.22,1,.36,1)}#usage-dashboard::backdrop{background:#0006;backdrop-filter:blur(3px);pointer-events:auto;transition:opacity 150ms ease}@starting-style{#usage-dashboard:popover-open{opacity:.05}#usage-dashboard:popover-open::backdrop{opacity:0}}@media(prefers-reduced-motion:reduce){#usage-dashboard,#usage-dashboard::backdrop{transition:none}}';root.append(backdrop);
  const css=document.createElement('style');css.textContent=`
    :host{display:block;color:var(--pulse-foreground);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;font-variant-numeric:tabular-nums}
    *{box-sizing:border-box}button,select{font:inherit;color:inherit}button{cursor:pointer}button,select{border:1px solid var(--pulse-border);background:transparent;border-radius:7px}button{transition:background-color 140ms ease,color 140ms ease,border-color 140ms ease,box-shadow 140ms ease,transform 120ms cubic-bezier(.23,1,.32,1)}button:active{transform:scale(.97)}button:focus-visible,select:focus-visible{outline:2px solid var(--pulse-accent);outline-offset:3px}button[disabled]{opacity:.35;cursor:default}
    .page{padding:28px 32px 24px;max-height:90dvh;overflow:auto;background:var(--pulse-background)}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.eyebrow{font-size:10px;color:var(--pulse-muted);letter-spacing:1.7px;margin-bottom:7px}h1{font-size:24px;letter-spacing:-.7px;line-height:1.2;margin:0 0 8px;font-weight:600}.sub{font-size:12px;color:var(--pulse-muted);display:flex;align-items:center;flex-wrap:wrap;gap:4px 0}.top-controls{display:flex;align-items:center;gap:8px;flex-direction:row-reverse;flex-wrap:wrap;flex:none}.actions{display:flex;gap:8px;align-items:center}.actions button{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;padding:0;line-height:1;border-radius:8px;color:var(--pulse-muted)}.actions button:hover{background:var(--pulse-hover);color:var(--pulse-foreground)}.actions svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.locale-label{display:block;min-width:16px;height:16px;line-height:16px;text-align:center;font-size:11px}.live-dot{display:inline-block;width:5px;height:5px;background:var(--pulse-success);border-radius:50%;margin-right:6px;box-shadow:0 0 0 2px color-mix(in srgb,var(--pulse-success) 22%,transparent)}
    .tabs{display:flex;gap:22px;border-bottom:1px solid var(--pulse-separator);margin:25px 0 22px}.tabs button{border:0;border-radius:0;background:transparent;color:var(--pulse-muted);padding:0 2px 11px;position:relative}.tabs button:hover{color:var(--pulse-foreground)}.tabs button[aria-selected=true]{color:var(--pulse-foreground);font-weight:600}.tabs button[aria-selected=true]:after{content:'';position:absolute;height:2px;background:var(--pulse-accent);bottom:-1px;left:0;right:0}
    .totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--pulse-border);border-radius:12px;padding:17px 0;margin-bottom:28px;background:color-mix(in srgb,var(--pulse-control) 65%,transparent)}.metric{padding:0 20px}.metric+.metric{border-left:1px solid var(--pulse-separator)}.metric label{color:var(--pulse-muted);font-size:11px}.value{font-size:27px;letter-spacing:-.9px;margin:5px 0 0;font-weight:550;font-variant-numeric:tabular-nums}.unit{font-size:11px;color:var(--pulse-muted);margin-left:5px;font-weight:400;letter-spacing:0}
    section[hidden]{display:none}.section-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:0 0 18px}h2{font-size:14px;font-weight:600;letter-spacing:-.2px;margin:0}.muted{font-size:11px;color:var(--pulse-muted)}.seg{display:flex;padding:3px;background:var(--pulse-hover);border-radius:8px;gap:2px}.seg button{border:0;padding:4px 12px;border-radius:5px;font-size:11px;color:var(--pulse-muted)}.seg button:hover:not([aria-pressed=true]){color:var(--pulse-foreground)}.seg button[aria-pressed=true]{background:var(--pulse-control);color:var(--pulse-foreground);box-shadow:0 1px 3px #0001}select{padding:4px 8px;font-size:11px;background:var(--pulse-background)}
    .heat-wrap{overflow-x:auto;padding:3px 3px 7px}.calendar{min-width:680px}.months{display:grid;margin-left:31px;font-size:10px;color:var(--pulse-muted);margin-bottom:7px}.heat-row{display:flex;gap:9px}.weekdays{display:grid;grid-template-rows:repeat(7,1fr);width:22px;flex:none;font-size:9px;color:var(--pulse-muted)}.heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px;width:100%}.heat button{position:relative;border:0;border-radius:3px;padding:0;min-width:0;aspect-ratio:1;background:var(--pulse-hover);outline-offset:1px;transition:transform 120ms cubic-bezier(.22,1,.36,1),background-color 140ms ease,box-shadow 140ms ease}.heat button:not(:disabled):hover,.heat button:not(:disabled):focus-visible{transform:scale(1.16);z-index:2;box-shadow:0 0 0 1px var(--pulse-border)}.heat button[data-level="1"],.swatch[data-level="1"]{background:color-mix(in srgb,var(--pulse-accent) 22%,var(--pulse-hover))}.heat button[data-level="2"],.swatch[data-level="2"]{background:color-mix(in srgb,var(--pulse-accent) 45%,var(--pulse-hover))}.heat button[data-level="3"],.swatch[data-level="3"]{background:color-mix(in srgb,var(--pulse-accent) 68%,var(--pulse-hover))}.heat button[data-level="4"],.swatch[data-level="4"]{background:var(--pulse-accent)}.heat button.future{opacity:.25;cursor:default}.heat.week{grid-template-columns:repeat(26,minmax(0,1fr))!important;grid-template-rows:repeat(2,1fr);grid-auto-flow:row}.week button{max-height:28px;aspect-ratio:1}.heat-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:10px 0 27px;font-size:10px;color:var(--pulse-muted)}.scale{display:flex;align-items:center;gap:4px}.swatch{width:11px;height:11px;border-radius:3px;background:var(--pulse-hover)}.selected{padding:16px 18px;border:1px solid var(--pulse-border);border-radius:10px;display:flex;justify-content:space-between;gap:16px;align-items:center;background:color-mix(in srgb,var(--pulse-control) 50%,transparent)}.selected button{border:0;color:var(--pulse-accent);font-size:12px;padding:5px}.selected button:hover{text-decoration:underline}.selected .title{font-weight:500;margin-bottom:3px}.selected strong{font-weight:550}
    .chart-controls{display:flex;gap:10px;align-items:center}.range{display:flex;align-items:center;gap:10px}.range button{height:26px;width:26px;border:0}.range button:not(:disabled):hover{background:var(--pulse-hover)}.range strong{font-size:12px;font-weight:500;min-width:106px;text-align:center}.legend{display:flex;flex-wrap:wrap;gap:7px;margin:0 0 18px}.legend button{display:flex;align-items:center;gap:7px;padding:5px 9px;border-radius:6px;font-size:11px;border-color:transparent;background:var(--pulse-hover)}.legend button[aria-pressed=false]{opacity:.35}.dot{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none;background:var(--model-color)}
    .chart-wrap{overflow-x:auto;border-bottom:1px solid var(--pulse-separator);padding-bottom:17px;margin-bottom:18px}.chart{height:246px;display:flex;gap:10px;min-width:650px}.axis{width:42px;flex:none;position:relative;font-size:9px;color:var(--pulse-muted)}.axis span{position:absolute;right:0;transform:translateY(50%)}.plot{position:relative;flex:1;display:flex;align-items:stretch;gap:6px;padding:0 1px}.grid-line{position:absolute;left:0;right:0;border-top:1px solid var(--pulse-separator);pointer-events:none}.bar-column{position:relative;flex:1;min-width:0;display:flex;align-items:flex-end;border:0;border-radius:4px;background:transparent;padding:0;margin-bottom:19px}.stack{display:flex;flex-direction:column-reverse;width:100%;gap:1px;pointer-events:none;border-radius:3px 3px 0 0;overflow:hidden}.bar-segment{width:100%;background:var(--model-color);min-height:1px}.x-label{position:absolute;top:calc(100% + 5px);left:50%;transform:translateX(-50%);font-size:9px;color:var(--pulse-muted);white-space:nowrap}.empty-bar{height:2px;width:100%;background:var(--pulse-track);border-radius:2px}.chart-empty{position:absolute;left:0;right:0;top:40%;text-align:center;color:var(--pulse-muted);font-size:12px;pointer-events:none}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;text-align:right;font-size:11px;white-space:nowrap}.table th{font-weight:400;color:var(--pulse-muted);padding:8px 12px;border-bottom:1px solid var(--pulse-separator)}.table td{padding:12px;border-bottom:1px solid var(--pulse-separator)}.table th:first-child,.table td:first-child{text-align:left;padding-left:0}.table td:first-child span{margin-right:7px}.table tr:last-child td{border-bottom:0}.footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;font-size:10px;color:var(--pulse-muted)}.alert{color:var(--pulse-warning);margin-top:12px;font-size:11px}.tip{position:fixed;z-index:20;max-width:280px;padding:12px 14px;border:1px solid var(--pulse-border);border-radius:9px;background:var(--pulse-menu);box-shadow:0 8px 30px var(--pulse-shadow);color:var(--pulse-foreground);font-size:11px;pointer-events:none;opacity:1;transition:opacity 120ms ease,transform 120ms cubic-bezier(.22,1,.36,1)}.tip[hidden]{display:none}@starting-style{.tip:not([hidden]){opacity:.15;transform:translateY(3px)}}.tip .tip-title{font-size:10px;color:var(--pulse-muted);margin-bottom:5px}.tip strong{font-size:16px;font-weight:550}.tip-model{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-top:5px}.tip-model .dot{margin-right:6px}
    @media(max-width:650px){.page{padding:20px 18px}.totals{grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 0}.metric:nth-child(3){border-left:0}.value{font-size:23px}.section-head{align-items:flex-start;flex-wrap:wrap}.chart-controls{width:100%;justify-content:space-between}.footer{align-items:flex-start;flex-direction:column;gap:5px}.selected{align-items:flex-start}.chart{gap:8px}}
  `;view.append(css);
  css.textContent+=' .months span{white-space:nowrap}.chart-wrap{padding-top:9px}';
  css.textContent+=`
    :host{height:100%}.page{height:100%;max-height:none;display:flex;flex-direction:column;scrollbar-gutter:stable}.page>*{flex:none}.footer{margin-top:auto;padding-top:20px}
    .year-picker{position:relative;flex:none}.year-trigger{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:76px;height:30px;padding:0 10px;background:var(--pulse-control);color:var(--pulse-foreground);font-size:11px;border-radius:8px}.year-trigger:hover,.year-trigger[aria-expanded=true]{background:var(--pulse-hover)}.year-chevron{width:12px;height:12px;fill:none;stroke:var(--pulse-muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:transform 160ms cubic-bezier(.23,1,.32,1)}.year-trigger[aria-expanded=true] .year-chevron{transform:rotate(180deg)}
    .year-menu{position:fixed;inset:auto;margin:0;padding:5px;width:112px;max-height:232px;overflow-y:auto;border:1px solid var(--pulse-border);border-radius:10px;background:var(--pulse-menu);color:var(--pulse-foreground);box-shadow:0 8px 26px var(--pulse-shadow);transform-origin:top right;opacity:1;transform:scale(1);transition:opacity 140ms ease,transform 160ms cubic-bezier(.23,1,.32,1)}.year-menu::backdrop{background:transparent;pointer-events:none}.year-option{width:100%;border:0;border-radius:6px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between;gap:18px;font-size:12px;text-align:left;background:transparent;color:var(--pulse-foreground);font-variant-numeric:tabular-nums}.year-option:hover,.year-option:focus-visible{background:var(--pulse-hover)}.year-option[aria-selected=true]{background:color-mix(in srgb,var(--pulse-accent) 12%,var(--pulse-menu))}.year-check{color:var(--pulse-accent);width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:0}.year-option[aria-selected=true] .year-check{opacity:1}
    @starting-style{.year-menu:popover-open{opacity:0;transform:scale(.97)}}
  `;
  css.textContent+=`
    .bar-column:hover{background:color-mix(in srgb,var(--pulse-hover) 55%,transparent)}.bar-column:active{transform:none}.stack{width:62%;max-width:30px;margin-inline:auto;gap:0;border-radius:4px 4px 0 0;overflow:hidden}.bar-segment{display:block;flex:none;min-height:0;border-radius:0;pointer-events:auto;background:var(--model-color);transition:height 240ms cubic-bezier(.22,1,.36,1),opacity 140ms ease}.plot[data-highlight] .bar-segment:not([data-highlight=true]){opacity:.24}.empty-bar{height:1px;opacity:.35}.grid-line{border-top-style:solid;opacity:.45}.grid-line:first-child{opacity:.85}.legend{gap:4px 18px;margin-bottom:22px}.legend button{background:transparent;padding:3px 0;border:0;border-radius:3px;color:var(--pulse-muted);gap:7px}.legend button:hover,.legend button[aria-pressed=true]{color:var(--pulse-foreground)}.legend button[aria-pressed=false]{opacity:.4;text-decoration:line-through}.legend .dot{width:7px;height:7px;border-radius:50%}.chart{gap:16px}.plot{gap:5px}.axis,.x-label{font-size:10px}.chart-summary{font-size:11px;color:var(--pulse-muted);margin-top:5px}.chart-summary strong{color:var(--pulse-foreground);font-weight:500}.chart-wrap{padding-top:6px}.table .dot{border-radius:50%}
    .tip-model{padding:3px 0}.tip-model.dimmed{opacity:.5}.tip-model.active{font-weight:600}.model-share{font-size:10px;color:var(--pulse-muted);margin-left:9px}.usage-waiting{display:grid;place-items:center;min-height:260px;color:var(--pulse-muted);font-size:12px}.usage-waiting[hidden]{display:none}
    .account-switcher{margin-left:8px;padding:2px 8px;font-size:11px;border-radius:6px;border:1px solid var(--pulse-border);background:var(--pulse-control);color:var(--pulse-foreground);max-width:260px;text-overflow:ellipsis}.account-switcher[hidden]{display:none}
    .btn-manual{display:inline-flex;align-items:center;gap:6px;width:auto;flex:0 0 auto;white-space:nowrap;padding:0 12px;height:32px;line-height:32px;border-radius:8px;font-size:11px;font-weight:500;color:var(--pulse-foreground);background:var(--pulse-control);border:1px solid var(--pulse-border)}.btn-manual:hover{background:var(--pulse-hover)}.btn-manual svg{display:block;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
    .bar-segment.legacy{background:var(--pulse-muted) !important;opacity:0.55;outline:1px dashed var(--pulse-border)}
    .dim-toggle{display:inline-flex;padding:2px;background:var(--pulse-hover);border-radius:6px;gap:2px;margin-left:12px;vertical-align:middle}
    .dim-toggle[hidden]{display:none}.dim-toggle+.dim-toggle{margin-left:4px}
    .dim-toggle button{border:0;padding:2px 8px;border-radius:4px;font-size:11px;color:var(--pulse-muted);cursor:pointer;background:transparent}
    .dim-toggle button[aria-pressed=true]{background:var(--pulse-control);color:var(--pulse-foreground);font-weight:500;box-shadow:0 1px 2px #0002}
    .hourly-mode-seg{display:inline-flex;padding:2px;background:var(--pulse-hover);border-radius:6px;gap:2px;margin-left:8px;vertical-align:middle}
    .hourly-mode-seg button{border:0;padding:2px 8px;border-radius:4px;font-size:10px;color:var(--pulse-muted);cursor:pointer;background:transparent}
    .hourly-mode-seg button[aria-pressed=true]{background:var(--pulse-control);color:var(--pulse-foreground);font-weight:500}
    #toggle-all-models{font-size:11px;color:var(--pulse-accent);background:transparent;border:1px dashed var(--pulse-border);border-radius:6px;padding:3px 8px;cursor:pointer}#toggle-all-models:hover{background:var(--pulse-hover)}
    @keyframes pulse-reveal{from{opacity:.15;transform:translateY(-4px)}to{opacity:1;transform:none}}
    .other-models{display:flex;flex-wrap:wrap;gap:7px;width:100%;padding-top:6px;border-top:1px dashed var(--pulse-separator);margin-top:4px}.other-models[hidden]{display:none}.other-models:not([hidden]){animation:pulse-reveal 160ms cubic-bezier(.22,1,.36,1)}
    .custom-range-controls{display:flex;align-items:center;gap:6px}.custom-range-controls input[type=date]{padding:3px 6px;font-size:11px;border-radius:6px;border:1px solid var(--pulse-border);background:var(--pulse-control);color:var(--pulse-foreground)}.custom-range-controls[hidden]{display:none}
    .bar-column.selected{background:color-mix(in srgb,var(--pulse-accent) 10%,transparent);outline:2px solid var(--pulse-accent);outline-offset:2px;border-radius:4px}
    .reset-drilldown{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--pulse-border);background:var(--pulse-hover);color:var(--pulse-foreground);cursor:pointer;margin-left:10px}.reset-drilldown[hidden]{display:none}.reset-drilldown:hover{background:var(--pulse-control)}
    .hourly-section{margin:18px 0;border:1px solid var(--pulse-border);border-radius:12px;background:var(--pulse-control);overflow:hidden}
    .hourly-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:12px}
    .hourly-toggle{display:flex;align-items:center;gap:12px;border:0;background:transparent;color:var(--pulse-foreground);cursor:pointer;padding:0;text-align:left;flex:1;min-width:0}
    .hourly-toggle:hover{color:var(--pulse-accent)}.hourly-toggle:active{transform:none}
    #hourly-title{font-size:12px;font-weight:600}
    .hourly-chevron{width:12px;height:12px;fill:none;stroke:var(--pulse-muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:transform 160ms cubic-bezier(.23,1,.32,1);flex:none}.hourly-toggle[aria-expanded=true] .hourly-chevron{transform:rotate(180deg)}
    .hourly-content{padding:10px 16px 16px;border-top:1px solid var(--pulse-separator)}.hourly-content[hidden]{display:none}.hourly-content:not([hidden]){animation:pulse-reveal 160ms cubic-bezier(.22,1,.36,1)}
    .hourly-chart-wrap{width:100%;overflow-x:auto}.hourly-chart-wrap svg{width:100%;max-width:100%;height:auto;display:block}
    .hourly-crosshair,.hourly-focus-ring{transition:opacity 120ms ease;pointer-events:none}.hourly-pt{transition:r 120ms ease,fill-opacity 120ms ease}
    .manual-section{margin-top:24px;border-top:1px solid var(--pulse-separator);padding-top:18px}
    .btn-delete{padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--pulse-border);background:transparent;color:var(--pulse-danger,#e5484d);cursor:pointer}.btn-delete:hover{background:color-mix(in srgb,var(--pulse-danger,#e5484d) 15%,transparent)}
    .modal-layer{position:fixed;inset:0;background:#0008;backdrop-filter:blur(3px);z-index:99;display:flex;align-items:center;justify-content:center;padding:20px;opacity:1;transition:opacity 150ms ease}.modal-layer[hidden]{display:none}@starting-style{.modal-layer:not([hidden]){opacity:0}.modal-layer:not([hidden]) .modal-card{opacity:0;transform:translateY(8px) scale(.97)}}
    .modal-card{width:min(440px,calc(100vw - 32px));background:var(--pulse-background);border:1px solid var(--pulse-border);border-radius:14px;padding:22px 24px;box-shadow:0 16px 40px var(--pulse-shadow);display:flex;flex-direction:column;gap:14px;opacity:1;transform:none;transition:opacity 160ms ease,transform 180ms cubic-bezier(.22,1,.36,1)}
    .modal-title{font-size:15px;font-weight:600;margin:0}.modal-form{display:flex;flex-direction:column;gap:12px}
    .form-row{display:flex;flex-direction:column;gap:4px}.form-row.two-col{flex-direction:row;gap:10px}.form-row.two-col>div{flex:1;display:flex;flex-direction:column;gap:4px}
    .form-row label{font-size:11px;color:var(--pulse-muted)}.form-row input,.form-row select{padding:6px 10px;border-radius:6px;border:1px solid var(--pulse-border);background:var(--pulse-control);color:var(--pulse-foreground);font:inherit;font-size:12px}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:6px}.modal-actions button{padding:6px 14px;border-radius:6px;font-size:12px}.btn-primary{background:var(--pulse-accent);color:#fff;border-color:var(--pulse-accent)}
    .model-group-row{cursor:pointer;transition:background-color 140ms ease}.model-group-row:hover{background:color-mix(in srgb,var(--pulse-hover) 65%,transparent)}.model-group-row:focus-visible{outline:2px solid var(--pulse-accent);outline-offset:-2px}.model-group-row[aria-expanded=true]{background:color-mix(in srgb,var(--pulse-control) 45%,transparent)}
    .model-group-name{font-weight:500;color:var(--pulse-foreground)}.model-variant-count{display:inline-block;padding:1px 6px;border-radius:999px;font-size:10px;color:var(--pulse-muted);background:var(--pulse-hover);vertical-align:middle}
    .model-group-chevron{font-size:10px;color:var(--pulse-muted);margin-right:0!important;transition:color 140ms ease}.model-group-row:hover .model-group-chevron,.model-group-row[aria-expanded=true] .model-group-chevron{color:var(--pulse-foreground)}
    .model-variant-row{background:color-mix(in srgb,var(--pulse-control) 28%,transparent);font-size:10.5px;color:var(--pulse-muted)}.model-variant-row td{padding-top:8px;padding-bottom:8px;border-bottom-style:dashed}
    .table .model-variant-row td:first-child{padding-left:18px}.variant-branch{color:var(--pulse-subtle);opacity:.75;margin-right:6px!important}.variant-name{color:var(--pulse-label)}.variant-share{font-size:10px;color:var(--pulse-muted);margin-right:0!important}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}button:active,.heat button:not(:disabled):hover,.heat button:not(:disabled):focus-visible{transform:none!important}}
  `;
  const page=document.createElement('div');page.className='page';
  setMarkup(page,`<header class="top"><div><div class="eyebrow">ANTIGRATIVE DASHBOARD</div><h1 id="title"></h1><div class="sub"><span class="live-dot"></span><span id="subtitle"></span><span id="account-switcher-slot"></span></div></div><div class="top-controls"><div class="actions"><button id="locale" type="button" aria-label="Language"><span id="locale-label" class="locale-label">中</span></button><button id="refresh" type="button" aria-label="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7a5 5 0 1 0-1.3 4.4M13 3v4H9"/></svg></button><button id="close" type="button" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div><button id="add-manual" type="button" class="btn-manual" aria-label="Add manual usage"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg><span id="add-manual-label">录入远程用量</span></button></div></header><nav class="tabs" role="tablist"><button id="overview-tab" role="tab" aria-controls="overview"></button><button id="details-tab" role="tab" aria-controls="details"></button></nav><div class="totals" id="totals"></div><section id="usage-waiting" class="usage-waiting" role="status" hidden></section><section id="overview" role="tabpanel"><div class="section-head"><div><h2 id="activity-title"></h2><div class="muted" id="heat-sub"></div></div><div class="chart-controls"><div class="seg" id="heat-controls"><button data-heat="day"></button><button data-heat="week"></button></div><div class="year-picker"><button id="year" type="button" class="year-trigger" aria-label="Year" aria-haspopup="listbox" aria-controls="year-menu" aria-expanded="false"><span id="year-label"></span><svg class="year-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="year-menu" class="year-menu" role="listbox" aria-label="Year" popover="manual"></div></div></div></div><div class="heat-wrap"><div class="calendar"><div class="months" id="months"></div><div class="heat-row"><div class="weekdays" id="weekdays"></div><div class="heat" id="heat"></div></div></div></div><div class="heat-footer"><span id="heat-summary"></span><div class="scale"><span id="less"></span><i class="swatch"></i><i class="swatch" data-level="1"></i><i class="swatch" data-level="2"></i><i class="swatch" data-level="3"></i><i class="swatch" data-level="4"></i><span id="more"></span></div></div><div class="selected"><div><div class="title" id="selection-title"></div><span class="muted" id="selection-value"></span></div><button id="selection-details"></button></div></section><section id="details" role="tabpanel" hidden><div class="section-head"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><h2 id="detail-title"></h2><div class="dim-toggle" id="dim-controls"><button id="dim-model" type="button" data-dim="model"></button><button id="dim-user" type="button" data-dim="user"></button></div><div class="dim-toggle" id="model-view-controls"><button id="model-view-simple" type="button" data-model-view="simple"></button><button id="model-view-detailed" type="button" data-model-view="detailed"></button></div></div><div class="chart-controls"><div class="range"><button id="previous" aria-label="Previous">‹</button><strong id="range-label"></strong><button id="next" aria-label="Next">›</button></div><div id="custom-range-controls" class="custom-range-controls" hidden></div><div class="seg" id="period-controls"><button data-period="day"></button><button data-period="week"></button><button data-period="month"></button><button data-period="custom"></button></div></div></div><div class="legend" id="legend"></div><div class="chart-wrap"><div class="chart"><div class="axis" id="axis"></div><div class="plot" id="plot"></div></div></div><div class="hourly-section" id="hourly-section"><div class="hourly-header"><button id="hourly-toggle" type="button" class="hourly-toggle" aria-expanded="false"><span id="hourly-toggle-title"></span><span id="hourly-title"></span><span id="hourly-subtitle" class="muted"></span><svg class="hourly-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div class="hourly-mode-seg" id="hourly-mode-controls"><button id="hourly-mode-combined" type="button" data-hourly-mode="combined"></button><button id="hourly-mode-today" type="button" data-hourly-mode="today"></button></div></div><div id="hourly-content" class="hourly-content" hidden><div class="hourly-chart-wrap" id="hourly-chart"></div></div></div><div class="table-wrap"><table class="table"><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table></div><div class="manual-section" id="manual-section"><div class="section-head"><h2 id="manual-title"></h2></div><div class="table-wrap"><table class="table" id="manual-table"><thead><tr id="manual-table-head"></tr></thead><tbody id="manual-table-body"></tbody></table></div></div></section><div id="manual-modal" class="modal-layer" hidden></div><div class="alert" id="alert" hidden></div><footer class="footer"><span id="coverage"></span><span id="timezone"></span></footer><div class="tip" id="tip" role="status" hidden></div>`);view.append(page);
  const el=(tag,attrs={})=>{const n=document.createElement(tag);for(const [k,v]of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(v!==false&&v!=null)n.setAttribute(k,v===true?'':String(v));}return n;};
  const accSelect=el('select',{id:'account-switcher',class:'account-switcher','aria-label':'Account',hidden:true});
  page.querySelector('#account-switcher-slot').replaceWith(accSelect);
  page.querySelector('#custom-range-controls').append(
    el('input',{type:'date',id:'custom-start','aria-label':'Start date'}),
    el('span',{text:'–'}),
    el('input',{type:'date',id:'custom-end','aria-label':'End date'})
  );
  const modalCard=el('div',{class:'modal-card'}),manualForm=el('form',{class:'modal-form',id:'manual-form'});
  const makeField=(rowAttrs,lblId,inputNode)=>{const row=el('div',rowAttrs),lbl=el('label',{for:inputNode.id,id:lblId});row.append(lbl,inputNode);return row;};
  const accRow=makeField({class:'form-row',id:'manual-account-row'},'lbl-account',el('select',{id:'manual-account'}));
  const projRow=makeField({class:'form-row'},'lbl-project',el('input',{type:'text',id:'manual-project',required:true}));
  const dtRow=makeField({class:'form-row'},'lbl-datetime',el('input',{type:'datetime-local',id:'manual-datetime',required:true}));
  const modelRow=makeField({class:'form-row'},'lbl-model',el('input',{type:'text',id:'manual-model',list:'manual-model-list',required:true}));
  modelRow.append(el('datalist',{id:'manual-model-list'}));
  const twoCol=el('div',{class:'form-row two-col'});
  for(const [fid,lid]of [['manual-prompt','lbl-prompt'],['manual-completion','lbl-completion']]){
    const cell=el('div');cell.append(el('label',{for:fid,id:lid}),el('input',{type:'number',id:fid,min:'0',required:true}));twoCol.append(cell);
  }
  const cacheRow=makeField({class:'form-row'},'lbl-cache',el('input',{type:'number',id:'manual-cache',min:'0'}));
  const noteRow=makeField({class:'form-row'},'lbl-note',el('input',{type:'text',id:'manual-note'}));
  const modalActions=el('div',{class:'modal-actions'});
  modalActions.append(el('button',{type:'button',id:'manual-cancel'}),el('button',{type:'submit',id:'manual-submit',class:'btn-primary'}));
  manualForm.append(accRow,projRow,dtRow,modelRow,twoCol,cacheRow,noteRow,modalActions);
  modalCard.append(el('h3',{class:'modal-title',id:'manual-modal-title'}),manualForm);
  page.querySelector('#manual-modal').append(modalCard);
  const intro=document.createElement('section');intro.id='usage-intro';intro.className='usage-intro';intro.hidden=true;intro.setAttribute('aria-labelledby','usage-intro-title');
  setMarkup(intro,'<div class="intro-heading"><span class="intro-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0"/></svg></span><h2 id="usage-intro-title"></h2></div><div class="intro-copy"><p id="usage-intro-history"></p><p id="usage-intro-scope"></p><p id="usage-intro-storage"></p></div><div class="intro-bottom"><span id="usage-intro-error" role="status"></span><button id="usage-intro-done" type="button"></button></div>');
  page.querySelector('.top').after(intro);
  css.textContent+=`
    .usage-intro{margin:18px 0 0;padding:17px 20px 14px;border:1px solid var(--pulse-border);border-radius:12px;background:var(--pulse-control)}.usage-intro[hidden]{display:none}
    .intro-heading{display:flex;align-items:center;gap:9px;margin-bottom:9px}.intro-heading h2{font-size:13px;font-weight:550;margin:0}.intro-mark{display:flex;color:var(--pulse-accent)}.intro-mark svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
    .intro-copy{display:grid;gap:5px;color:var(--pulse-muted);font-size:11px;line-height:1.65}.intro-copy p{margin:0}.intro-bottom{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:11px}.intro-bottom span{margin-right:auto;color:var(--pulse-warning);font-size:11px}
    #usage-intro-done{padding:6px 13px;min-height:30px;border:1px solid var(--pulse-border);border-radius:7px;background:var(--pulse-hover);color:var(--pulse-foreground);font:inherit;font-size:11px;cursor:pointer;transition:background-color 140ms ease,transform 120ms ease}#usage-intro-done:hover{background:var(--pulse-selected)}#usage-intro-done:active{transform:scale(.98)}#usage-intro-done:disabled{opacity:.55;cursor:wait}
    @media(max-width:520px){.usage-intro{padding:14px}.intro-bottom{align-items:flex-start}.intro-bottom span{line-height:1.5}}
  `;
  const $=id=>view.getElementById(id),text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
  let value=null,tab='overview',heatMode='day',period='day',year=null,anchor=null,selected=null,disabledModels=new Set(),disabledUsers=new Set(),dimension='model',modelViewMode='simple',expandedModelGroups=new Set(),hourlyMode='combined',lastKey='',busy=false,opener=null;
  let showAllModels=false,selectedBar=null,hourlyExpanded=false,customStart='',customEnd='';
  let disposed=false,refreshMotion=null,refreshDelay=null,finishRefresh=null,accountKey=null,tipTarget=null,tipItem=null;
  const zh=()=>language.language==='zh-CN',w=(cn,en)=>zh()?cn:en;
  let guideSaving=false,guideError=false,guideSignature=null;
  const replayGuide=window.__agPulseUsageGuidePreview===true;
  function renderGuide(){
    const signature=language.language+'|'+themeSignature();
    if(replayGuide&&signature!==guideSignature){guideDismissed=false;guideError=false;}
    guideSignature=signature;intro.hidden=guideDismissed;
    text('usage-intro-title',w('先了解你的用量统计','About your token usage'));
    text('usage-intro-history',w('自动汇总当前账号可读取的本地历史对话，再持续记录新请求；已删除或缺失的历史可能无法补齐。','Available local conversations for this account are imported automatically, then new requests are recorded. Deleted or missing history may leave gaps.'));
    text('usage-intro-scope',w('统计仅代表本机已记录的 Token 用量，不是账户账单；天、周、月均按 UTC+8 划分。','Totals cover usage recorded on this device, not account billing. Days, weeks and months use UTC+8.'));
    text('usage-intro-storage',w('只在本地保存时间、模型和用量，不保存对话正文。删除对话不会扣除已记录的用量。','Only times, models and usage counters are saved locally, never conversation text. Deleting a chat does not subtract usage already recorded.'));
    text('usage-intro-done',guideSaving?w('保存中…','Saving…'):w('知道了','Got it'));
    text('usage-intro-error',guideError?w('未能保存，请再试一次。','Could not save. Please try again.'):'' );
    $('usage-intro-done').disabled=guideSaving;$('usage-intro-done').setAttribute('aria-busy',String(guideSaving));
  }
  function dismissGuide(){
    if(disposed)return;const focused=view.activeElement===$('usage-intro-done');guideDismissed=true;renderGuide();
    if(focused&&dialog.open)$('overview-tab').focus({preventScroll:true});
  }
  $('usage-intro-done').addEventListener('click',async()=>{
    if(guideSaving||disposed)return;guideSaving=true;guideError=false;renderGuide();
    try{await onDismissGuide();dismissGuide();}catch{if(!disposed)guideError=true;}
    finally{guideSaving=false;if(!disposed)renderGuide();}
  });
  const full=n=>Number(n||0).toLocaleString(zh()?'zh-CN':'en-US');
  const compact=n=>{n=Number(n||0);const limits=[[1e9,'B'],[1e6,'M'],[1e3,'K']];for(const [base,suffix]of limits)if(n>=base)return (n/base).toFixed(1).replace(/\.0$/,'')+suffix;return full(n);};
  const add=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  const week=date=>{const d=new Date(date+'T00:00:00Z');return add(date,-((d.getUTCDay()+6)%7));};
  const month=(date,shift)=>{const d=new Date(date.slice(0,7)+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+shift);return d.toISOString().slice(0,10);};
  const modelName=model=>model.replace(/-n$/,'').replace(/^gemini-/i,'Gemini ').replace(/^claude-/i,'Claude ').replace(/^gpt-/i,'GPT ').replace(/-/g,' ');
  const MODEL_TOKEN_CASE={claude:'Claude',opus:'Opus',sonnet:'Sonnet',haiku:'Haiku',gemini:'Gemini',flash:'Flash',pro:'Pro',argon:'Argon',hydrogen:'Hydrogen',carbon:'Carbon',gpt:'GPT',oss:'OSS'};
  const baseModelCache=new Map();
  const baseModelName=rawModel=>{
    const raw=String(rawModel||'').trim();
    if(!raw)return '';
    const cached=baseModelCache.get(raw);
    if(cached!==undefined)return cached;
    let s=raw;
    const parenSuffix=/\s*\((?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:\b[^)]*)?|exp(?:erimental)?(?:\b[^)]*)?|fast|lite|quality|\d{4}-\d{2}-\d{2})\)\s*$/i;
    const bareSuffix=/(?:[\s-]+(?:xhigh|high|medium|low|thinking|tiered|trial|preview(?:[\s-]+[a-z0-9]{1,10})*|exp(?:erimental)?(?:[\s-]+[a-z0-9]{1,10})*|latest|n|\d{4}-\d{2}-\d{2}|\d{8}))$/i;
    for(let i=0;i<8;i++){
      const next=s.replace(parenSuffix,'').replace(bareSuffix,'').trim();
      if(next===s||!next)break;
      s=next;
    }
    s=s.replace(/(?<![\d.])(\d)-(\d)(?![\d.])/g,'$1.$2');
    s=s.replace(/-(?![^(]*\))/g,' ').replace(/\s+/g,' ').trim();
    s=s.split(' ').map(tok=>MODEL_TOKEN_CASE[tok.toLowerCase()]||(/^\d+b$/i.test(tok)?tok.toUpperCase():tok)).join(' ');
    const out=s||raw;
    if(baseModelCache.size>2000)baseModelCache.clear();
    baseModelCache.set(raw,out);
    return out;
  };
  const effectiveModelKey=rawModel=>modelViewMode==='simple'?baseModelName(rawModel):rawModel;
  const modelLabel=key=>modelViewMode==='simple'?key:modelName(key);
  const variantLabel=(rawModel,groupKey)=>{const formatted=modelName(rawModel);return formatted.toLowerCase()===groupKey.toLowerCase()&&formatted!==rawModel?`${formatted} (${rawModel})`:formatted;};
  const themeSignature=()=>{const s=getComputedStyle(root.host||dialog);return [s.getPropertyValue('--pulse-accent'),s.getPropertyValue('--pulse-background'),root.host?.dataset.pulseTheme].join('|');};
  let paletteKey='',modelColors=new Map(),groupColors=new Map(),userColors=new Map();
  const colorCanvas=document.createElement('canvas');colorCanvas.width=colorCanvas.height=1;
  const colorContext=colorCanvas.getContext('2d',{willReadFrequently:true});
  const rgb=css=>{colorContext.clearRect(0,0,1,1);colorContext.fillStyle='#000';colorContext.fillStyle=css;colorContext.fillRect(0,0,1,1);return [...colorContext.getImageData(0,0,1,1).data].slice(0,3);};
  const luminance=a=>a.reduce((sum,v,i)=>{v/=255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i];},0);
  const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  const hsl=a=>{const [r,g,b]=a.map(v=>v/255),hi=Math.max(r,g,b),lo=Math.min(r,g,b),d=hi-lo,l=(hi+lo)/2;return [d?((hi===r?(g-b)/d+(g<b?6:0):hi===g?(b-r)/d+2:(r-g)/d+4)*60):0,d?d/(1-Math.abs(2*l-1)):0,l];};
  const fromHsl=(h,s,l)=>{const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))));};return [f(0),f(8),f(4)];};
  const buildAccentColor=(hue,sat,light,bg,end)=>{
    let c=fromHsl(hue,sat,light);
    for(let step=0;contrast(c,bg)<3&&step<100;step++){light=Math.max(0,Math.min(1,light+(end?.005:-.005)));c=fromHsl(hue,sat,light);}
    return 'rgb('+c.join(' ')+')';
  };
  function syncPalette(){
    const rawSet=new Set(value?.models||[]);
    for(const d of value?.days||[])for(const m of Object.keys(d?.models||{}))rawSet.add(m);
    const models=[...rawSet].sort(),groupModels=[...new Set(models.map(baseModelName))].sort(),users=[...(value?.users||[])].sort();
    const key=themeSignature()+'|'+modelViewMode+'|'+models.join('|')+'|'+groupModels.join('|')+'|'+users.join('|');
    if(key===paletteKey)return;paletteKey=key;modelColors.clear();groupColors.clear();userColors.clear();
    const style=getComputedStyle(root.host||dialog),base=rgb(style.getPropertyValue('--pulse-accent').trim()||'#85a8ff'),background=rgb(style.getPropertyValue('--pulse-background').trim()||'#1c1d1f'),[h,s]=hsl(base);
    const dark=luminance(background)<.35,offsets=[0,-18,18,-36,36,-9,9,-27,27],tones=dark?[.64,.52,.73,.59,.68]:[.43,.33,.51,.38,.47];
    const end=contrast([255,255,255],background)>contrast([0,0,0],background)?1:0,sat=s<.08?.07:Math.max(.28,Math.min(.55,s*.72));
    models.forEach((model,i)=>modelColors.set(model,buildAccentColor((h+offsets[i%offsets.length]+360)%360,sat,tones[i%tones.length],background,end)));
    groupModels.forEach((group,i)=>groupColors.set(group,buildAccentColor((h+offsets[i%offsets.length]+360)%360,sat,tones[i%tones.length],background,end)));
    users.filter(u=>u!=='legacy').forEach((u,i)=>userColors.set(u,buildAccentColor((h+offsets[i%offsets.length]+180)%360,sat,tones[i%tones.length],background,end)));
    userColors.set('legacy','var(--pulse-muted)');
  }
  const color=model=>(modelViewMode==='simple'?(groupColors.get(model)||modelColors.get(model)):(modelColors.get(model)||groupColors.get(model)))||'var(--pulse-accent)';
  const userColor=u=>userColors.get(u)||(u==='legacy'?'var(--pulse-muted)':'var(--pulse-accent)');
  const userDisplayName=u=>u==='legacy'?w('早期历史未区分用量','Legacy unassigned'):(value?.userMeta?.[u]?.email||value?.userMeta?.[u]?.name||u);
  let dayMap=new Map(),sortedDays=[];
  const rebuildDayIndex=()=>{
    dayMap.clear();const list=[];
    for(const day of value?.days||[])if(day?.date){dayMap.set(day.date,day);list.push(day);}
    list.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
    sortedDays=list;
  };
  const totals=(from,to,filter=false)=>{
    const models={},modelVariants={},users={};let legacyTokens=0,total=0,requests=0;
    const accum=day=>{
      if(!day)return;
      legacyTokens+=day.legacyTokens||0;
      for(const [rawModel,r]of Object.entries(day.models||{})){
        const key=dimension==='model'?effectiveModelKey(rawModel):rawModel;
        if(filter&&dimension==='model'&&disabledModels.has(key))continue;
        let m=models[key];if(!m)m=models[key]={total:0,requests:0,uncached:0,cacheRead:0,cacheWrite:0,output:0};
        for(const k of Object.keys(m))m[k]+=r[k]||0;
        if(dimension==='model'){
          const gv=modelVariants[key]||(modelVariants[key]={});
          let v=gv[rawModel];if(!v)v=gv[rawModel]={total:0,requests:0,uncached:0,cacheRead:0,cacheWrite:0,output:0};
          for(const k of Object.keys(v))v[k]+=r[k]||0;
        }
        if(dimension!=='user'){total+=r.total||0;requests+=r.requests||0;}
      }
      for(const [u,r]of Object.entries(day.users||{})){
        if(filter&&dimension==='user'&&disabledUsers.has(u))continue;
        let usr=users[u];if(!usr)usr=users[u]={name:r.name,userKey:u,isLegacy:r.isLegacy,total:0,requests:0,uncached:0,cacheRead:0,cacheWrite:0,output:0};
        for(const key of ['total','requests','uncached','cacheRead','cacheWrite','output'])usr[key]+=r[key]||0;
        if(dimension==='user'){total+=r.total||0;requests+=r.requests||0;}
      }
    };
    if(from===to){
      accum(dayMap.get(from));
    }else if(from<=to&&sortedDays.length){
      let lo=0,hi=sortedDays.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(sortedDays[mid].date<from)lo=mid+1;else hi=mid;}
      for(let i=lo;i<sortedDays.length;i++){const d=sortedDays[i];if(d.date>to)break;accum(d);}
    }
    return {from,to,models,modelVariants,users,legacyTokens,total,requests};
  };
  const node=(tag,className,content)=>{const n=document.createElement(tag);if(className)n.className=className;if(content!==undefined)n.textContent=content;return n;};
  function tooltip(bucket,target,activeItem=null){
    if(!$('tip').hidden&&tipTarget===target&&tipItem===activeItem)return;tipTarget=target;tipItem=activeItem;
    highlightItem(activeItem);
    const tip=$('tip');tip.replaceChildren(node('div','tip-title',bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to),node('strong','',full(bucket.total)+' Token'),node('div','muted',w(`${bucket.requests} 次请求`,`${bucket.requests} requests`)));
    if(dimension==='user'){
      for(const [u,r]of Object.entries(bucket.users||{}).sort((a,b)=>b[1].total-a[1].total)){
        const row=node('div','tip-model'+(activeItem?(activeItem===u?' active':' dimmed'):'')),label=node('span',''),dot=node('i','dot'),amount=node('span','',compact(r.total));dot.style.setProperty('--model-color',userColor(u));if(u==='legacy')dot.classList.add('legacy');label.append(dot,document.createTextNode(userDisplayName(u)));amount.append(node('span','model-share',bucket.total?(r.total/bucket.total*100).toFixed(1)+'%':'0%'));row.append(label,amount);tip.append(row);
      }
    }else{
      for(const [model,r]of Object.entries(bucket.models||{}).sort((a,b)=>b[1].total-a[1].total)){
        const row=node('div','tip-model'+(activeItem?(activeItem===model?' active':' dimmed'):'')),label=node('span',''),dot=node('i','dot'),amount=node('span','',compact(r.total));dot.style.setProperty('--model-color',color(model));label.append(dot,document.createTextNode(modelLabel(model)));amount.append(node('span','model-share',bucket.total?(r.total/bucket.total*100).toFixed(1)+'%':'0%'));row.append(label,amount);tip.append(row);
      }
    }
    tip.hidden=false;const rect=target.getBoundingClientRect(),bounds=dialog.getBoundingClientRect(),r=tip.getBoundingClientRect();
    tip.style.left=Math.min(bounds.right-r.width-12,Math.max(bounds.left+12,rect.left+rect.width/2-r.width/2))+'px';
    tip.style.top=Math.max(bounds.top+12,rect.top-r.height-10)+'px';
  }
  const bindBucket=(button,bucket)=>{
    button.setAttribute('aria-label',(bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to)+': '+full(bucket.total)+' Token');
    button.addEventListener('pointerenter',()=>tooltip(bucket,button));button.addEventListener('pointerleave',()=>{$('tip').hidden=true;highlightItem(null);});button.addEventListener('focus',()=>tooltip(bucket,button));button.addEventListener('blur',()=>{$('tip').hidden=true;highlightItem(null);});
    button.addEventListener('pointermove',event=>{
      const seg=event.target.closest?.('.bar-segment');
      const item=dimension==='user'?(seg?.dataset.user||null):(seg?.dataset.model||null);
      tooltip(bucket,button,item);
    });
    button.addEventListener('click',()=>{selected=bucket;anchor=bucket.from;showSelection();});
  };
  function showSelection(){const bucket=selected||totals(value.today,value.today);text('selection-title',bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to);text('selection-value',full(bucket.total)+' Token · '+w(`${bucket.requests} 次请求`,`${bucket.requests} requests`));}
  function renderHeat(){
    if(!value)return;
    const start=week(year+'-01-01'),end=year+'-12-31',weeks=Math.floor((Date.parse(end)-Date.parse(start))/604800000)+1;
    $('heat').className='heat'+(heatMode==='week'?' week':'');
    $('heat').style.gridTemplateColumns=`repeat(${weeks},minmax(0,1fr))`;
    if(heatMode==='week')$('heat').style.setProperty('grid-template-columns',`repeat(${Math.ceil(weeks/2)},minmax(0,1fr))`,'important');
    const buckets=[],heatFrag=document.createDocumentFragment();
    for(let i=0;i<(heatMode==='day'?weeks*7:weeks);i++){
      const date=add(start,heatMode==='day'?i:i*7),to=heatMode==='day'?date:add(date,6);
      buckets.push(heatMode==='day'?totals(date,date):totals(date<year+'-01-01'?year+'-01-01':date,to>end?end:to));
    }
    const max=Math.max(1,...buckets.map(b=>b.total));
    let lastActiveBtn=null,lastUsableBtn=null;
    for(const bucket of buckets){
      const button=node('button','');button.type='button';const future=bucket.from>value.today||bucket.to<year+'-01-01'||bucket.from>year+'-12-31';
      button.dataset.level=bucket.total===0?'0':String(Math.min(4,Math.ceil(bucket.total/max*4)));
      if(future){button.className='future';button.disabled=true;}
      else{bindBucket(button,bucket);lastUsableBtn=button;if(button.dataset.level!=='0')lastActiveBtn=button;}
      button.tabIndex=-1;heatFrag.append(button);
    }
    if(lastActiveBtn||lastUsableBtn)(lastActiveBtn||lastUsableBtn).tabIndex=0;
    $('heat').replaceChildren(heatFrag);
    const monthsFrag=document.createDocumentFragment(),weekdaysFrag=document.createDocumentFragment();
    if(heatMode==='day'){
      $('months').style.gridTemplateColumns=`repeat(${weeks},minmax(0,1fr))`;
      for(let m=1;m<=12;m++){const date=`${year}-${String(m).padStart(2,'0')}-01`,col=Math.floor((Date.parse(date)-Date.parse(start))/604800000)+1;
        const label=node('span','',zh()?m+'月':['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]);label.style.gridColumn=col;label.style.gridRow=1;monthsFrag.append(label);}
      for(let i=0;i<7;i++)weekdaysFrag.append(node('span','',i%2===0?(zh()?['一','','三','','五','','日'][i]:['M','','W','','F','','S'][i]):''));
    }
    $('months').replaceChildren(monthsFrag);$('weekdays').replaceChildren(weekdaysFrag);
    text('heat-sub',heatMode==='day'?w('每格代表一天','Each square is one day'):w('每格代表一周 · 周一开始','Each square is one week · starts Monday'));
    const annual=totals(year+'-01-01',year+'-12-31');text('heat-summary',w(`${year} 年 · ${full(annual.total)} Token`,`${year} · ${full(annual.total)} tokens`));
    for(const b of view.querySelectorAll('[data-heat]'))b.setAttribute('aria-pressed',String(b.dataset.heat===heatMode));showSelection();
  }
  function highlightItem(item){
    if(item)$('plot').dataset.highlight=item;else delete $('plot').dataset.highlight;
    const attr=dimension==='user'?'user':'model';
    for(const bar of $('plot').querySelectorAll('.bar-segment')){if(item&&bar.dataset[attr]===item)bar.dataset.highlight='true';else delete bar.dataset.highlight;}
  }
  const chartSummary=node('div','chart-summary');$('detail-title').after(chartSummary);
  const resetDrilldown=node('button','reset-drilldown',w('显示全部时段','Show all'));resetDrilldown.id='reset-drilldown';resetDrilldown.hidden=true;
  resetDrilldown.addEventListener('click',()=>{selectedBar=null;updateDrilldownView();});
  const chartHeading=node('div','');$('detail-title').before(chartHeading);chartHeading.append($('detail-title'),chartSummary,resetDrilldown);
  let currentBuckets=[];
  function renderChartSummaryAndTable(){
    if(!value||!currentBuckets.length)return;
    $('reset-drilldown').hidden=!selectedBar;
    $('reset-drilldown').textContent=w('显示全部时段','Show all');
    const activeTotals=selectedBar?totals(selectedBar.from,selectedBar.to,true):totals(currentBuckets[0].from,currentBuckets.at(-1).to,true);
    const rangeLabelStr=selectedBar?(selectedBar.from===selectedBar.to?selectedBar.from:selectedBar.from+' – '+selectedBar.to):'';
    chartSummary.replaceChildren(node('strong','',compact(activeTotals.total)+' Token'),document.createTextNode(' · '+w(`${full(activeTotals.requests)} 次请求`,`${full(activeTotals.requests)} requests`)+(rangeLabelStr?' · '+rangeLabelStr:'')));
    const focusedGroup=view.activeElement?.closest?.('tr.model-group-row')?.dataset?.modelGroup||null;
    const bodyFrag=document.createDocumentFragment();
    if(dimension==='user'){
      $('table-head').replaceChildren(...[w('用户 / 账号','User / Account'),w('总 Token','Total tokens'),w('占比','Share'),w('未缓存输入','Uncached input'),w('缓存读取','Cache read'),w('输出','Output'),w('请求次数','Requests')].map(label=>node('th','',label)));
      for(const [u,r]of Object.entries(activeTotals.users).sort((a,b)=>b[1].total-a[1].total)){
        const row=node('tr',''),label=node('td',''),dot=node('span','dot');dot.style.setProperty('--model-color',userColor(u));if(u==='legacy')dot.classList.add('legacy');label.append(dot,document.createTextNode(userDisplayName(u)));
        const share=activeTotals.total?(r.total/activeTotals.total*100).toFixed(1)+'%':'0%';
        row.append(label,node('td','',full(r.total)),node('td','',share),node('td','',full(r.uncached)),node('td','',full(r.cacheRead)),node('td','',full(r.output)),node('td','',full(r.requests)));
        bodyFrag.append(row);
      }
    }else if(modelViewMode==='detailed'){
      $('table-head').replaceChildren(...[w('模型','Model'),w('总 Token','Total tokens'),w('未缓存输入','Uncached input'),w('缓存读取','Cache read'),w('缓存写入','Cache write'),w('输出','Output')].map(label=>node('th','',label)));
      for(const [model,r]of Object.entries(activeTotals.models).sort((a,b)=>b[1].total-a[1].total)){
        const row=node('tr',''),label=node('td',''),dot=node('span','dot');dot.style.setProperty('--model-color',color(model));label.append(dot,document.createTextNode(modelName(model)));row.append(label,...[r.total,r.uncached,r.cacheRead,r.cacheWrite,r.output].map(n=>node('td','',full(n))));bodyFrag.append(row);
      }
    }else{
      $('table-head').replaceChildren(...[w('模型','Model'),w('总 Token','Total tokens'),w('未缓存输入','Uncached input'),w('缓存读取','Cache read'),w('缓存写入','Cache write'),w('输出','Output')].map(label=>node('th','',label)));
      for(const [groupKey,r]of Object.entries(activeTotals.models).sort((a,b)=>b[1].total-a[1].total)){
        const variants=Object.entries(activeTotals.modelVariants?.[groupKey]||{}).sort((a,b)=>b[1].total-a[1].total||a[0].localeCompare(b[0]));
        const isExpanded=expandedModelGroups.has(groupKey);
        const row=node('tr','model-group-row');
        row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-expanded',String(isExpanded));row.dataset.modelGroup=groupKey;
        const toggle=()=>{if(expandedModelGroups.has(groupKey))expandedModelGroups.delete(groupKey);else expandedModelGroups.add(groupKey);renderChartSummaryAndTable();};
        row.addEventListener('click',toggle);
        row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}});
        const label=node('td',''),dot=node('span','dot');dot.style.setProperty('--model-color',color(groupKey));
        const countText=w(`${variants.length} 个后缀`,`${variants.length} ${variants.length===1?'variant':'variants'}`);
        const chevron=node('span','model-group-chevron',isExpanded?'▾':'▸');chevron.setAttribute('aria-hidden','true');
        label.append(dot,node('span','model-group-name',groupKey),node('span','model-variant-count',countText),chevron);
        row.append(label,...[r.total,r.uncached,r.cacheRead,r.cacheWrite,r.output].map(n=>node('td','',full(n))));
        bodyFrag.append(row);
        if(isExpanded){
          for(const [rawModel,vr]of variants){
            const vRow=node('tr','model-variant-row'),vLabel=node('td','');
            const branch=node('span','variant-branch','└');branch.setAttribute('aria-hidden','true');
            const share=r.total?(vr.total/r.total*100).toFixed(1)+'%':'0%';
            vLabel.append(branch,node('span','variant-name',variantLabel(rawModel,groupKey)),node('span','variant-share',share));
            vRow.append(vLabel,...[vr.total,vr.uncached,vr.cacheRead,vr.cacheWrite,vr.output].map(n=>node('td','',full(n))));
            bodyFrag.append(vRow);
          }
        }
      }
    }
    $('table-body').replaceChildren(bodyFrag);
    if(focusedGroup){
      for(const tr of $('table-body').querySelectorAll('tr.model-group-row')){
        if(tr.dataset.modelGroup===focusedGroup){tr.focus({preventScroll:true});break;}
      }
    }
  }
  function updateDrilldownView(){
    for(const col of $('plot').querySelectorAll('.bar-column')){
      const active=Boolean(selectedBar&&col.dataset.from===selectedBar.from&&col.dataset.to===selectedBar.to);
      col.classList.toggle('selected',active);
      col.setAttribute('aria-pressed',String(active));
    }
    renderChartSummaryAndTable();
    renderHourly();
  }
  function renderChart(){
    if(!value)return;syncPalette();$('tip').hidden=true;highlightItem(null);
    const buckets=[];
    if(period==='day'){const start=month(anchor,0),end=add(month(anchor,1),-1);for(let date=start;date<=end;date=add(date,1))buckets.push(totals(date,date,true));text('range-label',start.slice(0,7));}
    else if(period==='week'){const start=add(week(anchor),-11*7);for(let i=0;i<12;i++){const from=add(start,i*7);buckets.push(totals(from,add(from,6),true));}text('range-label',start.slice(5)+' – '+add(week(anchor),6).slice(5));}
    else if(period==='month'){for(let i=-11;i<=0;i++){const from=month(anchor,i);buckets.push(totals(from,add(month(from,1),-1),true));}text('range-label',buckets[0].from.slice(0,7)+' – '+month(anchor,0).slice(0,7));}
    else if(period==='custom'){
      customStart||=add(value.today,-14);customEnd||=value.today;
      for(let date=customStart;date<=customEnd;date=add(date,1))buckets.push(totals(date,date,true));
      text('range-label',customStart+' – '+customEnd);
    }
    currentBuckets=buckets;
    if(buckets.length>31){
      $('plot').style.minWidth=(buckets.length*24)+'px';
      view.querySelector('.chart').style.minWidth=(buckets.length*24+60)+'px';
      view.querySelector('.chart-wrap').style.scrollBehavior='smooth';
    }else{
      $('plot').style.minWidth='';
      view.querySelector('.chart').style.minWidth='';
      view.querySelector('.chart-wrap').style.scrollBehavior='';
    }
    $('custom-range-controls').hidden=period!=='custom';
    view.querySelector('.range').hidden=period==='custom';
    $('custom-start').value=customStart;$('custom-end').value=customEnd;
    $('custom-start').max=value.today;$('custom-end').max=value.today;
    $('previous').disabled=period==='custom';
    $('next').disabled=period==='custom'?true:period==='week'?week(anchor)>=week(value.today):anchor.slice(0,7)>=value.today.slice(0,7);
    $('dim-model').setAttribute('aria-pressed',String(dimension==='model'));
    $('dim-user').setAttribute('aria-pressed',String(dimension==='user'));
    text('dim-model',w('按模型统计','By Model'));
    text('dim-user',w('按用户统计','By User'));
    $('model-view-controls').hidden=dimension!=='model';
    $('model-view-simple').setAttribute('aria-pressed',String(modelViewMode==='simple'));
    $('model-view-detailed').setAttribute('aria-pressed',String(modelViewMode==='detailed'));
    text('model-view-simple',w('简易','Simple'));
    text('model-view-detailed',w('详细','Detailed'));
    text('detail-title',dimension==='model'?w('按模型统计','Usage by model'):w('按用户统计','Usage by user'));
    const allRangeTotals=totals(buckets[0].from,buckets.at(-1).to,false),legendFrag=document.createDocumentFragment();
    const modelKeys=dimension==='user'?[]:[...new Set([...(value.models||[]).map(effectiveModelKey),...Object.keys(allRangeTotals.models)])];
    if(dimension==='user'){
      const activeUserSet=new Set(Object.keys(allRangeTotals.users).filter(u=>allRangeTotals.users[u].total>0));
      const inRangeUsers=(value.users||[]).filter(u=>activeUserSet.has(u));
      for(const u of inRangeUsers){
        const button=node('button',''),dot=node('i','dot');
        dot.style.setProperty('--model-color',userColor(u));
        if(u==='legacy')dot.classList.add('legacy');
        button.append(dot,document.createTextNode(userDisplayName(u)));button.type='button';
        button.setAttribute('aria-pressed',String(!disabledUsers.has(u)));
        button.addEventListener('click',()=>{if(disabledUsers.has(u))disabledUsers.delete(u);else disabledUsers.add(u);renderChart();});
        button.addEventListener('pointerenter',()=>highlightItem(disabledUsers.has(u)?null:u));
        button.addEventListener('pointerleave',()=>highlightItem(null));
        legendFrag.append(button);
      }
    }else{
      const activeModelSet=new Set(Object.keys(allRangeTotals.models).filter(m=>allRangeTotals.models[m].total>0));
      const inRangeModels=modelKeys.filter(m=>activeModelSet.has(m));
      const otherModels=modelKeys.filter(m=>!activeModelSet.has(m));
      const makeModelBtn=model=>{
        const button=node('button',''),dot=node('i','dot');dot.style.setProperty('--model-color',color(model));
        button.append(dot,document.createTextNode(modelLabel(model)));button.type='button';
        button.setAttribute('aria-pressed',String(!disabledModels.has(model)));
        button.addEventListener('click',()=>{if(disabledModels.has(model))disabledModels.delete(model);else disabledModels.add(model);renderChart();});
        button.addEventListener('pointerenter',()=>highlightItem(disabledModels.has(model)?null:model));
        button.addEventListener('pointerleave',()=>highlightItem(null));
        return button;
      };
      for(const model of inRangeModels)legendFrag.append(makeModelBtn(model));
      if(otherModels.length>0){
        const updateToggleLabel=btn=>{btn.textContent=showAllModels?w('收起历史模型 ▲','Collapse historical models ▲'):w(`更多历史模型 (${otherModels.length}) ▼`,`More historical models (${otherModels.length}) ▼`);btn.setAttribute('aria-expanded',String(showAllModels));};
        const toggleBtn=node('button','toggle-all-models');
        toggleBtn.id='toggle-all-models';toggleBtn.type='button';updateToggleLabel(toggleBtn);
        const otherContainer=node('div','other-models');otherContainer.hidden=!showAllModels;
        toggleBtn.addEventListener('click',()=>{showAllModels=!showAllModels;updateToggleLabel(toggleBtn);otherContainer.hidden=!showAllModels;});
        for(const model of otherModels)otherContainer.append(makeModelBtn(model));
        legendFrag.append(toggleBtn,otherContainer);
      }
    }
    $('legend').replaceChildren(legendFrag);
    const max=Math.max(1,...buckets.map(b=>b.total)),ceiling=max>1?Math.ceil(max/(10**Math.floor(Math.log10(max))))*10**Math.floor(Math.log10(max)):1;
    const axisFrag=document.createDocumentFragment(),plotFrag=document.createDocumentFragment();
    for(let i=0;i<=4;i++){const label=node('span','',compact(ceiling*i/4));label.style.bottom=(19+(246-19)*i/4)+'px';axisFrag.append(label);const line=node('i','grid-line');line.style.bottom=(19+(246-19)*i/4)+'px';plotFrag.append(line);}
    for(const [i,bucket]of buckets.entries()){
      const button=node('button','bar-column');button.type='button';button.dataset.from=bucket.from;button.dataset.to=bucket.to;
      const isDrilled=Boolean(selectedBar&&selectedBar.from===bucket.from&&selectedBar.to===bucket.to);
      if(isDrilled)button.classList.add('selected');
      button.setAttribute('aria-pressed',String(isDrilled));
      const stack=node('div','stack');
      if(dimension==='user'){
        const segments=(value.users||[]).filter(u=>bucket.users[u]?.total>0&&!disabledUsers.has(u));
        for(const [j,u]of segments.entries()){
          const r=bucket.users[u],bar=node('i','bar-segment'),height=r.total/ceiling*227;
          bar.dataset.user=u;bar.setAttribute('aria-hidden','true');
          bar.style.setProperty('--model-color',userColor(u));
          if(u==='legacy')bar.classList.add('legacy');
          bar.style.height=height+'px';
          if(j&&height>=3)bar.style.boxShadow='inset 0 -1px 0 color-mix(in srgb,var(--pulse-background) 48%,transparent)';
          stack.append(bar);
        }
      }else{
        const segments=modelKeys.filter(model=>bucket.models[model]?.total>0&&!disabledModels.has(model));
        for(const [j,model]of segments.entries()){
          const r=bucket.models[model],bar=node('i','bar-segment'),height=r.total/ceiling*227;
          bar.dataset.model=model;bar.setAttribute('aria-hidden','true');
          bar.style.setProperty('--model-color',color(model));
          bar.style.height=height+'px';
          if(j&&height>=3)bar.style.boxShadow='inset 0 -1px 0 color-mix(in srgb,var(--pulse-background) 48%,transparent)';
          stack.append(bar);
        }
      }
      if(!bucket.total)stack.append(node('i','empty-bar'));button.append(stack);
      const showX=period==='day'?(i%3===0||i===buckets.length-1):period==='custom'?(buckets.length>31?i%Math.ceil(buckets.length/15)===0||i===buckets.length-1:true):true;
      if(showX)button.append(node('span','x-label',period==='day'?String(i+1):period==='week'?bucket.from.slice(5):period==='month'?bucket.from.slice(0,7):bucket.from.slice(5)));
      bindBucket(button,bucket);
      button.addEventListener('click',event=>{
        event.stopPropagation();
        if(selectedBar&&selectedBar.from===bucket.from&&selectedBar.to===bucket.to)selectedBar=null;
        else selectedBar=bucket;
        updateDrilldownView();
      });
      plotFrag.append(button);
    }
    if(!buckets.some(b=>b.total))plotFrag.append(node('div','chart-empty',w('所选时段暂无用量记录','No usage recorded in this period')));
    $('axis').replaceChildren(axisFrag);$('plot').replaceChildren(plotFrag);
    renderChartSummaryAndTable();
    for(const b of view.querySelectorAll('[data-period]'))b.setAttribute('aria-pressed',String(b.dataset.period===period));
    renderHourly();
  }
  function renderHourly(){
    const section=$('hourly-section');if(!section)return;
    text('hourly-toggle-title',w('小时用量趋势','Hourly trend'));
    text('hourly-mode-combined',w('时段合集','Period total'));
    text('hourly-mode-today',w('今日','Today'));
    $('hourly-mode-combined').setAttribute('aria-pressed',String(hourlyMode==='combined'));
    $('hourly-mode-today').setAttribute('aria-pressed',String(hourlyMode==='today'));
    $('hourly-toggle').setAttribute('aria-expanded',String(hourlyExpanded));
    $('hourly-content').hidden=!hourlyExpanded;
    let hours=null;
    if(hourlyMode==='today'){
      hours=value.todayHours||dayMap.get(value.today)?.hours;
      text('hourly-title',w('今日 24 小时用量趋势',"Today's 24-Hour Trend"));
    }else{
      const isSingleDay=selectedBar&&selectedBar.from===selectedBar.to;
      if(isSingleDay){
        const targetDate=selectedBar.from,day=dayMap.get(targetDate);
        hours=day?.hours||(targetDate===value.today?value.todayHours:null);
        text('hourly-title',targetDate===value.today?w('今日 24 小时用量趋势',"Today's 24-Hour Trend"):w(`${targetDate} 24 小时用量趋势`,`${targetDate} 24-Hour Trend`));
      }else{
        hours=Array(24).fill(0);
        const start=selectedBar?selectedBar.from:(currentBuckets[0]?.from||value.today);
        const end=selectedBar?selectedBar.to:(currentBuckets.at(-1)?.to||value.today);
        if(start<=end&&sortedDays.length){
          let lo=0,hi=sortedDays.length;
          while(lo<hi){const mid=(lo+hi)>>1;if(sortedDays[mid].date<start)lo=mid+1;else hi=mid;}
          for(let i=lo;i<sortedDays.length;i++){
            const day=sortedDays[i];if(day.date>end)break;
            if(Array.isArray(day.hours))for(let h=0;h<24;h++)hours[h]+=(day.hours[h]||0);
          }
        }
        text('hourly-title',w('所选时段 24 小时聚合分布','Period 24-Hour Distribution')+(currentBuckets.length?` (${start} – ${end})`:''));
      }
    }
    if(!hours||!Array.isArray(hours)||hours.length<24)hours=Array(24).fill(0);
    const totalHourly=hours.reduce((n,c)=>n+c,0);
    const isSingleDay=hourlyMode==='today'||(selectedBar&&selectedBar.from===selectedBar.to);
    text('hourly-subtitle',!isSingleDay
      ?w(`${compact(totalHourly)} Token · 24小时合集用量`,`${compact(totalHourly)} tokens · 24-hour aggregate`)
      :w(`${compact(totalHourly)} Token · 每小时用量`,`${compact(totalHourly)} tokens · hourly distribution`));
    if(!hourlyExpanded)return;
    const maxVal=Math.max(1,...hours);
    const padL=40,padR=15,padT=15,padB=25,wPlot=560,hPlot=90,W=padL+wPlot+padR,H=padT+hPlot+padB;
    const baseY=padT+hPlot;
    const pts=hours.map((v,i)=>({x:padL+(i/23)*wPlot,y:baseY-(v/maxVal)*hPlot,val:v,hour:i}));
    let pathD=`M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for(let i=0;i<pts.length-1;i++){
      const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];
      let cp1x=p1.x+(p2.x-p0.x)/6,cp1y=p1.y+(p2.y-p0.y)/6,cp2x=p2.x-(p3.x-p1.x)/6,cp2y=p2.y-(p3.y-p1.y)/6;
      if(p1.val===0&&p2.val===0){
        cp1y=baseY;cp2y=baseY;
      }else{
        if(p1.val===0)cp1y=baseY;
        if(p2.val===0)cp2y=baseY;
        cp1y=Math.min(baseY,Math.max(padT,cp1y));
        cp2y=Math.min(baseY,Math.max(padT,cp2y));
      }
      pathD+=` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    const areaD=pathD+` L ${pts.at(-1).x.toFixed(1)},${baseY.toFixed(1)} L ${pts[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;
    const gridY=[0,0.5,1].map(r=>({y:padT+hPlot*(1-r),lbl:compact(maxVal*r)}));
    const svgNS='http://www.w3.org/2000/svg';
    const svgEl=(tag,attrs={},txt)=>{const n=document.createElementNS(svgNS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(txt!==undefined)n.textContent=txt;return n;};
    const svg=svgEl('svg',{viewBox:`0 0 ${W} ${H}`,width:'100%',height:H,preserveAspectRatio:'none'});
    svg.style.overflow='visible';
    const defs=svgEl('defs'),grad=svgEl('linearGradient',{id:'hourly-area-grad',x1:'0',y1:'0',x2:'0',y2:'1'});
    grad.append(
      svgEl('stop',{offset:'0%','stop-color':'var(--pulse-accent)','stop-opacity':'0.35'}),
      svgEl('stop',{offset:'100%','stop-color':'var(--pulse-accent)','stop-opacity':'0.01'})
    );
    defs.append(grad);svg.append(defs);
    for(const g of gridY){
      svg.append(
        svgEl('line',{x1:padL,y1:g.y.toFixed(1),x2:padL+wPlot,y2:g.y.toFixed(1),stroke:'var(--pulse-separator)','stroke-width':'1'}),
        svgEl('text',{x:padL-6,y:(g.y+3).toFixed(1),'text-anchor':'end',fill:'var(--pulse-muted)','font-size':'9'},g.lbl)
      );
    }
    svg.append(
      svgEl('path',{d:areaD,fill:'url(#hourly-area-grad)',class:'hourly-area'}),
      svgEl('path',{d:pathD,fill:'none',stroke:'var(--pulse-accent)','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round',class:'hourly-line'})
    );
    const crosshair=svgEl('line',{class:'hourly-crosshair',x1:'0',y1:padT,x2:'0',y2:baseY,stroke:'var(--pulse-accent)','stroke-opacity':'0.5','stroke-width':'1','stroke-dasharray':'2 2'});
    crosshair.style.opacity='0';
    const focusRing=svgEl('circle',{class:'hourly-focus-ring',cx:'0',cy:'0',r:'5.5',fill:'none',stroke:'var(--pulse-accent)','stroke-opacity':'0.65','stroke-width':'1.5'});
    focusRing.style.opacity='0';
    svg.append(crosshair);
    const circles=pts.map(p=>{
      const c=svgEl('circle',{class:'hourly-pt',cx:p.x.toFixed(1),cy:p.y.toFixed(1),r:p.val>0?'2.5':'1.5',fill:'var(--pulse-accent)','fill-opacity':p.val>0?'1':'0.4'});
      svg.append(c);return c;
    });
    svg.append(focusRing);
    for(const h of [0,4,8,12,16,20,23]){
      svg.append(svgEl('text',{x:pts[h].x.toFixed(1),y:H-6,'text-anchor':'middle',fill:'var(--pulse-muted)','font-size':'9'},`${String(h).padStart(2,'0')}:00`));
    }
    for(const p of pts){
      const bucket={from:`${String(p.hour).padStart(2,'0')}:00`,to:`${String(p.hour).padStart(2,'0')}:59`,total:p.val,requests:0,models:{},users:{}};
      const bar=svgEl('rect',{x:(p.x-wPlot/46).toFixed(1),y:padT,width:(wPlot/23).toFixed(1),height:hPlot,fill:'transparent',class:'hourly-hover','data-h':p.hour,'data-v':p.val});
      bar.style.cursor='pointer';
      const circle=circles[p.hour];
      const enter=()=>{
        crosshair.setAttribute('x1',p.x.toFixed(1));crosshair.setAttribute('x2',p.x.toFixed(1));crosshair.style.opacity='1';
        focusRing.setAttribute('cx',p.x.toFixed(1));focusRing.setAttribute('cy',p.y.toFixed(1));focusRing.style.opacity='1';
        circle.setAttribute('r','4');circle.setAttribute('fill-opacity','1');
        tooltip(bucket,bar);
      };
      const leave=()=>{
        crosshair.style.opacity='0';focusRing.style.opacity='0';
        circle.setAttribute('r',p.val>0?'2.5':'1.5');circle.setAttribute('fill-opacity',p.val>0?'1':'0.4');
        $('tip').hidden=true;highlightItem(null);
      };
      bar.addEventListener('pointerenter',enter);
      bar.addEventListener('pointerleave',leave);
      svg.append(bar);
    }
    $('hourly-chart').replaceChildren(svg);
  }
  let lastManualSig='',lastAccQueryKey='';
  function renderManualEntries(){
    const entries=value?.manualEntries||[];
    const sig=language.language+'|'+value?.accountKey+'|'+JSON.stringify(entries);
    if(sig===lastManualSig)return;lastManualSig=sig;
    text('manual-title',w('远程项目手动录入用量','Remote Project Manual Usage'));
    $('manual-table-head').replaceChildren(...[w('项目名称','Project'),w('时间','Datetime'),w('模型','Model'),w('输入 / 补全','Prompt / Output'),w('总用量','Total'),w('备注','Note'),w('操作','Action')].map(label=>node('th','',label)));
    const bodyFrag=document.createDocumentFragment();
    if(!entries.length){
      const row=node('tr',''),cell=node('td','muted',w('暂无手动录入记录','No manual entries recorded'));
      cell.colSpan=7;cell.style.textAlign='center';cell.style.padding='20px';row.append(cell);bodyFrag.append(row);
      $('manual-table-body').replaceChildren(bodyFrag);return;
    }
    for(const entry of entries){
      const row=node('tr','');
      const prompt=entry.tokens?.prompt??entry.promptTokens??0;
      const candidates=entry.tokens?.candidates??entry.completionTokens??0;
      const total=entry.tokens?.total??entry.totalTokens??(Number(prompt)+Number(candidates));
      const dt=entry.timestamp?entry.timestamp.replace('T',' ').slice(0,19):(entry.at?new Date(entry.at).toLocaleString(zh()?'zh-CN':'en-US'):'—');
      const tdProj=node('td','',entry.projectName||'—'),tdTime=node('td','',dt),tdModel=node('td','',modelName(entry.model||''));
      const tdTokens=node('td','',`${compact(prompt)} / ${compact(candidates)}`),tdTotal=node('td','',compact(total)),tdNote=node('td','',entry.note||'—'),tdAction=node('td','');
      const delBtn=node('button','btn-delete',w('删除','Delete'));delBtn.type='button';
      delBtn.addEventListener('click',async()=>{
        delBtn.disabled=true;const bridge=window.agPulseBridge||window.agPulseHost;
        try{
          if(bridge?.deleteManualUsage){
            try{await bridge.deleteManualUsage({scope:value?.accountKey,id:entry.id});}
            catch{try{await bridge.deleteManualUsage(value?.accountKey,entry.id);}catch{await bridge.deleteManualUsage(entry.id);}}
          }
          await onRefresh();
        }catch{delBtn.disabled=false;}
      });
      tdAction.append(delBtn);row.append(tdProj,tdTime,tdModel,tdTokens,tdTotal,tdNote,tdAction);bodyFrag.append(row);
    }
    $('manual-table-body').replaceChildren(bodyFrag);
  }
  async function syncAccounts(){
    const select=$('account-switcher');if(!select)return;
    const bridge=window.agPulseBridge||window.agPulseHost;let list=null;
    if(value?.accounts&&Array.isArray(value.accounts))list=value.accounts;
    else if(bridge?.getAccounts&&lastAccQueryKey!==value?.accountKey){
      lastAccQueryKey=value?.accountKey||'';
      try{
        const res=await bridge.getAccounts();
        list=Array.isArray(res)?res:(res?.accounts||[]);
      }catch{}
    }else if(!bridge?.getAccounts){
      list=[];
    }else return;
    if(!list||!list.length)list=[value?.viewScope||value?.accountKey||'default'];
    const currentKey=value?.viewScope||'all';
    select.hidden=list.length<=1;
    const items=list.map(acc=>{
      const id=typeof acc==='string'?acc:(acc.id||acc.account||acc.accountKey);
      const isAll=id==='all';
      const name=typeof acc==='string'?(acc.length>12?acc.slice(0,10)+'…':acc):(isAll?w('全部账号 (汇总)','All Accounts (Aggregated)'):(acc.email||acc.name||id));
      return [id,name];
    });
    const optSig=language.language+'|'+currentKey+'|'+items.map(([id,name])=>id+':'+name).join(',');
    if(select.dataset.sig===optSig)return;
    select.dataset.sig=optSig;
    select.replaceChildren(...items.map(([id,name])=>{
      const opt=document.createElement('option');opt.value=id;opt.textContent=name;opt.selected=id===currentKey;return opt;
    }));
  }
  function render(){
    renderGuide();
    if(!value){
      closeYear(false);$('tip').hidden=true;$('overview').hidden=true;$('details').hidden=true;$('usage-waiting').hidden=false;
      text('usage-waiting',w('正在重新连接统计…','Reconnecting usage…'));text('subtitle',w('正在重新连接本机统计','Reconnecting local usage'));text('coverage','');text('timezone','');$('alert').hidden=true;
      for(const metric of $('totals').children){metric.title='';metric.querySelector('.value')?.replaceChildren(node('span','','—'));}
      return;
    }
    $('usage-waiting').hidden=true;
    syncPalette();
    text('title',w('用量统计','Token usage'));dialog.setAttribute('aria-label',w('用量统计','Token usage'));text('subtitle',w(`本机 ${hostLabel} · ${value?.viewScope==='all'?'全部账号 (汇总)':'当前账号'}`,`Local ${hostLabel} · ${value?.viewScope==='all'?'all accounts':'current account'}`));
    text('overview-tab',w('活动概览','Activity'));text('details-tab',w('用量详情','Usage details'));text('activity-title',w('Token 活动','Token activity'));
    text('dim-model',w('按模型统计','By Model'));text('dim-user',w('按用户统计','By User'));
    $('model-view-controls').hidden=dimension!=='model';
    $('model-view-simple').setAttribute('aria-pressed',String(modelViewMode==='simple'));
    $('model-view-detailed').setAttribute('aria-pressed',String(modelViewMode==='detailed'));
    text('model-view-simple',w('简易','Simple'));text('model-view-detailed',w('详细','Detailed'));
    text('detail-title',dimension==='model'?w('按模型统计','Usage by model'):w('按用户统计','Usage by user'));
    text('locale-label',zh()?'EN':'中');for(const [id,label]of [['locale',w('切换到英文','Switch to Chinese')],['refresh',w('刷新用量','Refresh usage')],['close',w('关闭','Close')]]){$(id).setAttribute('aria-label',label);$(id).title=label;}text('less',w('少','Less'));text('more',w('多','More'));text('selection-details',w('查看这段用量 →','View usage →'));
    text('add-manual-label',w('录入远程用量','Remote Usage'));text('manual-modal-title',w('录入远程项目用量','Record Remote Usage'));
    text('lbl-account',w('归属账号','Account'));text('lbl-project',w('项目名称','Project Name'));text('lbl-datetime',w('时间','Datetime'));text('lbl-model',w('模型','Model'));
    text('lbl-prompt',w('Prompt Tokens (输入)','Prompt Tokens'));text('lbl-completion',w('Completion Tokens (补全)','Completion Tokens'));
    text('lbl-cache',w('Cache Tokens (缓存, 可选)','Cache Tokens (Optional)'));text('lbl-note',w('备注','Note'));
    text('manual-cancel',w('取消','Cancel'));text('manual-submit',w('确认录入','Submit'));
    for(const b of view.querySelectorAll('[data-heat]'))b.textContent=b.dataset.heat==='day'?w('每天','Daily'):w('每周','Weekly');
    for(const b of view.querySelectorAll('[data-period]'))b.textContent=({day:w('天','Day'),week:w('周','Week'),month:w('月','Month'),custom:w('自定义','Custom')})[b.dataset.period];
    $('overview-tab').setAttribute('aria-selected',String(tab==='overview'));$('details-tab').setAttribute('aria-selected',String(tab==='details'));$('overview').hidden=tab!=='overview';$('details').hidden=tab!=='details';
    const kpis=[[w('今日用量','Today'),value.todayTokens],[w('本周用量','This week'),value.weekTokens],[w('本月用量','This month'),value.monthTokens],[w('累计用量','All time'),value.totalTokens]];
    if($('totals').children.length!==4){
      $('totals').replaceChildren(...kpis.map(([label,total])=>{
        const metric=node('div','metric'),n=node('div','value',compact(total));n.append(node('span','unit','Token'));metric.append(node('label','',label),n);metric.title=full(total)+' Token';return metric;
      }));
    }else{
      [...$('totals').children].forEach((metric,idx)=>{
        const [label,total]=kpis[idx];
        const lbl=metric.querySelector('label'),val=metric.querySelector('.value');
        if(lbl&&lbl.textContent!==label)lbl.textContent=label;
        const unit=val?.querySelector('.unit');
        if(!val||!unit){const n=node('div','value',compact(total));n.append(node('span','unit','Token'));val?val.replaceWith(n):metric.append(n);}
        else{if(val.firstChild?.nodeType===3){if(val.firstChild.textContent!==compact(total))val.firstChild.textContent=compact(total);}else{val.replaceChildren(document.createTextNode(compact(total)),unit);}}
        const title=full(total)+' Token';if(metric.title!==title)metric.title=title;
      });
    }
    const years=[];const first=Number(value.firstDate?.slice(0,4)||value.today.slice(0,4)),currentYear=Number(value.today.slice(0,4)),minimum=Math.max(first,currentYear-10);for(let y=currentYear;y>=minimum;y--)years.push(y);
    if($('year').dataset.years!==years.join(',')){
      $('year-menu').replaceChildren(...years.map(y=>{const option=node('button','year-option');option.type='button';option.dataset.year=String(y);option.setAttribute('role','option');option.tabIndex=-1;
        setMarkup(option,'<span></span><svg class="year-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>');option.firstElementChild.textContent=String(y);
        option.addEventListener('click',()=>{year=String(y);syncYear();closeYear();renderHeat();});return option;}));$('year').dataset.years=years.join(',');
    }
    syncYear();
    syncAccounts();
    renderManualEntries();
    text('coverage',w(`已记录 ${full(value.requests)} 次请求${value.firstDate?' · 始于 '+value.firstDate:''}`,`${full(value.requests)} requests recorded${value.firstDate?' · since '+value.firstDate:''}`));
    text('timezone',value.timeZone+' · '+(value.syncing||value.retryingConversations>0?w('正在同步历史…','Syncing history…'):w('本地统计','Local usage')));
    const alerts=[];if(value.unknownRequests)alerts.push(w(`${value.unknownRequests} 次请求日期未知，共 ${compact(value.unknownTokens)} Token`,`${value.unknownRequests} undated requests · ${compact(value.unknownTokens)} tokens`));
    const confirmedMissing=value.confirmedMissingConversations??(value.syncing?0:value.missingConversations);
    if(value.partialRequests||value.unreadableFiles||confirmedMissing>0&&!value.syncing||value.persistenceError)alerts.push(w('部分记录暂不可读取，用量可能不完整','Some records are unavailable; usage may be incomplete'));
    $('alert').hidden=!alerts.length;text('alert',alerts.join(' · '));
    if(tab==='overview')renderHeat();else renderChart();
  }
  function changeTab(next){closeYear(false);tab=next;selectedBar=null;$('tip').hidden=true;render();}
  $('overview-tab').addEventListener('click',()=>changeTab('overview'));$('details-tab').addEventListener('click',()=>changeTab('details'));
  for(const b of view.querySelectorAll('[data-heat]'))b.addEventListener('click',()=>{heatMode=b.dataset.heat;renderHeat();});
  for(const b of view.querySelectorAll('[data-period]'))b.addEventListener('click',()=>{period=b.dataset.period;selectedBar=null;renderChart();});
  const handleCustomChange=()=>{const s=$('custom-start').value,e=$('custom-end').value;if(s&&e&&s<=e){customStart=s;customEnd=e;selectedBar=null;renderChart();}};
  $('custom-start').addEventListener('change',handleCustomChange);$('custom-end').addEventListener('change',handleCustomChange);
  $('dim-model').addEventListener('click',()=>{dimension='model';renderChart();});
  $('dim-user').addEventListener('click',()=>{dimension='user';renderChart();});
  $('model-view-simple').addEventListener('click',()=>{modelViewMode='simple';disabledModels.clear();renderChart();});
  $('model-view-detailed').addEventListener('click',()=>{modelViewMode='detailed';disabledModels.clear();renderChart();});
  $('hourly-mode-combined').addEventListener('click',e=>{e.stopPropagation();hourlyMode='combined';hourlyExpanded=true;renderHourly();});
  $('hourly-mode-today').addEventListener('click',e=>{e.stopPropagation();hourlyMode='today';hourlyExpanded=true;renderHourly();});
  $('hourly-toggle').addEventListener('click',()=>{hourlyExpanded=!hourlyExpanded;renderHourly();});
  $('account-switcher').addEventListener('change',async event=>{
    const newAccount=event.target.value;if(!newAccount||newAccount===(value?.viewScope||value?.accountKey))return;
    const bridge=window.agPulseBridge||window.agPulseHost;
    try{
      try{await bridge?.switchAccount?.({account:newAccount});}
      catch{await bridge?.switchAccount?.(newAccount);}
    }catch{}
    await onRefresh();
  });
  $('add-manual').addEventListener('click',()=>{
    $('manual-modal').hidden=false;$('manual-form').reset();
    const accList=(value?.accounts||[]).filter(a=>a.id!=='all');
    if(!accList.length&&(value?.activeAccount||value?.accountKey))accList.push({id:value.activeAccount||value.accountKey,name:value.activeAccount||value.accountKey});
    $('manual-account').replaceChildren(...accList.map(a=>{
      const opt=document.createElement('option');opt.value=a.id;opt.textContent=a.name||a.email||a.id;
      opt.selected=a.id===(value?.activeAccount||value?.accountKey);return opt;
    }));
    $('manual-account-row').hidden=accList.length<=1;
    const now=new Date(),pad=n=>String(n).padStart(2,'0');
    $('manual-datetime').value=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    $('manual-model-list').replaceChildren(...(value?.models||[]).map(m=>{const opt=document.createElement('option');opt.value=m;return opt;}));
    $('manual-project').focus();
  });
  function closeManualModal(restore=true){
    if($('manual-modal').hidden)return;
    $('manual-modal').hidden=true;
    if(restore)$('add-manual').focus({preventScroll:true});
  }
  $('manual-cancel').addEventListener('click',()=>closeManualModal());
  $('manual-modal').addEventListener('click',e=>{if(e.target===$('manual-modal'))closeManualModal();});
  $('manual-form').addEventListener('submit',async event=>{
    event.preventDefault();const submitBtn=$('manual-submit');submitBtn.disabled=true;
    const chosenScope=$('manual-account').value||(value?.accountKey!=='all'?value?.accountKey:value?.activeAccount)||(value?.accounts?.find(a=>a.id!=='all')?.id);
    const project=$('manual-project').value.trim(),dt=$('manual-datetime').value,model=$('manual-model').value.trim();
    const promptTokens=Number($('manual-prompt').value||0),completionTokens=Number($('manual-completion').value||0),cacheTokens=Number($('manual-cache').value||0),note=$('manual-note').value.trim();
    const payload={
      scope:chosenScope,source:'remote-manual',projectName:project,timestamp:new Date(dt).toISOString(),at:Date.parse(dt),model,
      tokens:{prompt:promptTokens,candidates:completionTokens,cacheRead:cacheTokens,cache:cacheTokens,total:promptTokens+completionTokens},
      promptTokens,completionTokens,cacheTokens,note
    };
    const bridge=window.agPulseBridge||window.agPulseHost;
    try{
      if(bridge?.addManualUsage){
        try{await bridge.addManualUsage(payload);}
        catch{await bridge.addManualUsage(chosenScope,payload);}
      }
      closeManualModal();await onRefresh();
    }catch{}
    finally{submitBtn.disabled=false;}
  });
  function syncYear(){
    text('year-label',String(year));$('year').setAttribute('aria-label',w('选择年份','Select year')+' · '+year);$('year-menu').setAttribute('aria-label',w('年份','Year'));
    for(const option of $('year-menu').children)option.setAttribute('aria-selected',String(option.dataset.year===String(year)));
  }
  function closeYear(restore=true){if(!$('year-menu').matches(':popover-open'))return;$('year-menu').hidePopover();$('year').setAttribute('aria-expanded','false');if(restore)$('year').focus({preventScroll:true});}
  function positionYear(){
    if(!$('year-menu').matches(':popover-open'))return;const menu=$('year-menu'),r=$('year').getBoundingClientRect(),bounds=dialog.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
    menu.style.left=Math.max(bounds.left+12,Math.min(r.right-width,bounds.right-width-12))+'px';const below=r.bottom+7;
    menu.style.top=(below+height<=bounds.bottom-12?below:Math.max(bounds.top+12,r.top-height-7))+'px';
  }
  function openYear(){
    $('tip').hidden=true;$('year-menu').showPopover();$('year').setAttribute('aria-expanded','true');positionYear();
    ($('year-menu').querySelector('[aria-selected=true]')||$('year-menu').firstElementChild)?.focus({preventScroll:true});
  }
  $('year').addEventListener('click',()=>{$('year-menu').matches(':popover-open')?closeYear():openYear();});
  $('year').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();openYear();if(event.key==='Home')$('year-menu').firstElementChild?.focus();if(event.key==='End')$('year-menu').lastElementChild?.focus();}});
  $('year-menu').addEventListener('keydown',event=>{
    const options=[...$('year-menu').children],current=options.indexOf(view.activeElement);let next=null;
    if(event.key==='ArrowDown')next=Math.min(options.length-1,current+1);else if(event.key==='ArrowUp')next=Math.max(0,current-1);else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;
    if(next!==null){event.preventDefault();options[next]?.focus({preventScroll:true});}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeYear();}else if(event.key==='Tab')closeYear();
  });
  view.addEventListener('pointerdown',event=>{const path=event.composedPath();if(!path.includes($('year'))&&!path.includes($('year-menu')))closeYear(false);});
  page.addEventListener('scroll',closeYearOnScroll,{passive:true});function closeYearOnScroll(){closeYear(false);}
  window.addEventListener('resize',positionYear);
  $('heat').addEventListener('keydown',event=>{
    const buttons=[...$('heat').children],index=buttons.indexOf(event.target);if(index<0)return;
    const delta=heatMode==='day'?{ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}:{ArrowLeft:-1,ArrowRight:1,ArrowUp:-Math.ceil(buttons.length/2),ArrowDown:Math.ceil(buttons.length/2)};
    let next=event.key==='Home'?buttons.findIndex(b=>!b.disabled):event.key==='End'?buttons.findLastIndex(b=>!b.disabled):index+(delta[event.key]??NaN);
    if(!Number.isFinite(next)||next<0||next>=buttons.length||buttons[next].disabled)return;event.preventDefault();event.target.tabIndex=-1;buttons[next].tabIndex=0;buttons[next].focus();
  });
  $('selection-details').addEventListener('click',()=>{anchor=(selected?.from||value.today);period=heatMode;changeTab('details');});
  for(const [id,step]of [['previous',-1],['next',1]])$(id).addEventListener('click',()=>{selectedBar=null;anchor=period==='day'?month(anchor,step):period==='week'?add(anchor,step*84):month(anchor,step*12);renderChart();});
  $('locale').addEventListener('click',()=>void onLanguage(zh()?'en':'zh-CN'));
  $('refresh').addEventListener('click',async()=>{
    if(busy||disposed)return;busy=true;const button=$('refresh'),turn=600,started=performance.now();button.disabled=true;button.setAttribute('aria-busy','true');
    refreshMotion=button.querySelector('svg').animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:turn,iterations:Infinity});
    try{await onRefresh();}
    catch{if(!disposed){text('alert',w('暂时无法刷新，请稍后重试','Refresh unavailable. Try again shortly.'));$('alert').hidden=false;}}
    finally{
      // Fast requests still paint one whole turn. Slow requests finish their
      // current turn, so cancel never snaps a half-rotated icon back to zero.
      if(!disposed){const elapsed=performance.now()-started,remaining=Math.max(turn,Math.ceil(elapsed/turn)*turn)-elapsed;
        await new Promise(resolve=>{finishRefresh=resolve;refreshDelay=setTimeout(resolve,Math.max(0,remaining));});}
      clearTimeout(refreshDelay);refreshDelay=null;finishRefresh=null;refreshMotion?.cancel();refreshMotion=null;busy=false;
      if(!disposed){button.disabled=false;button.setAttribute('aria-busy','false');}
    }
  });
  // Native showModal()/close() changes inertness across the complete host DOM.
  // In long chats this alone can block Chromium for seconds. A top-layer
  // popover keeps the same backdrop without touching every background node.
  // Contain pointer, focus, Tab, Escape and scrolling explicitly instead.
  function present(){
    if(dialog.matches(':popover-open'))return;
    dialog.removeAttribute('open');dialog.showPopover();dialog.setAttribute('open','');
    $('locale').focus({preventScroll:true});
  }
  function conceal(){
    if(dialog.matches(':popover-open'))dialog.hidePopover();dialog.removeAttribute('open');
  }
  function close(){closeYear(false);conceal();$('tip').hidden=true;opener?.focus({preventScroll:true});}
  $('close').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  const contentKey=data=>JSON.stringify([{...data,updatedAt:undefined},language.language,themeSignature()]);
  const within=event=>event.composedPath().includes(dialog);
  function containFocus(event){if(!disposed&&dialog.open&&!within(event)){$('locale').focus({preventScroll:true});}}
  function containKeys(event){
    if(disposed||!dialog.open)return;
    if(event.key==='Escape'){
      event.preventDefault();event.stopImmediatePropagation();
      if(!$('manual-modal').hidden)closeManualModal();
      else if($('year-menu').matches(':popover-open'))closeYear();else close();return;
    }
    if(event.key!=='Tab')return;
    // The year menu retains its own Tab dismissal; focus stays in the dialog.
    if($('year-menu').matches(':popover-open'))closeYear(false);
    const controls=[...view.querySelectorAll('button,input,select,a[href],[tabindex]')].filter(n=>n.tabIndex>=0&&!n.disabled&&n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden');
    if(!controls.length){event.preventDefault();return;}
    const index=controls.indexOf(view.activeElement);
    if(index<0||event.shiftKey&&index===0||!event.shiftKey&&index===controls.length-1){
      event.preventDefault();event.stopImmediatePropagation();(event.shiftKey?controls.at(-1):controls[0]).focus({preventScroll:true});
    }
  }
  function containScroll(event){if(!disposed&&dialog.open&&!within(event))event.preventDefault();}
  function containPointer(event){
    if(disposed||!dialog.open)return;
    const r=dialog.getBoundingClientRect();
    const backdropHit=event.composedPath()[0]===dialog;
    if(!within(event)||backdropHit&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)){event.preventDefault();event.stopImmediatePropagation();if(event.type==='click')close();}
  }
  document.addEventListener('focusin',containFocus,true);document.addEventListener('keydown',containKeys,true);
  document.addEventListener('wheel',containScroll,{capture:true,passive:false});document.addEventListener('touchmove',containScroll,{capture:true,passive:false});
  for(const type of ['pointerdown','mousedown','click'])document.addEventListener(type,containPointer,true);
  // CSS surfaces update immediately; JS model colors must follow in the same
  // theme change, rather than waiting for the next metrics poll.
  const themeObserver=new MutationObserver(()=>{if(!disposed&&value&&dialog.open){const key=contentKey(value);if(key!==lastKey){lastKey=key;render();}}});
  if(root.host)themeObserver.observe(root.host,{attributes:true,attributeFilter:['data-pulse-theme','style']});
  return {open(data,trigger){if(!data||disposed)return;accountKey=data.accountKey;value=data;opener=trigger;year||=data.today.slice(0,4);anchor||=data.today;lastKey=contentKey(data);rebuildDayIndex();render();present();},
    update(data){if(disposed)return;if(!data){if(!value)return;value=null;lastKey='';rebuildDayIndex();if(dialog.open)render();return;}if(accountKey&&accountKey!==data.accountKey){selected=null;selectedBar=null;disabledModels.clear();disabledUsers.clear();expandedModelGroups.clear();lastAccQueryKey='';year=data.today.slice(0,4);anchor=data.today;}accountKey=data.accountKey;value=data;if(!dialog.open)return;const key=contentKey(data);if(key===lastKey)return;lastKey=key;rebuildDayIndex();render();},
    restoreModal(){if(!disposed&&dialog.open&&dialog.isConnected&&!dialog.matches(':popover-open')){closeYear(false);present();}},
    close,syncGuideDismissed(){if(!replayGuide)dismissGuide();},dispose(){disposed=true;themeObserver.disconnect();clearTimeout(refreshDelay);finishRefresh?.();refreshMotion?.cancel();closeYear(false);window.removeEventListener('resize',positionYear);document.removeEventListener('focusin',containFocus,true);document.removeEventListener('keydown',containKeys,true);document.removeEventListener('wheel',containScroll,true);document.removeEventListener('touchmove',containScroll,true);for(const type of ['pointerdown','mousedown','click'])document.removeEventListener(type,containPointer,true);conceal();dialog.remove();backdrop.remove();},get isOpen(){return dialog.open;}};
};

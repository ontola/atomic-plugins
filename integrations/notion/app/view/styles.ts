// @wc-ignore-file
/**
 * Notion-specific styles (`nt-*`): the status card, first-import progress,
 * sync details, option pills in Notion's ten colours (the review), and the
 * "Changes to send" strip and review (`review.ts`, #8). The #89 browsing
 * rules (toolbar, table, board, list, side peek) went with those views
 * (#177 Q9). One rule per line; `build.mjs` minifies the literal.
 */
export const NT_CSS = `
.nt-main{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.nt-content{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto}
.nt-muted{color:var(--pl-muted)}
.nt-dbname{display:inline-flex;align-items:center;gap:6px;color:var(--pl-muted)}
.nt-content>.ss{margin:12px 16px 0;max-width:620px}
.nt-summary{margin:12px 16px 16px;padding:14px 16px;max-width:620px;display:grid;gap:12px;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface);font-size:13px}
.nt-summary h2{margin:0;font:700 15px/1.3 var(--t-font-family-header,system-ui)}
.nt-summary>p{margin:0}
.nt-s-dbs{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.nt-s-dbs li{display:flex;align-items:center;gap:8px}
.nt-s-dbs li .ic{color:var(--pl-muted)}
.nt-s-count{margin-left:auto;color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-s-facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}
.nt-s-facts dt{color:var(--pl-muted)}
.nt-s-facts dd{margin:0;font-variant-numeric:tabular-nums}
.nt-s-note{display:flex;gap:7px;align-items:flex-start;margin:0;padding:9px 11px;border-radius:8px;background:var(--pl-subtle);color:var(--pl-muted)}
.nt-s-note .ic{margin-top:2px}
.nt-s-actions{display:flex;gap:8px;flex-wrap:wrap}
.nt-tag{--hue:#9b9a97;display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 7px;border-radius:5px;font-size:12px;line-height:1;white-space:nowrap;color:var(--pl-text);background:color-mix(in srgb,var(--hue) 22%,var(--pl-surface))}
.nt-status{border-radius:999px;padding:0 9px 0 7px}
.nt-status::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--hue)}
.nt-tags{display:inline-flex;gap:4px;flex-wrap:wrap}
.c-default{--hue:#a5a29d}
.c-gray{--hue:#8f8d88}
.c-brown{--hue:#a27456}
.c-orange{--hue:#d9730d}
.c-yellow{--hue:#cb912f}
.c-green{--hue:#448361}
.c-blue{--hue:#337ea9}
.c-purple{--hue:#9065b0}
.c-pink{--hue:#c14c8a}
.c-red{--hue:#d44c47}
.nt-import{padding:18px 16px 10px;max-width:620px}
.nt-import h2{margin:0 0 4px;font:700 16px/1.3 var(--t-font-family-header,system-ui)}
.nt-import>p{margin:0 0 12px;color:var(--pl-muted);font-size:13px}
.nt-progress{list-style:none;margin:0;padding:0;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface)}
.nt-progress li{display:grid;grid-template-columns:18px 1fr auto;gap:4px 10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--pl-hair);color:var(--pl-muted)}
.nt-progress li:last-child{border-bottom:0}
.nt-progress li.is-done,.nt-progress li.is-active{color:var(--pl-text)}
.nt-p-name{font-weight:600}
.nt-p-state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-p-state .ic.ok{color:var(--pl-pos)}
.nt-bar{grid-column:2/4;height:4px;border-radius:2px;background:var(--pl-subtle);overflow:hidden}
.nt-bar span{display:block;height:100%;background:var(--pl-accent)}
.nt-bar.is-indeterminate span{width:35%;animation:nt-slide 1.4s ease-in-out infinite}
@keyframes nt-slide{from{transform:translateX(-100%)}to{transform:translateX(300%)}}
.nt-details{position:absolute;top:4px;right:16px;width:min(440px,calc(100% - 32px));max-height:calc(100% - 8px);overflow:auto;z-index:5;background:var(--pl-surface);border:1px solid var(--pl-border);border-radius:var(--pl-radius);box-shadow:var(--t-box-shadow-intense,0 8px 30px rgba(0,0,0,0.2));padding:14px 16px;font-size:13px}
.nt-details-h{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}
.nt-details-h span{color:var(--pl-muted);font-size:12.5px}
.nt-details-dbs{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.nt-details-dbs li{display:grid;gap:3px;padding-top:12px;border-top:1px solid var(--pl-hair)}
.nt-details-dbs p{margin:0}
.nt-details-general{margin-top:12px;display:grid;gap:4px}
.nt-d-name{display:flex;align-items:center;gap:6px;font-weight:600}
.nt-d-counts{color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-d-counts b{color:var(--pl-text)}
.nt-d-skip{color:var(--pl-muted)}
.nt-d-skip span{color:var(--pl-text)}
.nt-d-warn{display:flex;gap:6px;align-items:flex-start;color:var(--pl-text)}
.nt-d-warn .ic{margin-top:3px;color:color-mix(in srgb,var(--pl-warn) 75%,var(--pl-text))}
.nt-tech{margin-top:10px;font-size:12px;color:var(--pl-muted)}
.nt-tech summary{cursor:pointer}
.nt-tech pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:var(--pl-subtle);white-space:pre-wrap;font:11.5px/1.5 ui-monospace,Menlo,monospace}
.nt-changes{display:flex;align-items:center;gap:10px;margin:12px 16px 0;padding:8px 12px;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-accent-soft);font-size:13px}
.nt-changes p{margin:0;flex:1}
.nt-review{flex:1;min-height:0;overflow:auto;margin:12px 16px 16px;padding:12px 16px;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface);font-size:13px}
.nt-r-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nt-r-top h2{margin:0;font:700 16px/1.3 var(--t-font-family-header,system-ui)}
.nt-review>p{margin:6px 0 12px}
.nt-r-list{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:10px}
.nt-r-list>li{padding:10px 12px;border:1px solid var(--pl-hair);border-radius:8px}
.nt-r-head{display:flex;align-items:center;gap:10px}
.nt-r-head .pl-btn{margin-left:auto}
.nt-r-fields{display:grid;grid-template-columns:minmax(80px,max-content) 1fr;gap:6px 12px;margin:8px 0 0}
.nt-r-fields dt{color:var(--pl-muted)}
.nt-r-fields dd{margin:0;display:grid;gap:6px;min-width:0;overflow-wrap:anywhere}
.nt-r-change{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.nt-r-before{color:var(--pl-muted);text-decoration:line-through}
.nt-r-after{font-weight:600}
.nt-r-conflict{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.nt-r-conflict p{margin:0;flex-basis:100%}
.nt-r-outcome{display:flex;gap:6px;align-items:flex-start;margin:8px 0 0;color:var(--pl-muted)}
.nt-r-outcome.is-sent{color:var(--pl-pos)}
.nt-r-outcome.is-unknown,.nt-r-outcome.is-failed{color:var(--pl-neg)}
.nt-r-foot{display:flex;align-items:center;gap:12px;position:sticky;bottom:-12px;padding:10px 0 2px;background:var(--pl-surface)}
@container pl-app (max-width:639.98px){.nt-content>.ss{margin:12px 12px 0}.nt-summary{margin:12px 12px}.nt-import{padding:14px 12px 10px}.nt-changes{margin:12px 12px 0}.nt-review{margin:12px 12px 12px}.nt-s-facts{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.nt-bar.is-indeterminate span{animation:none;width:100%;opacity:0.4}}
`;

// @wc-ignore-file
/**
 * The icon sprite from mockups.html (#89): 16px line icons, stroked in
 * `currentColor`. `sprite()` is added once to the app root; `icon()` in
 * `dom.ts` references a symbol by name. Only the glyphs the status view, the
 * sync details, the review and the shell use; the property-type glyphs went
 * with the browsing views (#177 Q9).
 */
const PATHS: Record<string, string> = {
  db: '<ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  sync: '<path d="M13 6A5.3 5.3 0 0 0 3.3 5.2M3 10a5.3 5.3 0 0 0 9.7.8M13 2.5V6H9.5M3 13.5V10h3.5"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  ext: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  alert: '<path d="M8 2.2 14.3 13.5H1.7z"/><path d="M8 6.5v3M8 11.4v.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.6M8 5.1v.2"/>',
  table:
    '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5V13"/>',
  chev: '<path d="M4.5 6.5 8 10l3.5-3.5"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4 5.5h8v2a4 4 0 0 1-8 0zM8 11.5v2.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-6.5"/>',
};

export type IconName = keyof typeof PATHS;

export function sprite(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute');
  svg.innerHTML =
    '<defs>' +
    Object.entries(PATHS)
      .map(
        ([name, body]) =>
          `<symbol id="i-${name}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`,
      )
      .join('') +
    '</defs>';

  return svg;
}

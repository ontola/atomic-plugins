// @wc-ignore-file
/** `card.css?raw`: the stylesheet's text, which an app's build minifies. */
declare module '*.css?raw' {
  const text: string;

  export default text;
}

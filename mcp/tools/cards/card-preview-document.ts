import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { CardPreviewTheme } from "./card-preview-schemas.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const STATIC_ELEMENTS = new Set((
  "a abbr article aside b bdi bdo blockquote br button caption center cite code " +
  "col colgroup dd del details dfn div dl dt em fieldset figcaption figure " +
  "font footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label legend " +
  "li main mark ol option p pre q rp rt ruby s samp section select small " +
  "span strike strong style sub summary sup table tbody td textarea tfoot " +
  "th thead time tr tt u ul var wbr"
).split(" "));
const STATIC_ATTRIBUTES = new Set((
  "id class style title lang dir hidden role alt width height colspan rowspan " +
  "align valign border cellpadding cellspacing span start reversed type value " +
  "placeholder disabled readonly checked selected multiple size rows cols " +
  "open color face datetime scope for"
).split(" "));
const FORM_CONTROLS = new Set(["button", "input", "select", "textarea"]);

/** Defense in depth: markup restrictions apply even if a viewer ignores CSP. */
export const CARD_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'",
  "img-src 'none'", "media-src 'none'", "font-src 'none'", "connect-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

interface PreviewDocumentOptions {
  html: string;
  css: string;
  title: string;
  templateOrdinal: number;
  theme: CardPreviewTheme;
}

/**
 * Wraps Anki's rendered side in an offline static inspection document. This is
 * an inspection approximation, not a replacement for Anki's reviewer runtime.
 * Raw source is returned separately by the tool and is never modified in Anki.
 */
export function buildCardPreviewDocument({
  html, css, title, templateOrdinal, theme,
}: PreviewDocumentOptions) {
  const fragment = parseFragment(html);
  const pending: Array<DefaultTreeAdapterTypes.DocumentFragment | DefaultTreeAdapterTypes.Element> = [fragment];
  let removedElementCount = 0;
  let removedAttributeCount = 0;

  while (pending.length > 0) {
    const parent = pending.pop()!;
    parent.childNodes = parent.childNodes.filter((node) => {
      if (!("tagName" in node)) return node.nodeName === "#text";
      if (node.namespaceURI !== HTML_NAMESPACE || !STATIC_ELEMENTS.has(node.tagName)) {
        removedElementCount += 1;
        return false;
      }

      node.attrs = node.attrs.filter((attribute) => {
        const allowed = attribute.namespace === undefined && (
          STATIC_ATTRIBUTES.has(attribute.name) ||
          attribute.name.startsWith("aria-") || attribute.name.startsWith("data-")
        );
        if (!allowed) removedAttributeCount += 1;
        return allowed;
      });
      if (FORM_CONTROLS.has(node.tagName) && !node.attrs.some(({ name }) => name === "disabled")) {
        node.attrs.push({ name: "disabled", value: "" });
      }
      pending.push(node);
      return true;
    });
  }

  const classes = `card card${templateOrdinal + 1}${theme === "dark" ? " nightMode night_mode" : ""}`;
  // Escape raw-text terminators without changing the CSS string's meaning.
  const safeCss = css.replace(/</gu, "\\3c ");
  const background = theme === "dark" ? "#1f1f1f" : "#ffffff";
  const foreground = theme === "dark" ? "#eeeeee" : "#000000";
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CARD_PREVIEW_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html { color-scheme: ${theme}; }
body { margin: 0; padding: 20px; font-family: Arial, sans-serif; font-size: 20px; text-align: center; background: ${background}; color: ${foreground}; }
img { max-width: 100%; }
</style>
<style>${safeCss}</style>
</head>
<body class="${classes}"><div id="qa">${serialize(fragment)}</div></body>
</html>`;

  return { document, removedElementCount, removedAttributeCount };
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

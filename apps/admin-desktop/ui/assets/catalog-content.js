import { marked } from "../vendor/marked.js";
import createPurifier from "../vendor/dompurify.js";

export function catalogImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "cdn.modrinth.com" && !url.port && !url.username && !url.password
      && url.pathname.startsWith("/data/") && /\.(png|jpe?g|webp|gif|avif)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function catalogLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && value.length <= 2048 ? url.href : null;
  } catch { return null; }
}

const purifier = createPurifier(window);
purifier.addHook("uponSanitizeAttribute", (element, data) => {
  if (data.attrName === "src" && !catalogImageUrl(data.attrValue)) data.keepAttr = false;
  if (data.attrName === "href" && !catalogLink(data.attrValue)) data.keepAttr = false;
});

export function descriptionFragment(body) {
  return purifier.sanitize(marked.parse(String(body || "").slice(0, 100_000), { async: false }), {
    ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "em", "strong", "b", "i", "del", "code", "pre", "blockquote", "hr", "br", "a", "img", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "src", "alt", "title"],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
  });
}

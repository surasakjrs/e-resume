import { fontStyles, pdfStyles, pdfTags, PDF_MAX_BYTES, PDF_MAX_NODES, type PdfFont, type PdfNode, type PdfSnapshot } from "./pdf-snapshot-contract";

function dataUrl(blob: Blob, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read a PDF asset."));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, "data:" + mime + ";"));
    reader.readAsDataURL(blob);
  });
}

async function photoData(img: HTMLImageElement): Promise<string> {
  const response = await fetch(img.currentSrc || img.src, { credentials: "omit" });
  if (!response.ok) throw new Error("Could not load the profile photo.");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, 500 / bitmap.width, 600 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not prepare the profile photo.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally { bitmap.close(); }
}

async function captureFonts(families: Set<string>): Promise<PdfFont[]> {
  const jobs: Promise<PdfFont>[] = [];
  const seen = new Set<string>();
  function scan(rules: CSSRuleList, base: string) {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const css = (rule as CSSFontFaceRule).style;
        const name = css.getPropertyValue("font-family").trim().replace(/^['"]|['"]$/g, "");
        if (!name || !Array.from(families).some((family) => family.includes(name))) continue;
        const src = css.getPropertyValue("src").match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
        if (!src) continue;
        const url = new URL(src[1], base);
        if (url.origin !== location.origin || !/\.woff2?$/i.test(url.pathname)) continue;
        const style = Object.fromEntries(fontStyles.map((key) => [key, css.getPropertyValue(key).trim()]).filter(([, value]) => value));
        const key = JSON.stringify([url.href, style]);
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push((async () => {
          const response = await fetch(url, { credentials: "same-origin" });
          if (!response.ok) throw new Error("Could not load the resume fonts.");
          return { style, src: await dataUrl(await response.blob(), url.pathname.endsWith(".woff2") ? "font/woff2" : "font/woff") };
        })());
      } else if ("cssRules" in rule) {
        scan((rule as CSSGroupingRule).cssRules, base);
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    scan(rules, sheet.href || document.baseURI);
  }
  const fonts = await Promise.all(jobs);
  if (!fonts.length) throw new Error("Resume fonts are unavailable. Reload the editor and try again.");
  return fonts;
}

export async function capturePdfSheet(sheet: HTMLElement, lang: "en" | "th"): Promise<string> {
  const nodes: PdfNode[] = [];
  const families = new Set<string>();
  const photos: Promise<void>[] = [];
  function visit(node: Node, depth: number) {
    if (node.nodeType === Node.TEXT_NODE) {
      nodes.push({ depth, tag: "#text", text: node.textContent || "" });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase() as PdfNode["tag"];
    if (!(pdfTags as readonly string[]).includes(tag)) throw new Error("Unsupported content in PDF preview: " + tag);
    const computed = getComputedStyle(node);
    const style: Record<string, string> = {};
    for (const key of pdfStyles) {
      if ((key === "width" || key === "height") && tag !== "img" && depth !== 0) continue;
      const value = computed.getPropertyValue(key).trim();
      if (value) style[key] = value;
    }
    families.add(computed.fontFamily);
    const entry: PdfNode = { depth, tag, style };
    if (node instanceof HTMLAnchorElement) entry.href = node.href;
    if (node instanceof HTMLImageElement) photos.push(photoData(node).then((src) => { entry.src = src; }));
    nodes.push(entry);
    for (const child of Array.from(node.childNodes)) visit(child, depth + 1);
  }
  visit(sheet, 0);
  if (nodes.length > PDF_MAX_NODES) throw new Error("This resume contains too much content for a one-page PDF.");
  const [fonts] = await Promise.all([captureFonts(families), Promise.all(photos)]);
  const snapshot: PdfSnapshot = { lang, nodes, fonts };
  const body = JSON.stringify(snapshot);
  if (new Blob([body]).size > PDF_MAX_BYTES) throw new Error("The PDF assets are too large. Try a smaller profile photo.");
  return body;
}

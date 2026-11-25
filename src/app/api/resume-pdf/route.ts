import { z } from "zod";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { currentUser } from "@/lib/supabase/server";
import { PDF_MAX_BYTES, PDF_MAX_NODES, fontStyles, pdfStyles, pdfTags } from "@/lib/pdf-snapshot-contract";

export const maxDuration = 60;
const styleSchema = z.record(z.string(), z.string().max(500));
const snapshotSchema = z.object({
  lang: z.enum(["en", "th"]),
  nodes: z.array(z.object({
    depth: z.number().int().min(0).max(24), tag: z.enum(pdfTags),
    text: z.string().max(100000).optional(), style: styleSchema.optional(),
    href: z.string().max(4096).optional(), src: z.string().max(1500000).optional(),
  })).min(1).max(PDF_MAX_NODES),
  fonts: z.array(z.object({ style: styleSchema, src: z.string().max(1000000) })).min(1).max(64),
});

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeStyle = (style: Record<string, string> = {}, keys: readonly string[]) =>
  Object.entries(style).filter(([key, value]) => keys.includes(key) && !/[;{}<>\\]/.test(value) && !/(?:url\s*\(|expression\s*\(|@import)/i.test(value))
    .map(([key, value]) => key + ":" + value).join(";");
const fontData = /^data:font\/(?:woff2|woff);base64,[A-Za-z0-9+/]+={0,2}$/;
const imageData = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const validHref = (url = "") => /^(?:https?:\/\/|mailto:)/i.test(url) ? url : "";

function renderSnapshot(snapshot: z.infer<typeof snapshotSchema>) {
  const { nodes, fonts, lang } = snapshot;
  if (nodes[0].depth !== 0 || nodes[0].tag !== "div") throw new Error("Invalid PDF root.");
  let html = "";
  const stack: string[] = [];
  for (const [i, node] of nodes.entries()) {
    if (i && node.depth === 0) throw new Error("Multiple PDF roots.");
    while (stack.length > node.depth) html += "</" + stack.pop() + ">";
    if (stack.length !== node.depth) throw new Error("Invalid PDF tree.");
    if (node.tag === "#text") {
      html += escape(node.text ?? "");
      continue;
    }
    const root = i === 0;
    let style = safeStyle(node.style, pdfStyles);
    if (root) style += ";width:210mm;height:297mm;box-sizing:border-box;overflow:hidden;box-shadow:none;background-color:#fff;";
    const attrs = (root ? ' id="pdf-sheet"' : "") + ' style="' + escape(style) + '"';
    if (node.tag === "img") {
      if (!node.src || !imageData.test(node.src)) throw new Error("Invalid PDF photo.");
      html += '<img alt=""' + attrs + ' src="' + node.src + '">';
    } else if (node.tag === "br") {
      html += "<br" + attrs + ">";
    } else {
      const href = node.tag === "a" ? ' href="' + escape(validHref(node.href)) + '"' : "";
      html += "<" + node.tag + attrs + href + ">";
      stack.push(node.tag);
    }
  }
  while (stack.length) html += "</" + stack.pop() + ">";
  const fontCss = fonts.map((font) => {
    if (!fontData.test(font.src)) throw new Error("Invalid PDF font.");
    return "@font-face{" + safeStyle(font.style, fontStyles) + ";font-display:block;src:url(" + font.src + ");}";
  }).join("\n");
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; base-uri \'none\'; form-action \'none\'"><style>' + fontCss + '@page{size:A4;margin:0}html,body{margin:0;padding:0;background:white;color:black}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}a{text-decoration:none}</style></head><body>' + html + "</body></html>";
}

function fail(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site" || !request.headers.get("content-type")?.startsWith("application/json")) return fail("Invalid request.", 403);
  if (!await currentUser()) return fail("Sign in again before downloading your resume.", 401);
  if (Number(request.headers.get("content-length") || 0) > PDF_MAX_BYTES) return fail("PDF assets exceed the upload limit.", 413);
  let html: string;
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > PDF_MAX_BYTES) return fail("PDF assets exceed the upload limit.", 413);
    const parsed = snapshotSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return fail("Invalid PDF preview data.", 400);
    html = renderSnapshot(parsed.data);
  } catch { return fail("Invalid PDF preview data.", 400); }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      args: puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
      executablePath: process.env.PDF_CHROMIUM_PATH || await chromium.executablePath(),
      headless: "shell",
    });
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      void (req.url().startsWith("data:") || req.url() === "about:blank" ? req.continue() : req.abort()).catch(() => {});
    });
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "load", timeout: 15000 });
    const check = await page.evaluate(async () => {
      await document.fonts.ready;
      const sheet = document.getElementById("pdf-sheet")!;
      return {
        overflow: sheet.scrollHeight > sheet.clientHeight + 1 || sheet.scrollWidth > sheet.clientWidth + 1,
        missing: Array.from(document.fonts).some((font) => font.status === "error") || Array.from(document.images).some((img) => !img.complete || !img.naturalWidth),
      };
    });
    if (check.missing) return fail("A PDF font or photo could not be loaded. Try again.", 422);
    if (check.overflow) return fail("The PDF exceeds one A4 page. Reduce text size or remove a section.", 422);
    const bytes = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false, pageRanges: "1", timeout: 20000 });
    return new Response(new Uint8Array(bytes).buffer, { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Resume.pdf"',
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    console.error("Resume PDF rendering failed", error instanceof Error ? error.name : "UnknownError");
    return fail("Could not generate the PDF. Please try again.", 500);
  } finally { await browser?.close().catch(() => {}); }
}

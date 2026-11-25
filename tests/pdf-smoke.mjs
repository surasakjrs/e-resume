// Run the actual API handler with a test-only auth module; never change production auth.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const tmp = await mkdtemp(join(process.cwd(), ".pdf-smoke-"));
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function fontFaces() {
  const response = await fetch("https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400&display=swap", {
    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
  });
  assert.ok(response.ok, "Fetch Thai font CSS");
  const css = await response.text();
  const faces = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const src = block[1].match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
    if (!src) continue;
    const font = await fetch(src[1]);
    assert.ok(font.ok, "Fetch WOFF2 font");
    const style = {};
    for (const name of ["font-family", "font-style", "font-weight", "font-stretch", "unicode-range"]) {
      const entry = block[1].match(new RegExp(name + "\\s*:\\s*([^;]+);"));
      if (entry) style[name] = entry[1].trim();
    }
    faces.push({ style, src: "data:font/woff2;base64," + Buffer.from(await font.arrayBuffer()).toString("base64") });
  }
  assert.ok(faces.length, "Font face fixtures found");
  return faces;
}

try {
  await writeFile(join(tmp, "contract.mjs"), compile(await readFile("src/lib/pdf-snapshot-contract.ts", "utf8")));
  await writeFile(join(tmp, "auth.mjs"), "export let user = null; export function signIn(){ user = {id:'fixture'}; } export async function currentUser(){return user;}");
  const route = (await readFile("src/app/api/resume-pdf/route.ts", "utf8"))
    .replace('"@/lib/supabase/server"', '"./auth.mjs"')
    .replace('"@/lib/pdf-snapshot-contract"', '"./contract.mjs"');
  await writeFile(join(tmp, "route.mjs"), compile(route));
  const { POST } = await import(pathToFileURL(join(tmp, "route.mjs")));
  const { signIn } = await import(pathToFileURL(join(tmp, "auth.mjs")));
  const request = (body) => new Request("https://example.test/api/resume-pdf", {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  assert.equal((await POST(request({}))).status, 401, "Unauthenticated PDF denied");
  signIn();
  assert.equal((await POST(request({}))).status, 400, "Invalid PDF snapshot denied");
  const fonts = await fontFaces();
  for (const [lang, label] of [["en", "IT Team Leadership"], ["th", "ภาษาไทย ทดสอบระบบ"]]) {
    const response = await POST(request({ lang, fonts, nodes: [
      { depth: 0, tag: "div", style: { "font-family": '"Noto Sans Thai"', "font-size": "18px", "font-weight": "400", "padding-top": "32px", "padding-left": "32px", "color": "black" } },
      { depth: 1, tag: "p", style: { "margin-top": "0px" } },
      { depth: 2, tag: "#text", text: label },
    ] }));
    assert.equal(response.status, 200, "PDF export " + lang + ": " + (response.ok ? "OK" : await response.text()));
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    const data = new Uint8Array(await response.arrayBuffer());
    const pdf = await getDocument({ data }).promise;
    assert.equal(pdf.numPages, 1, "A4 page count " + lang);
    const page = await pdf.getPage(1);
    const [x0,y0,x1,y1] = page.view;
    assert.ok(Math.abs(x1-x0-595.28)<2 && Math.abs(y1-y0-841.89)<2, "A4 dimensions");
    const text = (await page.getTextContent()).items.map((item) => item.str || "").join("");
    const normalize = (s) => s.normalize("NFC").replace(/\s+/g, "");
    assert.ok(normalize(text).includes(normalize(label)), "Extractable " + lang + " text: " + text);
    await pdf.destroy();
    console.log("PASS", lang, "A4 1 page, PDF attachment, extractable text");
  }
  console.log("PASS authentication and validation checks");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// Bounded, structured A4 snapshot shared by browser and PDF renderer.
export const pdfTags = ["div","header","section","h1","h2","p","ul","li","span","b","strong","a","img","br","#text"] as const;
export const pdfStyles = [
  "display","float","clear","box-sizing","min-width","max-width",
  "margin-top","margin-right","margin-bottom","margin-left",
  "padding-top","padding-right","padding-bottom","padding-left",
  "border-top-width","border-top-style","border-top-color",
  "border-bottom-width","border-bottom-style","border-bottom-color",
  "border-left-width","border-left-style","border-left-color",
  "border-right-width","border-right-style","border-right-color",
  "font-family","font-size","font-weight","font-style","font-stretch",
  "font-feature-settings","font-variation-settings","font-optical-sizing","font-kerning",
  "line-height","letter-spacing","text-align","text-transform","white-space","overflow-wrap",
  "word-break","vertical-align","color","background-color","flex-grow","flex-shrink",
  "flex-basis","flex-direction","flex-wrap","align-items","justify-content","row-gap",
  "column-gap","list-style-type","list-style-position","object-fit","object-position",
  "width","height","text-decoration-line","text-indent",
] as const;
export const fontStyles = ["font-family","font-style","font-weight","font-stretch","unicode-range"] as const;
export const PDF_MAX_BYTES = 3_500_000;
export const PDF_MAX_NODES = 2500;
export type PdfNode = { depth: number; tag: (typeof pdfTags)[number]; text?: string; style?: Record<string,string>; href?: string; src?: string };
export type PdfFont = { style: Record<string,string>; src: string };
export type PdfSnapshot = { lang: "en" | "th"; nodes: PdfNode[]; fonts: PdfFont[] };

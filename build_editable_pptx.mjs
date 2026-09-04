#!/usr/bin/env node
/** Build an editable A4 PowerPoint companion from pdf-template-v1 JSON. */

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(process.env.AOUNMED_RENDER_ROOT || path.dirname(new URL(import.meta.url).pathname));
// The editor owns the project's ordinary npm dependencies. Resolve from its
// package boundary so this standalone builder never relies on a Codex cache or
// another machine-global module tree.
const require = createRequire(path.join(ROOT, "editor", "package.json"));
const PptxGenJS = require("pptxgenjs");
const JSZip = require("jszip");

const PX_PER_POINT = 96 / 72;
const W = 595.2756 * PX_PER_POINT;
const H = 841.8898 * PX_PER_POINT;
const C = {
  background: "#99BFD4",
  slate: "#507283",
  navy: "#00004D",
  mutedBlue: "#C7DFEA",
  answerBlue: "#557A8A",
  shadow: "#A7BBC5",
  white: "#FFFFFF",
  black: "#000000",
  caseText: "#263238",
  caseFill: "#EDF5F8",
};
const F = {
  cover: "Fredoka",
  title: "Fredoka SemiBold",
  body: "Work Sans",
  arabic: "Noto Sans Arabic",
};
const FONT_DIR = path.join(ROOT, "assets", "fonts");
const EMBEDDED_FONT_FILES = [
  // Keep the names aligned with the typefaces used by the editable text boxes.
  { name: "Fredoka", family: "swiss", face: 2, file: "Fredoka-Bold.ttf" },
  { name: "Fredoka SemiBold", family: "swiss", face: 2, file: "Fredoka-SemiBold.ttf" },
  { name: "Work Sans", family: "swiss", face: 1, file: "WorkSans-Regular.ttf" },
  { name: "Work Sans", family: "swiss", face: 2, file: "WorkSans-Bold.ttf" },
  { name: "Work Sans", family: "swiss", face: 3, file: "WorkSans-Italic.ttf" },
  { name: "Noto Sans Arabic", family: "swiss", face: 2, file: "NotoSansArabic-Bold.ttf" },
];
const P = {
  panelX: 16 * PX_PER_POINT,
  panelY: 25 * PX_PER_POINT,
  panelW: W - 32 * PX_PER_POINT,
  panelH: H - 45 * PX_PER_POINT,
  bodyTop: (841.8898 - 105) * PX_PER_POINT,
  bodyBottom: 74 * PX_PER_POINT,
  bodyLeft: 36 * PX_PER_POINT,
  bodyRight: W - 36 * PX_PER_POINT,
  columnGap: 18 * PX_PER_POINT,
};
P.columnWidth = (P.bodyRight - P.bodyLeft - P.columnGap) / 2;

function parseArgs(argv) {
  const result = {
    input: path.join(ROOT, "sample_packet.json"),
    output: path.join(ROOT, "output", "pptx", "week1-template-editable.pptx"),
    qaDir: path.join(ROOT, "output", "pptx-renders"),
    layout: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--output") result.output = path.resolve(argv[++i]);
    else if (argv[i] === "--qa-dir") result.qaDir = path.resolve(argv[++i]);
    else if (argv[i] === "--layout") {
      const layoutPath = argv[++i];
      if (!layoutPath) throw new Error("--layout requires a JSON file path");
      result.layout = path.resolve(layoutPath);
    }
    else if (!argv[i].startsWith("--")) result.input = path.resolve(argv[i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

function validatePacket(packet) {
  if (packet?.schema_version !== "pdf-template-v1") {
    throw new Error("schema_version must be pdf-template-v1");
  }
  const document = packet.document;
  if (!document?.title || !document?.week) {
    throw new Error("document title and week are required");
  }
  // The public contract groups layout sections under lectures.  Keep the
  // renderer/builder's long-standing flat section pipeline as an internal
  // representation so old packets and the new nested form produce the same
  // deterministic pages.
  let sections = document.sections;
  if (!Array.isArray(sections)) {
    if (!Array.isArray(document.lectures)) {
      throw new Error("document.lectures (or legacy document.sections) is required");
    }
    sections = [];
    for (const lecture of document.lectures) {
      if (!lecture || typeof lecture !== "object" || !Array.isArray(lecture.sections)) {
        throw new Error("each document lecture must contain sections");
      }
      for (const section of lecture.sections) {
        sections.push({
          ...section,
          lecture: section.lecture ?? { id: lecture.id, title: lecture.title },
        });
      }
    }
  }
  if (sections.length === 0) throw new Error("document must contain at least one section");
  const ids = new Set();
  for (const section of sections) {
    if (!section?.id || ids.has(section.id)) throw new Error(`section ids must be unique: ${section?.id || "(missing)"}`);
    ids.add(section.id);
  }
  return { ...document, sections };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function questionKey(sectionId, questionId) {
  return `${sectionId}:${questionId}`;
}

function layoutCoversDocument(layout, document) {
  if (!Array.isArray(layout)) return false;
  const expected = new Set();
  for (const section of document.sections) {
    if (!Array.isArray(section.questions)) return false;
    for (const question of section.questions) expected.add(questionKey(section.id, question.id));
  }
  if (layout.length !== expected.size) return false;
  const seen = new Set();
  for (const item of layout) {
    if (!item || typeof item !== "object") return false;
    const key = questionKey(item.section_id, item.item_id);
    if (!expected.has(key) || seen.has(key)) return false;
    if (!Number.isInteger(item.page) || item.page < 2) return false;
    if (![item.x, item.y, item.width, item.height].every(Number.isFinite)) return false;
    if (item.width <= 0 || item.height <= 0) return false;
    if (item.x < 0 || item.y < 0 || item.x + item.width > 595.2756 + 1 || item.y + item.height > 841.8898 + 1) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

function layoutCandidates(inputPath, explicitLayoutPath) {
  if (explicitLayoutPath) {
    return [{
      layoutPath: explicitLayoutPath,
      manifestPath: path.join(path.dirname(explicitLayoutPath), "manifest.json"),
    }];
  }
  const inputDir = path.dirname(inputPath);
  return [
    {
      layoutPath: path.join(inputDir, "render-audit", "layout-plan.json"),
      manifestPath: path.join(inputDir, "render-audit", "manifest.json"),
    },
    {
      layoutPath: path.join(inputDir, "layout-plan.json"),
      manifestPath: path.join(inputDir, "manifest.json"),
    },
    {
      layoutPath: path.join(ROOT, "output", "layout-plan.json"),
      manifestPath: path.join(ROOT, "output", "manifest.json"),
    },
  ];
}

async function readLayoutPlan(inputPath, document, explicitLayoutPath) {
  const inputHash = await sha256File(inputPath);
  const seen = new Set();
  for (const candidate of layoutCandidates(inputPath, explicitLayoutPath)) {
    const resolvedLayoutPath = path.resolve(candidate.layoutPath);
    if (seen.has(resolvedLayoutPath)) continue;
    seen.add(resolvedLayoutPath);
    try {
      const layout = JSON.parse(await fs.readFile(resolvedLayoutPath, "utf8"));
      try {
        const manifest = JSON.parse(await fs.readFile(candidate.manifestPath, "utf8"));
        if (manifest.input_sha256 && manifest.input_sha256 !== inputHash) continue;
      } catch {
        // A layout without a manifest can still be used when its question IDs match exactly.
      }
      if (layoutCoversDocument(layout, document)) return layout;
    } catch {
      // Try the next packet-local or default layout checkpoint.
    }
  }
  return [];
}

const pxToInches = (value) => value / 96;
const pptxColor = (value) => String(value || "").replace(/^#/, "");
const pptxPosition = (position) => ({
  x: pxToInches(position.left),
  y: pxToInches(position.top),
  w: pxToInches(position.width),
  h: pxToInches(position.height),
});
const pptxFill = (fill) => fill === "none"
  ? { color: "FFFFFF", transparency: 100 }
  : { color: pptxColor(fill) };
const pptxLine = (fill, width) => fill === "none" || width <= 0
  ? { color: "FFFFFF", transparency: 100, width: 0 }
  : { color: pptxColor(fill), width };

function pptxTextStyle(style = {}, link) {
  const hyperlink = link?.uri?.match(/slide(\d+)\.xml/)?.[1];
  return {
    ...(style.typeface ? { fontFace: style.typeface } : {}),
    ...(style.fontSize !== undefined ? { fontSize: Number.parseFloat(style.fontSize) } : {}),
    ...(style.color ? { color: pptxColor(style.color) } : {}),
    ...(style.bold !== undefined ? { bold: style.bold } : {}),
    ...(style.italic !== undefined ? { italic: style.italic } : {}),
    ...(style.underline ? { underline: { style: "sng" } } : {}),
    ...(hyperlink ? { hyperlink: { slide: Number(hyperlink) } } : {}),
  };
}

function pptxText(text) {
  if (!Array.isArray(text)) return String(text ?? "");
  const paragraphs = text.some((item) => Array.isArray(item)) ? text : [text];
  const runs = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const parts = Array.isArray(paragraph) ? paragraph : [paragraph];
    parts.forEach((part, partIndex) => {
      const isLast = partIndex === parts.length - 1;
      if (typeof part === "string") {
        runs.push({ text: part, options: { breakLine: isLast && paragraphIndex < paragraphs.length - 1 } });
      } else {
        runs.push({
          text: String(part?.run ?? ""),
          options: {
            ...pptxTextStyle(part?.textStyle, part?.link),
            ...(isLast && paragraphIndex < paragraphs.length - 1 ? { breakLine: true } : {}),
          },
        });
      }
    });
  });
  return runs;
}

function addShape(slide, geometry, name, position, fill = "none", lineFill = "none", lineWidth = 0) {
  const shapeType = {
    roundRect: "roundRect",
    rect: "rect",
    line: "line",
    ellipse: "ellipse",
  }[geometry];
  if (!shapeType) throw new Error(`Unsupported editable shape: ${geometry}`);
  slide.addShape(shapeType, {
    ...pptxPosition(position),
    fill: pptxFill(fill),
    line: pptxLine(lineFill, lineWidth),
    objectName: name,
  });
}

function addText(slide, name, text, position, style = {}, fill = "none", lineFill = "none", radius) {
  // PptxGenJS text boxes are rectangular. Preserve the rounded badges/panels
  // by placing an editable rounded rectangle behind the transparent text box.
  if (radius !== undefined) {
    addShape(slide, "roundRect", `${name}-background`, position, fill, lineFill, lineFill === "none" ? 0 : 1);
    fill = "none";
    lineFill = "none";
  }
  const options = {
    ...pptxPosition(position),
    fontFace: style.typeface || F.body,
    fontSize: style.fontSize === undefined ? 13 : Number.parseFloat(style.fontSize),
    color: pptxColor(style.color || C.black),
    bold: style.bold,
    italic: style.italic,
    align: style.alignment,
    valign: style.verticalAlignment === "middle" ? "mid" : style.verticalAlignment,
    fit: "shrink",
    margin: style.insets
      ? [style.insets.top, style.insets.right, style.insets.bottom, style.insets.left]
      : [1, 2, 1, 2],
    fill: pptxFill(fill),
    line: pptxLine(lineFill, lineFill === "none" ? 0 : 1),
    objectName: name,
  };
  slide.addText(pptxText(text), options);
  return { text: {} };
}

function addPageSkin(slide, pageNumber) {
  slide.background = { color: pptxColor(C.background) };
  addShape(
    slide,
    "roundRect",
    "content-panel",
    { left: P.panelX, top: H - P.panelY - P.panelH, width: P.panelW, height: P.panelH },
    C.white,
    C.navy,
    1.7,
    22,
  );
  addText(
    slide,
    "page-number",
    String(pageNumber),
    { left: W / 2 - 20, top: H - 26, width: 40, height: 18 },
    { typeface: F.body, fontSize: 12, bold: true, alignment: "center", verticalAlignment: "middle" },
  );
}

function addCoverText(slide, name, text, top, fontSize) {
  addText(
    slide,
    `${name}-shadow`,
    text.toUpperCase(),
    { left: 48, top: top + 8, width: W - 96, height: fontSize * 1.55 },
    { typeface: F.cover, fontSize, bold: true, color: C.shadow, alignment: "center", verticalAlignment: "middle" },
  );
  addText(
    slide,
    name,
    text.toUpperCase(),
    { left: 41, top, width: W - 96, height: fontSize * 1.55 },
    { typeface: F.cover, fontSize, bold: true, color: C.white, alignment: "center", verticalAlignment: "middle" },
  );
}

function addSkinIcon(slide, x, y) {
  addShape(slide, "roundRect", "skin-surface", { left: x, top: y, width: 109, height: 76 }, "#F8B07A", "none", 0, 7);
  addShape(slide, "rect", "skin-lower-layer", { left: x, top: y + 52, width: 109, height: 24 }, "#F08072");
  for (const [index, offset] of [20, 51, 83].entries()) {
    addShape(slide, "line", `hair-${index + 1}`, { left: x + offset - 5, top: y, width: 5, height: 37 }, "none", "#7D3D46", 1.3);
    addShape(slide, "ellipse", `follicle-${index + 1}`, { left: x + offset - 10, top: y + 34, width: 10, height: 10 }, "none", "#7D3D46", 1.3);
  }
  addShape(slide, "ellipse", "skin-vessel", { left: x + 81, top: y + 60, width: 11, height: 11 }, "#D45664");
}

function drawCover(presentation, document, sectionSlides) {
  const slide = presentation.addSlide();
  slide.background = { color: pptxColor(C.background) };
  addShape(slide, "roundRect", "cover-title-panel", { left: 21, top: 25, width: W - 42, height: 467 }, C.slate, C.navy, 1.7, 23);
  addShape(slide, "roundRect", "cover-toc-panel", { left: 25, top: 520, width: W - 50, height: 567 }, C.slate, C.navy, 1.7, 23);
  addCoverText(slide, "course-title", document.title, 112, 69);
  addCoverText(slide, "week-title", document.week, 260, 59);
  addText(slide, "toc-title-shadow", "TABLE OF CONTENT", { left: 55, top: 605, width: 500, height: 52 }, { typeface: F.cover, fontSize: 32, bold: true, color: C.shadow });
  addText(slide, "toc-title", "TABLE OF CONTENT", { left: 49, top: 598, width: 500, height: 52 }, { typeface: F.cover, fontSize: 32, bold: true, color: C.white });

  let top = 666;
  document.sections.forEach((section, index) => {
    addText(
      slide,
      `toc-${section.id}`,
      [{ run: section.title, textStyle: { bold: true, underline: "sng", typeface: F.body, fontSize: "13pt", color: C.white }, link: { uri: `../slides/slide${sectionSlides.get(section.id)}.xml`, isExternal: false, action: "ppaction://hlinksldjump" } }],
      { left: 39, top, width: W - 170, height: 31 },
      { typeface: F.body, fontSize: 13, bold: true, color: C.white, verticalAlignment: "middle" },
    );
    top += 40;
  });
  addSkinIcon(slide, W - 166, 680);
  return slide;
}

function sectionHeader(slide, title, twoColumn) {
  addText(
    slide,
    "section-title",
    title,
    { left: 48, top: 43, width: W - 96, height: 55 },
    { typeface: F.title, fontSize: 24, bold: true, color: C.slate, alignment: "center", verticalAlignment: "middle" },
  );
  if (twoColumn) {
    addShape(slide, "line", "column-divider", { left: W / 2, top: 138, width: 0, height: 831 }, "none", "#1A1A1A", 0.75);
  }
}

function addBadge(slide, label) {
  const width = label === "Explain why" ? 126 : 76;
  addText(
    slide,
    "section-badge",
    label,
    { left: P.bodyLeft, top: 130, width, height: 34 },
    { typeface: F.body, fontSize: 15.3, bold: true, verticalAlignment: "middle" },
    C.mutedBlue,
    "none",
    8,
  );
}

function estimatedLines(text, charsPerLine) {
  return Math.max(1, Math.ceil(String(text).length / charsPerLine));
}

function estimatedWrappedLines(text, charsPerLine) {
  return String(text)
    .split(/\r?\n/)
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

const EXPLANATION_TOP_GAP = 5;
const EXPLANATION_BOTTOM_GAP = 7;

function explanationLayout(question, width, mode) {
  if (!question.explanation) return null;
  const fontSize = mode === "mcq" ? 8.8 : 9.2;
  const lineHeight = mode === "mcq" ? 12 : 12.7;
  const horizontalMargin = mode === "mcq" ? 12 : 13;
  const usableWidth = Math.max(40, width - horizontalMargin * 2);
  const charsPerLine = Math.max(30, Math.floor(usableWidth / (fontSize * 0.58)));
  const text = `Explanation: ${question.explanation}`;
  const lines = estimatedWrappedLines(text, charsPerLine);
  const boxHeight = Math.max(24, Math.ceil(lines * lineHeight + 8));
  return {
    text,
    fontSize,
    horizontalMargin,
    boxHeight,
    totalHeight: EXPLANATION_TOP_GAP + boxHeight + EXPLANATION_BOTTOM_GAP,
  };
}

function primaryMedia(question) {
  return mediaItems(question)[0] || null;
}

function mediaItems(question) {
  const items = [];
  if (question.image) items.push({ path: question.image, caption: question.caption, alt: question.caption });
  if (Array.isArray(question.media)) {
    items.push(...question.media.map((media) => ({ path: media.path, caption: media.caption, alt: media.alt_text })));
  }
  return items.filter((media, index) => media.path && items.findIndex((candidate) => candidate.path === media.path) === index);
}

async function addQuestionImage(slide, question, x, top, width, maxHeight) {
  const items = mediaItems(question);
  if (!items.length || maxHeight <= 0) return 0;
  const columns = Math.min(2, items.length);
  const rows = Math.ceil(items.length / columns);
  const gap = 8;
  const cellWidth = (width - gap * (columns - 1)) / columns;
  const cellHeight = (maxHeight - gap * (rows - 1)) / rows;
  for (const [index, media] of items.entries()) {
    const imagePath = path.resolve(ROOT, String(media.path));
    if (!imagePath.startsWith(`${ROOT}${path.sep}`)) throw new Error(`Unsafe image path: ${media.path}`);
    await fs.access(imagePath);
    const captionHeight = media.caption ? Math.min(25, cellHeight * 0.22) : 0;
    const imageHeight = Math.max(12, cellHeight - captionHeight);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const itemX = x + column * (cellWidth + gap);
    const itemTop = top + row * (cellHeight + gap);
    slide.addImage({
      path: imagePath,
      ...pptxPosition({ left: itemX, top: itemTop, width: cellWidth, height: imageHeight }),
      sizing: { type: "contain", x: 0, y: 0, w: pxToInches(cellWidth), h: pxToInches(imageHeight) },
      altText: media.alt || `Question ${question.number} image ${index + 1}`,
      objectName: `${question.id}-image-${index + 1}`,
    });
    if (media.caption) {
      addText(slide, `${question.id}-caption-${index + 1}`, String(media.caption), { left: itemX, top: itemTop + imageHeight, width: cellWidth, height: captionHeight }, { typeface: F.body, fontSize: 10.7, italic: true, color: C.slate });
    }
  }
  return maxHeight;
}

async function addMcqQuestion(slide, question, frame) {
  let top = frame.top;
  const explanation = explanationLayout(question, frame.width, "mcq");
  if (question.case) {
    const caseHeight = (estimatedLines(question.case, 48) * 15 + 29);
    addText(
      slide,
      `${question.id}-case`,
      [[{ run: "Case", textStyle: { bold: true } }], [String(question.case)]],
      { left: frame.left, top, width: frame.width, height: caseHeight },
      { typeface: F.body, fontSize: 11.6, italic: true, color: C.caseText, verticalAlignment: "middle", insets: { top: 5, right: 7, bottom: 5, left: 7 } },
      C.caseFill,
    );
    top += caseHeight + 5;
  }
  const sourceText = question.source_refs?.length ? question.source_refs.join("; ") : lectureReference(question);
  const source = sourceText ? ` (${sourceText})` : "";
  const stemHeight = estimatedLines(`${question.number}. ${question.stem}${source}`, 55) * 16 + 5;
  addText(
    slide,
    `${question.id}-stem`,
    [[
      { run: `${question.number}. ${question.stem}`, textStyle: { bold: true, typeface: F.body, fontSize: "9.4pt", color: C.black } },
      ...(source ? [{ run: source, textStyle: { italic: true, typeface: F.body, fontSize: "7.2pt", color: C.answerBlue } }] : []),
    ]],
    { left: frame.left, top, width: frame.width, height: stemHeight },
    { typeface: F.body, fontSize: 12.5, bold: true },
  );
  top += stemHeight + 3;
  const note = Array.isArray(question.notes) ? question.notes.find((item) => item?.text)?.text : "";
  const richReserve = (note ? 28 : 0) + (explanation?.totalHeight || 0) + (question.bank_source ? 25 : 0);
  const optionHeight = Math.max(
    14,
    (frame.top + frame.height - top - 10 - richReserve - (primaryMedia(question) ? 120 : 0)) / question.options.length,
  );
  for (const option of question.options) {
    addText(slide, `${question.id}-option-${option.label}`, `${option.label}. ${option.text}`, { left: frame.left + 5, top, width: frame.width - 5, height: optionHeight }, { typeface: F.body, fontSize: 11.7, insets: { top: 0, right: 2, bottom: 0, left: 2 } });
    top += optionHeight;
  }
  if (note) {
    addText(slide, `${question.id}-note`, String(note), { left: frame.left, top, width: frame.width, height: 28 }, { typeface: F.body, fontSize: 10.8, italic: true, color: C.slate, insets: { top: 3, right: 6, bottom: 3, left: 6 } }, C.caseFill);
    top += 28;
  }
  if (explanation) {
    top += EXPLANATION_TOP_GAP;
    addText(
      slide,
      `${question.id}-explanation`,
      explanation.text,
      {
        left: frame.left + explanation.horizontalMargin,
        top,
        width: frame.width - explanation.horizontalMargin * 2,
        height: explanation.boxHeight,
      },
      {
        typeface: F.body,
        fontSize: explanation.fontSize,
        color: C.caseText,
        insets: { top: 2, right: 3, bottom: 2, left: 3 },
      },
    );
    top += explanation.boxHeight + EXPLANATION_BOTTOM_GAP;
  }
  if (question.bank_source) {
    const bank = question.bank_source;
    const pages = Array.isArray(bank.page_numbers) ? bank.page_numbers.join(", ") : "";
    addText(slide, `${question.id}-bank-source`, `Bank source: ${bank.name || bank.bank_id || "Question bank"}${bank.question_number ? ` · question ${bank.question_number}` : ""}${pages ? ` · page ${pages}` : ""}`, { left: frame.left, top, width: frame.width, height: 25 }, { typeface: F.body, fontSize: 9.8, italic: true, color: C.answerBlue });
    top += 25;
  }
  await addQuestionImage(slide, question, frame.left, top + 3, frame.width, Math.max(0, frame.top + frame.height - top - 3));
}

async function addSingleQuestion(slide, question, frame, showAnswer) {
  const sourceText = question.source_refs?.length ? question.source_refs.join("; ") : lectureReference(question);
  const source = sourceText ? ` (${sourceText})` : "";
  const stemText = `${question.number}. ${question.stem}`;
  const note = Array.isArray(question.notes) ? question.notes.find((item) => item?.text)?.text : "";
  const renderAnswer = Boolean(question.answer) && (showAnswer || question.type === "other");
  const noteHeight = note ? 27 : 0;
  const explanation = explanationLayout(question, frame.width, "single");
  const bankHeight = question.bank_source ? 24 : 0;
  const mediaHeight = primaryMedia(question) ? Math.min(210, frame.height * 0.45) : 0;
  const answerHeight = renderAnswer ? Math.max(30, Math.min(58, estimatedLines(question.answer, 92) * 18 + 10)) : 0;
  const metadataHeight = noteHeight + (explanation?.totalHeight || 0) + bankHeight + mediaHeight + answerHeight;
  const stemHeight = Math.max(25, Math.min(frame.height - metadataHeight, estimatedLines(stemText + source, 100) * 21 + 14));
  addText(
    slide,
    `${question.id}-stem`,
    [[
      { run: stemText, textStyle: { bold: true, typeface: F.body, fontSize: "10.2pt", color: C.black } },
      ...(source ? [{ run: source, textStyle: { italic: true, typeface: F.body, fontSize: "7.2pt", color: C.answerBlue } }] : []),
    ]],
    { left: frame.left, top: frame.top, width: frame.width, height: stemHeight },
    { typeface: F.body, fontSize: 13.6, bold: true },
  );
  let top = frame.top + stemHeight;
  if (renderAnswer) {
    addText(
      slide,
      `${question.id}-answer`,
      [[{ run: "Answer: ", textStyle: { bold: true } }, { run: String(question.answer) }]],
      { left: frame.left + 13, top, width: frame.width - 13, height: answerHeight },
      { typeface: F.body, fontSize: 13.1, bold: true, color: C.answerBlue },
    );
    top += answerHeight;
  }
  if (note) {
    addText(slide, `${question.id}-note`, String(note), { left: frame.left, top, width: frame.width, height: noteHeight }, { typeface: F.body, fontSize: 11.7, italic: true, color: C.slate, insets: { top: 3, right: 6, bottom: 3, left: 6 } }, C.caseFill);
    top += noteHeight;
  }
  if (explanation) {
    top += EXPLANATION_TOP_GAP;
    addText(
      slide,
      `${question.id}-explanation`,
      explanation.text,
      {
        left: frame.left + explanation.horizontalMargin,
        top,
        width: frame.width - explanation.horizontalMargin * 2,
        height: explanation.boxHeight,
      },
      {
        typeface: F.body,
        fontSize: explanation.fontSize,
        color: C.caseText,
        insets: { top: 2, right: 3, bottom: 2, left: 3 },
      },
    );
    top += explanation.boxHeight + EXPLANATION_BOTTOM_GAP;
  }
  if (question.bank_source) {
    const bank = question.bank_source;
    const pages = Array.isArray(bank.page_numbers) ? bank.page_numbers.join(", ") : "";
    addText(slide, `${question.id}-bank-source`, `Bank source: ${bank.name || bank.bank_id || "Question bank"}${bank.question_number ? ` · question ${bank.question_number}` : ""}${pages ? ` · page ${pages}` : ""}`, { left: frame.left, top, width: frame.width, height: bankHeight }, { typeface: F.body, fontSize: 10.7, italic: true, color: C.answerBlue });
    top += bankHeight;
  }
  await addQuestionImage(slide, question, frame.left, top + 3, frame.width, Math.max(0, frame.top + frame.height - top - 3));
}

function lectureReference(question) {
  if (!Array.isArray(question.lecture_refs) || !question.lecture_refs.length) return "";
  return question.lecture_refs.map((ref) => {
    const slides = Array.isArray(ref.slide_numbers) ? ref.slide_numbers.join(", ") : "";
    return `${ref.lecture_title || "Lecture"}${slides ? `, slide${ref.slide_numbers.length > 1 ? "s" : ""} ${slides}` : ""}`;
  }).join("; ");
}

async function addOspeQuestion(slide, question, frame) {
  let top = frame.top;
  const explanation = explanationLayout(question, frame.width, "ospe");
  if (question.case) {
    addText(slide, `${question.id}-case`, [[{ run: "Case", textStyle: { italic: true } }], [String(question.case)]], { left: frame.left, top, width: frame.width, height: 43 }, { typeface: F.body, fontSize: 12.5, italic: true, color: C.caseText, insets: { top: 4, right: 6, bottom: 4, left: 6 } }, C.caseFill);
    top += 43;
  }
  const reference = lectureReference(question);
  addText(slide, `${question.id}-stem`, [[{ run: `${question.number}. ${question.stem}`, textStyle: { bold: true, typeface: F.body, fontSize: "10.2pt" } }, ...(reference ? [{ run: ` (${reference})`, textStyle: { bold: true, typeface: F.body, fontSize: "8pt", color: C.answerBlue } }] : [])]], { left: frame.left, top, width: frame.width, height: 27 }, { typeface: F.body, fontSize: 13.6, bold: true });
  top += 27;
  const note = Array.isArray(question.notes) ? question.notes.find((item) => item?.text)?.text : "";
  if (note) {
    addText(slide, `${question.id}-instruction`, String(note), { left: frame.left, top, width: frame.width, height: 27 }, { typeface: F.body, fontSize: 11.7, italic: true, color: C.slate, insets: { top: 3, right: 6, bottom: 3, left: 6 } }, C.caseFill);
    top += 27;
  }
  if (question.answer) {
    addText(slide, `${question.id}-answer`, [[{ run: "Answer: ", textStyle: { bold: true } }, { run: String(question.answer), textStyle: { bold: true } }]], { left: frame.left + 14, top, width: frame.width - 14, height: 27 }, { typeface: F.body, fontSize: 13.1, bold: true, color: C.answerBlue });
    top += 27;
  }
  if (explanation) {
    top += EXPLANATION_TOP_GAP;
    addText(
      slide,
      `${question.id}-explanation`,
      explanation.text,
      {
        left: frame.left + explanation.horizontalMargin,
        top,
        width: frame.width - explanation.horizontalMargin * 2,
        height: explanation.boxHeight,
      },
      {
        typeface: F.body,
        fontSize: explanation.fontSize,
        color: C.caseText,
        insets: { top: 2, right: 3, bottom: 2, left: 3 },
      },
    );
    top += explanation.boxHeight + EXPLANATION_BOTTOM_GAP;
  }
  if (question.bank_source) {
    const bank = question.bank_source;
    const pages = Array.isArray(bank.page_numbers) ? bank.page_numbers.join(", ") : "";
    const bankText = `Bank source: ${bank.name || bank.bank_id || "Question bank"}${bank.question_number ? ` · question ${bank.question_number}` : ""}${pages ? ` · page ${pages}` : ""}`;
    addText(slide, `${question.id}-bank-source`, bankText, { left: frame.left, top, width: frame.width, height: 24 }, { typeface: F.body, fontSize: 10.7, italic: true, color: C.answerBlue });
    top += 24;
  }
  await addQuestionImage(slide, question, frame.left, top + 4, frame.width, Math.max(0, frame.top + frame.height - top - 4));
}

function framesFromLayout(layout, sectionId) {
  return layout
    .filter((item) => item.section_id === sectionId)
    .map((item) => ({
      id: item.item_id,
      column: item.column,
      left: item.x * PX_PER_POINT,
      top: (841.8898 - item.y - item.height) * PX_PER_POINT,
      width: item.width * PX_PER_POINT,
      height: item.height * PX_PER_POINT,
    }));
}

const FALLBACK_GAP = 6;

function fallbackSource(question) {
  const sourceText = question.source_refs?.length ? question.source_refs.join("; ") : lectureReference(question);
  return sourceText ? ` (${sourceText})` : "";
}

function fallbackOptionHeight(option, width) {
  const charsPerLine = Math.max(24, Math.floor(width / 7));
  return Math.max(14, estimatedLines(`${option.label}. ${option.text}`, charsPerLine) * 14);
}

function fallbackQuestionHeight(question, width) {
  const source = fallbackSource(question);
  if (question.type === "mcq" || question.type === "multi_select") {
    const hasCase = Boolean(question.case);
    const caseHeight = hasCase ? estimatedLines(question.case, 48) * 15 + 29 : 0;
    const stemHeight = estimatedLines(`${question.number}. ${question.stem}${source}`, 55) * 16 + 5;
    const options = Array.isArray(question.options) ? question.options : [];
    const optionHeight = options.length ? Math.max(...options.map((option) => fallbackOptionHeight(option, width))) : 14;
    const note = Array.isArray(question.notes) ? question.notes.find((item) => item?.text)?.text : "";
    const noteHeight = note ? 28 : 0;
    const explanationHeight = explanationLayout(question, width, "mcq")?.totalHeight || 0;
    const bankHeight = question.bank_source ? 25 : 0;
    const mediaHeight = primaryMedia(question) ? 120 : 0;
    return (
      caseHeight
      + (hasCase ? 5 : 0)
      + stemHeight
      + 3
      + optionHeight * options.length
      + noteHeight
      + explanationHeight
      + bankHeight
      + (mediaHeight ? mediaHeight + 3 : 0)
      + 10
    );
  }

  if (question.type === "ospe") {
    const caseHeight = question.case ? 43 : 0;
    const noteHeight = Array.isArray(question.notes) && question.notes.some((item) => item?.text) ? 27 : 0;
    const answerHeight = question.answer ? 27 : 0;
    const explanationHeight = explanationLayout(question, width, "ospe")?.totalHeight || 0;
    const bankHeight = question.bank_source ? 24 : 0;
    const mediaHeight = primaryMedia(question) ? 210 : 0;
    return caseHeight + 27 + noteHeight + answerHeight + explanationHeight + bankHeight + (mediaHeight ? mediaHeight + 4 : 0) + 10;
  }

  const noteHeight = Array.isArray(question.notes) && question.notes.some((item) => item?.text) ? 27 : 0;
  const explanationHeight = explanationLayout(question, width, "single")?.totalHeight || 0;
  const bankHeight = question.bank_source ? 24 : 0;
  const mediaHeight = primaryMedia(question) ? 210 : 0;
  const renderAnswer = Boolean(question.answer);
  const answerHeight = renderAnswer ? Math.max(30, Math.min(58, estimatedLines(question.answer, 92) * 18 + 10)) : 0;
  const stemHeight = Math.max(25, estimatedLines(`${question.number}. ${question.stem}${source}`, 100) * 21 + 14);
  return stemHeight + answerHeight + noteHeight + explanationHeight + bankHeight + (mediaHeight ? mediaHeight + 3 : 0) + 10;
}

function columnHeight(heights) {
  return heights.reduce((total, height, index) => total + height + (index ? FALLBACK_GAP : 0), 0);
}

function fallbackFramesForColumn(questions, start, left, width) {
  let top = start;
  return questions.map((question) => {
    const frame = { id: question.id, left, top, width, height: fallbackQuestionHeight(question, width) };
    top += frame.height + FALLBACK_GAP;
    return frame;
  });
}

function balancedFallbackPartition(questions, capacity, width) {
  const heights = questions.map((question) => fallbackQuestionHeight(question, width));
  for (let take = heights.length; take > 0; take -= 1) {
    const candidates = [];
    for (let split = 1; split <= take; split += 1) {
      const leftHeight = columnHeight(heights.slice(0, split));
      const rightHeight = columnHeight(heights.slice(split, take));
      if (leftHeight <= capacity && rightHeight <= capacity) {
        candidates.push({ difference: Math.abs(leftHeight - rightHeight), split });
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.difference - b.difference || a.split - b.split);
      return { take, split: candidates[0].split, heights };
    }
  }
  throw new Error(`Question ${questions[0]?.id || "unknown"} cannot fit the editable MCQ page`);
}

function fallbackSectionPlans(section, firstPage) {
  const plans = [];
  const twoColumn = section.layout === "mcq_two_column";
  const start = twoColumn ? 140 : 177;
  const width = twoColumn ? P.columnWidth : P.bodyRight - P.bodyLeft;
  const capacity = H - P.bodyBottom - start;
  let remaining = [...section.questions];
  let page = firstPage;

  while (remaining.length) {
    if (twoColumn) {
      const partition = balancedFallbackPartition(remaining, capacity, width);
      const pageQuestions = remaining.slice(0, partition.take);
      remaining = remaining.slice(partition.take);
      const leftQuestions = pageQuestions.slice(0, partition.split);
      const rightQuestions = pageQuestions.slice(partition.split);
      const frames = [
        ...fallbackFramesForColumn(leftQuestions, start, P.bodyLeft, width),
        ...fallbackFramesForColumn(rightQuestions, start, W / 2 + P.columnGap / 2, width),
      ];
      plans.push({ section, page, questions: pageQuestions, frames });
    } else {
      const pageQuestions = [];
      let used = 0;
      while (remaining.length) {
        const questionHeight = fallbackQuestionHeight(remaining[0], width);
        if (questionHeight > capacity) {
          throw new Error(`Question ${remaining[0].id} cannot fit the editable page`);
        }
        const nextUsed = used + questionHeight + (pageQuestions.length ? FALLBACK_GAP : 0);
        if (pageQuestions.length && nextUsed > capacity) break;
        pageQuestions.push(remaining.shift());
        used = nextUsed;
      }
      plans.push({ section, page, questions: pageQuestions, frames: fallbackFramesForColumn(pageQuestions, start, P.bodyLeft, width) });
    }
    page += 1;
  }

  if (Array.isArray(section.hints) && section.hints.length) {
    plans.push({ section, page, kind: "hints" });
    page += 1;
  }
  return { plans, nextPage: page };
}

function reflowLayoutFrames(section, pageItems) {
  const frames = framesFromLayout(pageItems, section.id);
  const questions = new Map(section.questions.map((question) => [question.id, question]));
  const groups = section.layout === "mcq_two_column"
    ? [
      frames.filter((frame) => frame.column === 0 || frame.left < W / 2),
      frames.filter((frame) => frame.column === 1 || frame.left >= W / 2),
    ]
    : [frames];
  const pageBottom = H - P.bodyBottom;
  for (const group of groups) {
    group.sort((a, b) => a.top - b.top);
    if (!group.length) continue;
    let top = group[0].top;
    for (const frame of group) {
      const question = questions.get(frame.id);
      if (!question) return null;
      frame.top = top;
      frame.height = Math.max(frame.height, fallbackQuestionHeight(question, frame.width));
      top += frame.height + FALLBACK_GAP;
    }
    if (top - FALLBACK_GAP > pageBottom) return null;
  }
  return frames;
}

async function drawSectionPage(presentation, section, questions, pageNumber, frames) {
  const slide = presentation.addSlide();
  addPageSkin(slide, pageNumber);
  const twoColumn = section.layout === "mcq_two_column";
  sectionHeader(slide, section.title, twoColumn);
  if (!twoColumn) {
    const allOspe = questions.length > 0 && questions.every((question) => question.type === "ospe");
    addBadge(slide, allOspe ? "OSPE" : section.layout === "seq_single_column" ? "SEQs" : "Explain why");
  }
  const resolvedFrames = frames.length === questions.length ? frames : fallbackFramesForColumn(questions, section.layout === "mcq_two_column" ? 140 : 177, P.bodyLeft, section.layout === "mcq_two_column" ? P.columnWidth : P.bodyRight - P.bodyLeft);
  for (const question of questions) {
    const frame = resolvedFrames.find((item) => item.id === question.id);
    if (!frame) throw new Error(`No frame for ${question.id}`);
    if (question.type === "mcq" || question.type === "multi_select") await addMcqQuestion(slide, question, frame);
    else if (question.type === "ospe") await addOspeQuestion(slide, question, frame);
    else await addSingleQuestion(slide, question, frame, question.type === "explain_why");
  }
  if (twoColumn) {
    const answers = questions.map((q) => `${q.number}-${q.answer || q.correct_answers?.join("/") || ""}`).join(" | ");
    addText(slide, "answer-key", answers, { left: W / 2 - 155, top: H - 79, width: 310, height: 25 }, { typeface: F.cover, fontSize: 11.3, bold: true, alignment: "center", verticalAlignment: "middle" }, C.background, "none", 7);
  }
  return slide;
}

function drawHintsPage(presentation, section, pageNumber) {
  const slide = presentation.addSlide();
  addPageSkin(slide, pageNumber);
  addText(slide, "hints-title", `Hints: ${section.title}`, { left: 48, top: 43, width: W - 96, height: 55 }, { typeface: F.title, fontSize: 24, bold: true, color: C.slate, alignment: "center", verticalAlignment: "middle" });
  let top = 139;
  section.hints.forEach((hint, index) => {
    addText(slide, `hint-${hint.id || index + 1}`, [[{ run: `${index + 1}.  ${hint.title}`, textStyle: { typeface: F.body, fontSize: "10.2pt" } }], [{ run: String(hint.text), textStyle: { typeface: F.body, fontSize: "10.2pt" } }]], { left: P.bodyLeft, top, width: P.bodyRight - P.bodyLeft, height: 94 }, { typeface: F.body, fontSize: 13.6, color: C.caseText, insets: { top: 2, right: 3, bottom: 2, left: 3 } });
    top += 110;
  });
  return slide;
}

function buildPagePlans(document, layout) {
  const plans = [];
  let fallbackPage = 2;
  if (!layoutCoversDocument(layout, document)) {
    for (const section of document.sections) {
      const fallback = fallbackSectionPlans(section, fallbackPage);
      plans.push(...fallback.plans);
      fallbackPage = fallback.nextPage;
    }
    return plans;
  }

  let layoutOverflow = false;
  for (const section of document.sections) {
    const sectionItems = layout.filter((item) => item.section_id === section.id);
    const pageNumbers = [...new Set(sectionItems.map((item) => item.page))].sort((a, b) => a - b);
    for (const page of pageNumbers) {
      const pageItems = sectionItems.filter((item) => item.page === page);
      const ids = new Set(pageItems.map((item) => item.item_id));
      const questions = section.questions.filter((question) => ids.has(question.id));
      const frames = reflowLayoutFrames(section, pageItems);
      if (!frames || frames.length !== questions.length) {
        layoutOverflow = true;
        break;
      }
      plans.push({ section, page, questions, frames });
    }
    if (layoutOverflow) break;
    if (Array.isArray(section.hints) && section.hints.length) {
      plans.push({ section, page: pageNumbers.at(-1) + 1, kind: "hints" });
    }
    fallbackPage = Math.max(fallbackPage, pageNumbers.at(-1) + 1);
  }
  if (layoutOverflow) {
    plans.length = 0;
    fallbackPage = 2;
    for (const section of document.sections) {
      const fallback = fallbackSectionPlans(section, fallbackPage);
      plans.push(...fallback.plans);
      fallbackPage = fallback.nextPage;
    }
  }
  return plans;
}

function drawClosing(presentation, closing, pageNumber) {
  const slide = presentation.addSlide();
  addPageSkin(slide, pageNumber);
  const paragraphs = closing.paragraphs.map(String);
  const blockTop = 385;
  paragraphs.forEach((text, index) => {
    addText(
      slide,
      `closing-paragraph-${index + 1}`,
      text,
      { left: 100, top: blockTop + index * 165, width: W - 200, height: 125 },
      { typeface: F.arabic, fontSize: 24, bold: true, color: C.black, alignment: "center", verticalAlignment: "middle", insets: { top: 3, right: 4, bottom: 3, left: 4 } },
    );
  });
  addText(slide, "closing-signoff", String(closing.signoff), { left: 170, top: blockTop + paragraphs.length * 165, width: W - 340, height: 60 }, { typeface: F.arabic, fontSize: 21.3, bold: true, alignment: "center", verticalAlignment: "middle" });
  return slide;
}

async function createPresentationWithFonts() {
  // Validate eagerly: a missing font must fail the export instead of silently
  // producing a presentation that substitutes a different typeface.
  for (const entry of EMBEDDED_FONT_FILES) {
    const filePath = path.join(FONT_DIR, entry.file);
    try {
      const data = await fs.readFile(filePath);
      if (data.byteLength === 0) throw new Error("font file is empty");
    } catch (error) {
      throw new Error(`Missing bundled font ${entry.file} (${filePath}): ${error.message}`);
    }
  }
  const presentation = new PptxGenJS();
  presentation.defineLayout({ name: "AOUNMED_A4", width: pxToInches(W), height: pxToInches(H) });
  presentation.layout = "AOUNMED_A4";
  presentation.author = "AounMED";
  presentation.company = "AounMED";
  presentation.subject = "Editable AounMED question bank";
  presentation.theme = { headFontFace: F.title, bodyFontFace: F.body, lang: "en-US" };
  return presentation;
}

const xmlEscape = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

/**
 * PptxGenJS deliberately leaves fonts to PowerPoint. Add the standard OOXML
 * embedded-font parts after generation so the editable file remains portable.
 * The bundled fonts permit embedding, and PowerPoint accepts their original
 * TrueType bytes as `application/x-fontdata` parts.
 */
async function embedFonts(pptxBytes) {
  const zip = await JSZip.loadAsync(pptxBytes);
  const presentationPath = "ppt/presentation.xml";
  const relationshipsPath = "ppt/_rels/presentation.xml.rels";
  const contentTypesPath = "[Content_Types].xml";
  let presentationXml = await zip.file(presentationPath)?.async("string");
  let relationshipsXml = await zip.file(relationshipsPath)?.async("string");
  let contentTypesXml = await zip.file(contentTypesPath)?.async("string");
  if (!presentationXml || !relationshipsXml || !contentTypesXml) {
    throw new Error("PptxGenJS output is missing required presentation OOXML parts");
  }

  const families = new Map();
  const relationships = [];
  for (const [index, entry] of EMBEDDED_FONT_FILES.entries()) {
    const relationshipId = `rIdAounmedFont${index + 1}`;
    const fileName = `aounmed-font-${index + 1}.dat`;
    zip.file(`ppt/fonts/${fileName}`, await fs.readFile(path.join(FONT_DIR, entry.file)));
    relationships.push(
      `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${fileName}"/>`,
    );
    const family = families.get(entry.name) ?? [];
    family.push({ face: entry.face, relationshipId });
    families.set(entry.name, family);
  }

  const faceElement = { 1: "regular", 2: "bold", 3: "italic", 4: "boldItalic" };
  const embeddedFontXml = [...families.entries()].map(([name, faces]) => [
    "<p:embeddedFont>",
    `<p:font typeface="${xmlEscape(name)}"/>`,
    ...faces.map(({ face, relationshipId }) => {
      const tag = faceElement[face];
      if (!tag) throw new Error(`Unsupported embedded font face ${face} for ${name}`);
      return `<p:${tag} r:id="${relationshipId}"/>`;
    }),
    "</p:embeddedFont>",
  ].join("")).join("");

  presentationXml = presentationXml.replace(
    /<p:presentation(?=[\s>])([^>]*)>/,
    (match, attributes) => {
      const withoutFlags = attributes
        .replace(/\s+embedTrueTypeFonts="[^"]*"/g, "")
        .replace(/\s+saveSubsetFonts="[^"]*"/g, "");
      return `<p:presentation${withoutFlags} embedTrueTypeFonts="1" saveSubsetFonts="0">`;
    },
  );
  presentationXml = presentationXml.replace(
    "</p:presentation>",
    `<p:embeddedFontLst>${embeddedFontXml}</p:embeddedFontLst></p:presentation>`,
  );
  relationshipsXml = relationshipsXml.replace(
    "</Relationships>",
    `${relationships.join("")}</Relationships>`,
  );
  if (!/Extension="dat"\s+ContentType="application\/x-fontdata"/.test(contentTypesXml)) {
    contentTypesXml = contentTypesXml.replace(
      "</Types>",
      '<Default Extension="dat" ContentType="application/x-fontdata"/></Types>',
    );
  }

  zip.file(presentationPath, presentationXml);
  zip.file(relationshipsPath, relationshipsXml);
  zip.file(contentTypesPath, contentTypesXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function main() {
  const args = parseArgs(process.argv);
  const packet = JSON.parse(await fs.readFile(args.input, "utf8"));
  const document = validatePacket(packet);
  const layout = await readLayoutPlan(args.input, document, args.layout);
  await fs.mkdir(path.dirname(args.output), { recursive: true });

  const presentation = await createPresentationWithFonts();
  presentation.title = document.title;
  const pagePlans = buildPagePlans(document, layout);
  const sectionSlides = new Map();
  pagePlans.forEach((plan, index) => {
    if (!sectionSlides.has(plan.section.id)) sectionSlides.set(plan.section.id, index + 2);
  });
  drawCover(presentation, document, sectionSlides);
  for (const plan of pagePlans) {
    if (plan.kind === "hints") drawHintsPage(presentation, plan.section, plan.page);
    else await drawSectionPage(presentation, plan.section, plan.questions, plan.page, plan.frames);
  }
  const closingPage = pagePlans.length ? Math.max(...pagePlans.map((plan) => plan.page)) + 1 : 2;
  if (document.closing_page) drawClosing(presentation, document.closing_page, closingPage);

  const generated = await presentation.write({ outputType: "nodebuffer", compression: true });
  await fs.writeFile(args.output, await embedFonts(generated));
  console.log(`Created ${args.output} (${presentation._slides.length} editable slides)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

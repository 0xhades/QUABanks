import { join, normalize, relative, resolve } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";

const EDITOR_ROOT = resolve(import.meta.dir);
const TEMPLATE_ROOT = resolve(EDITOR_ROOT, "..");
const PUBLIC_ROOT = join(EDITOR_ROOT, "public");
const DATA_ROOT = join(EDITOR_ROOT, "data");
const BANKS_ROOT = join(DATA_ROOT, "banks");
const DRAFT_PATH = join(DATA_ROOT, "draft_packet.json");
const EXAMPLE_PATH = join(DATA_ROOT, "example_packet.json");
const PREVIEW_PATH = join(TEMPLATE_ROOT, "output", "pdf", "editor-preview.pdf");
const AUDIT_ROOT = join(DATA_ROOT, "render-audit");
const AUDIT_LAYOUT_PATH = join(AUDIT_ROOT, "layout-plan.json");
const PPTX_PREVIEW_PATH = join(TEMPLATE_ROOT, "output", "pptx", "editor-preview.pptx");
const PPTX_AUDIT_ROOT = join(DATA_ROOT, "pptx-renders");
const PPTX_BUILDER_PATH = join(TEMPLATE_ROOT, "build_editable_pptx.mjs");
const SAMPLE_PATH = join(TEMPLATE_ROOT, "sample_packet.json");
const PORT = Number(process.env.AOUNMED_PDF_EDITOR_PORT || 5178);

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...jsonHeaders, "Cache-Control": "no-store" },
  });
}

async function readPacket(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(path).text());
}

async function currentPacket(): Promise<Record<string, unknown>> {
  try {
    return await readPacket(DRAFT_PATH);
  } catch {
    return await readPacket(SAMPLE_PATH);
  }
}

type PacketDocument = Record<string, any>;

function packetDocument(packet: Record<string, unknown>): PacketDocument {
  return (packet.document && typeof packet.document === "object" ? packet.document : {}) as PacketDocument;
}

/**
 * Keep packets renderable when older editor sessions or imported Tutor exports
 * contain a choice-labelled question without choices.  We preserve the
 * question and its source wording, but move it into a single-column
 * open-response section instead of fabricating options or leaving an invalid
 * question inside an MCQ section.
 */
function sanitizePacket(packet: Record<string, unknown>): Record<string, unknown> {
  const document = packetDocument(packet);
  const lectures = Array.isArray(document.lectures) ? document.lectures : [];

  const addWarning = (question: PacketDocument, text: string): void => {
    if (!Array.isArray(question.notes)) question.notes = [];
    if (!question.notes.some((note: PacketDocument) => note?.kind === "warning" && String(note.text || "") === text)) {
      question.notes.push({ kind: "warning", text });
    }
  };

  for (const lecture of lectures) {
    if (!lecture || typeof lecture !== "object" || !Array.isArray(lecture.sections)) continue;
    const originalSections = [...lecture.sections];
    const usedSectionIds = new Set(originalSections.map((section: PacketDocument) => String(section?.id || "")));
    const normalizedSections: PacketDocument[] = [];

    for (const section of originalSections) {
      if (!section || typeof section !== "object" || !Array.isArray(section.questions)) {
        normalizedSections.push(section);
        continue;
      }

      const retained: PacketDocument[] = [];
      const openQuestions: PacketDocument[] = [];
      for (const question of section.questions) {
        if (!question || typeof question !== "object") {
          retained.push(question);
          continue;
        }
        question.options = Array.isArray(question.options) ? question.options : [];
        question.notes = Array.isArray(question.notes) ? question.notes : [];
        question.media = Array.isArray(question.media)
          ? question.media
          : typeof question.image === "string"
            ? [{ path: question.image, alt_text: question.caption || "", caption: question.caption || "" }]
            : [];
        question.lecture_refs = Array.isArray(question.lecture_refs) ? question.lecture_refs : [];

        const originalType = String(question.type || "");
        const declaredChoice = ["mcq", "multi_select"].includes(originalType);
        if (declaredChoice && (question.options.length < 2 || question.options.length > 6)) {
          question.type = "other";
          addWarning(
            question,
            `The source is labeled ${originalType.toUpperCase()} but has ${question.options.length} choice options; it was opened as an open response so the editor will not fabricate choices.`,
          );
        }

        if (question.type === "multi_select" && !Array.isArray(question.correct_answers)) {
          question.correct_answers = question.answer ? [question.answer] : [];
        }

        if (section.layout === "mcq_two_column" && !["mcq", "multi_select"].includes(String(question.type))) {
          addWarning(
            question,
            "This question was moved to an open-response section because an MCQ section only accepts questions with answer choices.",
          );
          openQuestions.push(question);
        } else {
          retained.push(question);
        }
      }

      section.questions = retained;
      if (retained.length > 0) normalizedSections.push(section);
      if (openQuestions.length > 0) {
        const baseId = `${String(section.id || "section")}-open-responses`;
        let sectionId = baseId;
        let suffix = 2;
        while (usedSectionIds.has(sectionId)) sectionId = `${baseId}-${suffix++}`;
        usedSectionIds.add(sectionId);
        normalizedSections.push({
          id: sectionId,
          title: `${String(section.title || "Questions")} — open responses`,
          layout: "seq_single_column",
          hints: [],
          questions: openQuestions,
        });
      }
    }
    lecture.sections = normalizedSections;
  }
  return packet;
}

/**
 * The first demo packet grouped three separate anatomy lectures under a
 * generic "Anatomy" lecture. Upgrade only that exact built-in shape. Saved
 * user banks are never passed through this migration.
 */
function upgradeExampleHierarchy(packet: Record<string, unknown>): { packet: Record<string, unknown>; changed: boolean } {
  const document = packetDocument(packet);
  const lectures = Array.isArray(document.lectures) ? document.lectures : [];
  const anatomyIndex = lectures.findIndex((lecture: PacketDocument) => lecture?.id === "lecture-anatomy");
  if (anatomyIndex < 0) return { packet, changed: false };
  const anatomy = lectures[anatomyIndex];
  const sourceSections = Array.isArray(anatomy?.sections) ? anatomy.sections : [];
  const expectedIds = ["anatomy-scalp-face", "neck-ospe", "tmj-seqs"];
  if (sourceSections.length !== expectedIds.length || !expectedIds.every((id, index) => sourceSections[index]?.id === id)) {
    return { packet, changed: false };
  }
  const lectureIds: Record<string, string> = {
    "anatomy-scalp-face": "lecture-scalp-face",
    "neck-ospe": "lecture-neck-ospe",
    "tmj-seqs": "lecture-tmj",
  };
  const sectionTitles: Record<string, string> = {
    "anatomy-scalp-face": "Review questions",
    "neck-ospe": "OSPE stations",
    "tmj-seqs": "Review questions",
  };
  const promoted = sourceSections.map((source: PacketDocument) => ({
    id: lectureIds[source.id],
    title: String(source.title || "Anatomy lecture"),
    description: `Questions grouped for ${String(source.title || "this anatomy lecture")}.`,
    sections: [{ ...source, title: sectionTitles[source.id] || "Questions" }],
  }));
  document.lectures = [...lectures.slice(0, anatomyIndex), ...promoted, ...lectures.slice(anatomyIndex + 1)];
  return { packet, changed: true };
}

function packetSummary(
  id: string,
  packet: Record<string, unknown>,
  kind: "example" | "reference" | "saved",
  updatedAt: string,
): Record<string, unknown> {
  const document = packetDocument(packet);
  const lectures = Array.isArray(document.lectures) ? document.lectures : [];
  const sections = lectures.flatMap((lecture: PacketDocument) => Array.isArray(lecture.sections) ? lecture.sections : []);
  const questions = sections.flatMap((section: PacketDocument) => Array.isArray(section.questions) ? section.questions : []);
  const media = questions.flatMap((question: PacketDocument) => Array.isArray(question.media)
    ? question.media
    : typeof question.image === "string" ? [{ path: question.image }] : []);
  const firstMedia = media.find((item: PacketDocument) => typeof item?.path === "string")?.path || null;
  return {
    id,
    kind,
    title: String(document.title || "Untitled bank"),
    week: String(document.week || "Not scheduled"),
    subtitle: String(document.subtitle || "Question bank"),
    description: lectures
      .map((lecture: PacketDocument) => String(lecture.description || "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" ") || "Organize questions into lectures, sections, and printable pages.",
    lecture_count: lectures.length,
    section_count: sections.length,
    question_count: questions.length,
    media_count: media.length,
    cover_image: firstMedia,
    updated_at: updatedAt,
  };
}

async function ensureBanksRoot(): Promise<void> {
  await mkdir(BANKS_ROOT, { recursive: true });
}

function bankFile(id: string): string | null {
  if (!/^bank-[a-f0-9-]+$/.test(id)) return null;
  return join(BANKS_ROOT, `${id}.json`);
}

async function readBank(id: string): Promise<Record<string, unknown> | null> {
  if (id === "example") return sanitizePacket(await ensureExamplePacket());
  if (id === "reference") return sanitizePacket(upgradeExampleHierarchy(await readPacket(SAMPLE_PATH)).packet);
  const path = bankFile(id);
  if (!path || !(await Bun.file(path).exists())) return null;
  return sanitizePacket(await readPacket(path));
}

async function writeBank(id: string, packet: Record<string, unknown>): Promise<void> {
  sanitizePacket(packet);
  if (id === "example") {
    await writeExample(packet);
    return;
  }
  const path = bankFile(id);
  if (!path) throw new Error("unknown bank");
  await ensureBanksRoot();
  await Bun.write(path, `${JSON.stringify(packet, null, 2)}\n`);
}

async function bankCatalog(): Promise<Record<string, unknown>[]> {
  await ensureBanksRoot();
  const example = await ensureExamplePacket();
  const catalog: Record<string, unknown>[] = [];
  const exampleStat = await stat(EXAMPLE_PATH);
  catalog.push(packetSummary("example", example, "example", exampleStat.mtime.toISOString()));
  let entries: string[] = [];
  try {
    entries = (await readdir(BANKS_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^bank-[a-f0-9-]+\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -5));
  } catch {
    entries = [];
  }
  for (const id of entries) {
    try {
      const packet = await readBank(id);
      if (!packet) continue;
      const fileStat = await stat(join(BANKS_ROOT, `${id}.json`));
      catalog.push(packetSummary(id, packet, "saved", fileStat.mtime.toISOString()));
    } catch {
      // One hand-edited or partially written bank should not hide the rest of
      // the local library. The editor can still import a corrected copy.
    }
  }
  return catalog;
}

function blankPacket(title: string, week: string, description: string): Record<string, unknown> {
  const lectureId = "lecture-1";
  const sectionId = "section-1";
  return {
    schema_version: "pdf-template-v1",
    document: {
      title: title || "New question bank",
      week: week || "WEEK 1",
      subtitle: "Editable question bank",
      output_name: `${(title || "question-bank").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
      lectures: [{
        id: lectureId,
        title: "First lecture",
        description: description || "Add a lecture description.",
        sections: [{
          id: sectionId,
          title: "Multiple-choice questions",
          layout: "mcq_two_column",
          hints: [],
          questions: [{
            id: "question-1",
            number: 1,
            type: "mcq",
            stem: "New question",
            options: [{ label: "A", text: "First option" }, { label: "B", text: "Second option" }],
            answer: "A",
            correct_answers: ["A"],
            notes: [],
            lecture_refs: [],
            media: [],
          }],
        }],
      }],
    },
  };
}

async function writeDraft(packet: Record<string, unknown>): Promise<void> {
  sanitizePacket(packet);
  await Bun.write(DRAFT_PATH, `${JSON.stringify(packet, null, 2)}\n`);
}

async function writeExample(packet: Record<string, unknown>): Promise<void> {
  sanitizePacket(packet);
  await Bun.write(EXAMPLE_PATH, `${JSON.stringify(packet, null, 2)}\n`);
  await writeDraft(packet);
}

async function ensureExamplePacket(): Promise<Record<string, unknown>> {
  if (await Bun.file(EXAMPLE_PATH).exists()) {
    const upgraded = upgradeExampleHierarchy(await readPacket(EXAMPLE_PATH));
    sanitizePacket(upgraded.packet);
    if (upgraded.changed) await Bun.write(EXAMPLE_PATH, `${JSON.stringify(upgraded.packet, null, 2)}\n`);
    return upgraded.packet;
  }
  const packet = upgradeExampleHierarchy(await currentPacket()).packet;
  await writeExample(packet);
  return packet;
}

function configuredExecutable(value: string): string {
  return value.includes("/") || value.includes("\\") ? resolveEditorPath(value) : value;
}

async function rendererCommand(): Promise<string[]> {
  const configured = [
    process.env.AOUNMED_PDF_EDITOR_PYTHON,
    process.env.AOUNMED_PDF_RENDER_PYTHON,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  for (const value of configured) {
    const executable = configuredExecutable(value);
    if (!executable.includes("/") || await Bun.file(executable).exists()) return [executable];
  }

  // Prefer the isolated project environment. This keeps the editor independent
  // from a user's global Python installation and avoids invoking uv for every
  // render when the local environment has already been prepared.
  const localPython = join(TEMPLATE_ROOT, ".venv", "bin", "python");
  if (await Bun.file(localPython).exists()) return [localPython];

  // The fallback is useful on a fresh checkout where the project environment
  // has not been created yet.
  return ["uv", "run", "--project", ".", "python"];
}

function contentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

function safePath(root: string, requested: string): string | null {
  const candidate = normalize(resolve(root, requested));
  const rootWithSeparator = root.endsWith("/") ? root : `${root}/`;
  if (candidate !== root && !candidate.startsWith(rootWithSeparator)) return null;
  return candidate;
}

async function staticFile(path: string, fallbackStatus = 404): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not found", { status: fallbackStatus });
  return new Response(file, {
    headers: {
      "Content-Type": contentType(path),
      "Cache-Control": path.endsWith("index.html") ? "no-store" : "public, max-age=60",
    },
  });
}

async function renderPreview(auditRoot = AUDIT_ROOT): Promise<{ ok: boolean; output: string; error?: string }> {
  const inputRelative = relative(TEMPLATE_ROOT, DRAFT_PATH);
  const outputRelative = relative(TEMPLATE_ROOT, PREVIEW_PATH);
  const auditRelative = relative(TEMPLATE_ROOT, auditRoot);
  const renderer = await rendererCommand();
  const process = Bun.spawn(
    [
      ...renderer,
      "render_template.py",
      inputRelative,
      "--output",
      outputRelative,
      "--audit-dir",
      auditRelative,
    ],
    {
      cwd: TEMPLATE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([process.stdout.text(), process.stderr.text()]);
  const exitCode = await process.exited;
  return {
    ok: exitCode === 0,
    output: stdout.trim(),
    error: exitCode === 0 ? undefined : stderr.trim() || stdout.trim() || `renderer exited ${exitCode}`,
  };
}

type ExportResult = { ok: boolean; output: string; error?: string };

let pptxExportInFlight: Promise<ExportResult> | null = null;

function resolveEditorPath(value: string): string {
  return resolve(EDITOR_ROOT, value);
}

function nodeBinary(): string {
  const configured = [
    process.env.AOUNMED_PPTX_NODE,
    process.env.AOUNMED_NODE_BIN,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  // Bun is already the editor runtime and resolves the dependencies installed
  // beside this server.  An explicit Node-compatible executable remains useful
  // for deployments that standardize on Node.
  const selected = configured[0] || process.execPath;
  // A relative executable path is interpreted from the editor directory, even
  // though the child builder runs from TEMPLATE_ROOT.
  return configuredExecutable(selected);
}

async function exportPptxPreview(): Promise<ExportResult> {
  // Refresh the deterministic renderer first so an edited packet cannot inherit
  // a stale page/frame plan. Pass this fresh audit artifact explicitly to the
  // PPTX builder; its output directory may contain a plan from another packet.
  const layoutResult = await renderPreview();
  if (!layoutResult.ok) {
    return {
      ok: false,
      output: layoutResult.output,
      error: `PPTX export preflight render failed: ${layoutResult.error || "unknown renderer error"}`,
    };
  }

  const inputRelative = relative(TEMPLATE_ROOT, DRAFT_PATH);
  const outputRelative = relative(TEMPLATE_ROOT, PPTX_PREVIEW_PATH);
  const qaRelative = relative(TEMPLATE_ROOT, PPTX_AUDIT_ROOT);
  const child = Bun.spawn(
    [
      nodeBinary(),
      PPTX_BUILDER_PATH,
      inputRelative,
      "--output",
      outputRelative,
      "--qa-dir",
      qaRelative,
      "--layout",
      AUDIT_LAYOUT_PATH,
    ],
    {
      cwd: TEMPLATE_ROOT,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([child.stdout.text(), child.stderr.text()]);
  const exitCode = await child.exited;
  return {
    ok: exitCode === 0,
    output: stdout.trim(),
    error: exitCode === 0 ? undefined : stderr.trim() || stdout.trim() || `PPTX builder exited ${exitCode}`,
  };
}

function exportPptx(): Promise<ExportResult> {
  if (!pptxExportInFlight) {
    pptxExportInFlight = exportPptxPreview().finally(() => {
      pptxExportInFlight = null;
    });
  }
  return pptxExportInFlight;
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/api/health") return json({ ok: true, app: "pdf-template-editor", port: PORT });

    if (path === "/api/banks" && request.method === "GET") {
      try {
        return json({ banks: await bankCatalog() });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not read bank catalog" }, 500);
      }
    }

    if (path === "/api/banks" && request.method === "POST") {
      try {
        const body = await request.json() as {
          title?: string;
          week?: string;
          description?: string;
          packet?: Record<string, unknown>;
        };
        const packet = body.packet || blankPacket(
          String(body.title || "New question bank"),
          String(body.week || "WEEK 1"),
          String(body.description || ""),
        );
        if (packet.schema_version !== "pdf-template-v1" || !packet.document) {
          return json({ error: "packet must contain schema_version pdf-template-v1 and document" }, 400);
        }
        const id = `bank-${crypto.randomUUID()}`;
        await writeBank(id, packet);
        return json({
          ok: true,
          bank: packetSummary(id, packet, "saved", new Date().toISOString()),
          packet,
        }, 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid bank JSON" }, 400);
      }
    }

    if (path.startsWith("/api/banks/") && request.method === "GET") {
      const id = path.slice("/api/banks/".length);
      if (!id || id.includes("/")) return json({ error: "invalid bank id" }, 400);
      try {
        const packet = await readBank(id);
        if (!packet) return json({ error: "bank not found" }, 404);
        const kind = id === "example" ? "example" : id === "reference" ? "reference" : "saved";
        const pathForBank = id === "example" ? EXAMPLE_PATH : bankFile(id);
        const updatedAt = id === "reference" || !pathForBank
          ? "reference"
          : (await stat(pathForBank)).mtime.toISOString();
        return json({ bank: packetSummary(id, packet, kind, updatedAt), packet });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not read bank" }, 500);
      }
    }

    if (path.startsWith("/api/banks/") && request.method === "PUT") {
      const id = path.slice("/api/banks/".length);
      if (!id || id.includes("/")) return json({ error: "invalid bank id" }, 400);
      if (id === "reference") return json({ error: "the reference packet is immutable" }, 403);
      try {
        const body = await request.json() as { packet?: Record<string, unknown> };
        const packet = body.packet;
        if (!packet || packet.schema_version !== "pdf-template-v1" || !packet.document) {
          return json({ error: "packet must contain schema_version pdf-template-v1 and document" }, 400);
        }
        await writeBank(id, packet);
        const kind = id === "example" ? "example" : "saved";
        return json({ ok: true, bank: packetSummary(id, packet, kind, new Date().toISOString()), packet });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "could not save bank" }, 400);
      }
    }

    if (path === "/api/packet" && request.method === "GET") {
      return json({ packet: await currentPacket(), draft_exists: await Bun.file(DRAFT_PATH).exists() });
    }

    if (path === "/api/packet" && request.method === "PUT") {
      try {
        const body = await request.json() as { packet?: Record<string, unknown> };
        const packet = body.packet;
        if (!packet || packet.schema_version !== "pdf-template-v1" || !packet.document) {
          return json({ error: "packet must contain schema_version pdf-template-v1 and document" }, 400);
        }
        await writeDraft(packet);
        return json({ ok: true, path: relative(TEMPLATE_ROOT, DRAFT_PATH), packet });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid JSON" }, 400);
      }
    }

    if (path === "/api/reset" && request.method === "POST") {
      const packet = upgradeExampleHierarchy(await readPacket(SAMPLE_PATH)).packet;
      await writeExample(packet);
      return json({ ok: true, packet });
    }

    if (path === "/api/render" && request.method === "POST") {
      try {
        const body = await request.json() as { packet?: Record<string, unknown> };
        if (!body.packet || body.packet.schema_version !== "pdf-template-v1") {
          return json({ error: "save a pdf-template-v1 packet before rendering" }, 400);
        }
        await writeDraft(body.packet);
        const result = await renderPreview();
        return json({ ...result, preview_url: result.ok ? "/api/preview.pdf" : undefined }, result.ok ? 200 : 422);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "render failed" }, 500);
      }
    }

    if (path === "/api/export-pptx" && request.method === "POST") {
      try {
        const body = await request.json() as { packet?: Record<string, unknown> };
        const packet = body.packet || await currentPacket();
        if (packet.schema_version !== "pdf-template-v1" || !packet.document) {
          return json({ error: "save a pdf-template-v1 packet before exporting PowerPoint" }, 400);
        }
        await writeDraft(packet);
        const result = await exportPptx();
        return json(
          {
            ...result,
            output: result.ok ? relative(TEMPLATE_ROOT, PPTX_PREVIEW_PATH) : undefined,
            download_url: result.ok ? "/api/editor.pptx" : undefined,
          },
          result.ok ? 200 : 422,
        );
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "PowerPoint export failed" }, 500);
      }
    }

    if (path === "/api/preview.pdf" && request.method === "GET") {
      return staticFile(PREVIEW_PATH);
    }

    if (path === "/api/editor.pptx" && request.method === "GET") {
      return staticFile(PPTX_PREVIEW_PATH);
    }

    if (path.startsWith("/assets/")) {
      const relativeAsset = path.slice("/assets/".length);
      const assetPath = safePath(join(TEMPLATE_ROOT, "assets"), relativeAsset);
      return assetPath ? staticFile(assetPath) : new Response("Forbidden", { status: 403 });
    }

    const requested = path === "/" ? "index.html" : path.slice(1);
    const filePath = safePath(PUBLIC_ROOT, requested);
    return filePath ? staticFile(filePath) : new Response("Forbidden", { status: 403 });
  },
});

console.log(`PDF question-bank editor listening at http://localhost:${server.port}`);

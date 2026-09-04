import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

type AssetInput = { key: string; path: string; content_type?: string };
type JobInput = {
  job_id: string;
  format: "pdf" | "pptx" | "both";
  callback_base: string;
  callback_token: string;
  packet: Record<string, unknown>;
  assets?: AssetInput[];
};

const PORT = Number(process.env.PORT || 8787);
const APP_ROOT = resolve(new URL("..", import.meta.url).pathname);
const PYTHON = process.env.PYTHON || "python3";
const BUN = process.env.BUN || process.execPath;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;

function safeFilename(value: unknown, fallback: string): string {
  const candidate = basename(String(value || ""));
  const cleaned = candidate.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return cleaned || fallback;
}

function callbackBase(input: JobInput): string {
  // Wrangler's local Worker is bound to the host loopback interface. Docker
  // containers cannot reach that interface via 127.0.0.1, so use Docker's
  // host gateway for local smoke/dev exports. Production workers.dev URLs are
  // left untouched.
  try {
    const url = new URL(input.callback_base);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") url.hostname = "host.docker.internal";
    return url.toString().replace(/\/$/, "");
  } catch {
    return input.callback_base.replace(/\/$/, "");
  }
}

function localPacket(input: JobInput): Record<string, unknown> {
  const packet = JSON.parse(JSON.stringify(input.packet)) as any;
  const paths = new Map((input.assets || []).map((asset) => [`r2://${asset.key}`, asset.path]));
  for (const lecture of packet?.document?.lectures || []) for (const section of lecture.sections || []) for (const question of section.questions || []) {
    for (const media of Array.isArray(question.media) ? question.media : []) {
      if (paths.has(String(media.path))) media.path = paths.get(String(media.path));
    }
    if (paths.has(String(question.image))) question.image = paths.get(String(question.image));
  }
  return packet;
}

function json(res: any, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_LOG_BYTES) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_LOG_BYTES) stderr += chunk.toString(); });
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    child.on("error", (error) => resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }));
  });
}

async function callback(input: JobInput, path: string, body: Uint8Array, contentType: string): Promise<void> {
  const response = await fetch(`${callbackBase(input)}/internal/export-output/${encodeURIComponent(input.job_id)}/${path}`, {
    method: "PUT",
    headers: { "content-type": contentType, "x-export-token": input.callback_token },
    body: body as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`callback ${path} failed with HTTP ${response.status}`);
}

async function runJobInDirectory(input: JobInput, jobRoot: string): Promise<Record<string, unknown>> {
  await mkdir(join(jobRoot, "editor"), { recursive: true });
  await mkdir(join(jobRoot, "assets"), { recursive: true });
  await mkdir(join(jobRoot, "output", "pdf"), { recursive: true });
  await mkdir(join(jobRoot, "output", "pptx"), { recursive: true });
  await mkdir(join(jobRoot, "render-audit"), { recursive: true });
  await writeFile(join(jobRoot, "input.json"), `${JSON.stringify(localPacket(input), null, 2)}\n`);
  await writeFile(join(jobRoot, "editor", "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(APP_ROOT, "editor", "node_modules"), join(jobRoot, "node_modules"), "dir").catch(() => undefined);
  await symlink(join(APP_ROOT, "editor", "node_modules"), join(jobRoot, "editor", "node_modules"), "dir").catch(() => undefined);
  await symlink(join(APP_ROOT, "assets", "fonts"), join(jobRoot, "assets", "fonts"), "dir").catch(() => undefined);
  // Media paths are validated after `resolve()` by the Python renderer. A
  // symlink would resolve outside the per-job root and be rejected as unsafe,
  // so copy the tiny built-in sample media into this isolated directory.
  await cp(join(APP_ROOT, "assets", "sample"), join(jobRoot, "assets", "sample"), { recursive: true }).catch(() => undefined);
  await symlink(join(APP_ROOT, "schema"), join(jobRoot, "schema"), "dir").catch(() => undefined);

  for (const asset of input.assets || []) {
    const target = resolve(jobRoot, asset.path);
    if (!target.startsWith(`${jobRoot}${"/"}`)) throw new Error("unsafe asset path");
    await mkdir(dirname(target), { recursive: true });
    const response = await fetch(`${callbackBase(input)}/internal/export-input/${encodeURIComponent(input.job_id)}/asset/${encodeURIComponent(asset.key)}`, {
      headers: { "x-export-token": input.callback_token },
    });
    if (!response.ok) throw new Error(`asset download failed with HTTP ${response.status}`);
    await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  }

  const renderEnv = { ...process.env, AOUNMED_RENDER_ROOT: jobRoot };
  const outputName = safeFilename((input.packet.document as any)?.output_name, "question-bank.pdf");
  const pdfPath = join(jobRoot, "output", "pdf", outputName.endsWith(".pdf") ? outputName : `${outputName}.pdf`);
  const render = await run(PYTHON, [join(APP_ROOT, "render_template.py"), join(jobRoot, "input.json"), "--output", pdfPath, "--audit-dir", join(jobRoot, "render-audit")], jobRoot, renderEnv);
  if (render.code !== 0) throw new Error(render.stderr.trim() || render.stdout.trim() || "PDF renderer failed");

  const result: Record<string, unknown> = { status: "completed" };
  if (input.format === "pdf" || input.format === "both") {
    await callback(input, "pdf", await readFile(pdfPath), "application/pdf");
    result.pdf = true;
  }
  if (input.format === "pptx" || input.format === "both") {
    const pptxPath = join(jobRoot, "output", "pptx", "question-bank-editable.pptx");
    const layoutPath = join(jobRoot, "render-audit", "layout-plan.json");
    const pptx = await run(BUN, [join(APP_ROOT, "build_editable_pptx.mjs"), join(jobRoot, "input.json"), "--output", pptxPath, "--qa-dir", join(jobRoot, "output", "pptx-renders"), "--layout", layoutPath], jobRoot, renderEnv);
    if (pptx.code !== 0) throw new Error(pptx.stderr.trim() || pptx.stdout.trim() || "PPTX builder failed");
    await callback(input, "pptx", await readFile(pptxPath), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    result.pptx = true;
  }
  try { await callback(input, "audit", await readFile(join(jobRoot, "render-audit", "manifest.json")), "application/json"); } catch { /* audit is useful but does not block an export */ }
  return result;
}

async function runJob(input: JobInput): Promise<Record<string, unknown>> {
  const jobRoot = join("/tmp", "quabanks-jobs", `${safeFilename(input.job_id, "job")}-${crypto.randomUUID()}`);
  try {
    return await runJobInDirectory(input, jobRoot);
  } finally {
    await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/jobs") return json(res, { error: "not found" }, 404);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  req.on("data", (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_REQUEST_BYTES) { tooLarge = true; return; }
    chunks.push(Buffer.from(chunk));
  });
  req.on("end", async () => {
    if (tooLarge) { json(res, { error: "job payload is too large" }, 413); return; }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JobInput;
      if (!input.job_id || !input.callback_base || !input.callback_token || !input.packet) throw new Error("invalid job payload");
      json(res, await runJob(input));
    } catch (error) {
      json(res, { status: "failed", error: error instanceof Error ? error.message : "container job failed" }, 422);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`QUABanks export container listening on ${PORT}`));

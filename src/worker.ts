import seedPacket from "../editor/data/example_packet.json";
import { Container, getRandom } from "@cloudflare/containers";

type Role = "admin" | "contributor";
type User = { id: string; display_name: string; role: Role };
type Packet = { schema_version: string; document: Record<string, any> };

interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  EXPORT_QUEUE: Queue;
  EXPORT_CONTAINER: DurableObjectNamespace<ExportContainer>;
  ASSETS: Fetcher;
  SITE_ACCESS_CODE?: string;
  SITE_ACCESS_DIGEST?: string;
  PIN_LOOKUP_SECRET: string;
  SESSION_SECRET: string;
  EXPORT_INTERNAL_TOKEN: string;
  AOUNMED_ADMIN_PIN?: string;
  INTERNAL_BASE_URL?: string;
  APP_NAME?: string;
}

type ExportMessage = { job_id: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_COOKIE = "quabanks_session";
const ACCESS_COOKIE = "quabanks_access";
const DAY_MS = 86_400_000;
const MAX_PIN_LENGTH = 8;
// A Queue delivery may be interrupted after the D1 claim.  Keep the claim
// recoverable without allowing a second container to render the same job at
// the same time.  The Queue consumer retries fresh running rows until this
// lease expires.
const EXPORT_LEASE_MS = 15 * 60_000;
// Keep the routing pool exactly aligned with wrangler's container capacity.
// Export job IDs must not be used as Container Durable Object IDs: doing so
// creates one live container per job and exhausts max_instances after two jobs.
const EXPORT_CONTAINER_POOL_SIZE = 2;
const EXPORT_MAX_ATTEMPTS = 3;

function now(): string { return new Date().toISOString(); }
function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
function error(message: string, status = 400): Response { return json({ error: message }, status); }
function text(value: unknown): string { return String(value ?? "").trim(); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function cookieHeader(name: string, value: string, maxAge: number, secure = true): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}
function requestIsSecure(request: Request): boolean { return new URL(request.url).protocol === "https:"; }
function cookies(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}
async function pinHash(pin: string, saltHex = randomHex(16)): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((value) => Number.parseInt(value, 16)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  // Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000
  // iterations. Keep the same explicit work factor in every environment so
  // locally-created and production sessions remain verifiable.
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" }, key, 256);
  return `${saltHex}$${[...new Uint8Array(bits)].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}
async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split("$");
  if (!salt || !expected) return false;
  const actual = (await pinHash(pin, salt)).split("$")[1] || "";
  return constantTimeEqual(actual, expected);
}
function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data);
  return [...data].map((item) => item.toString(16).padStart(2, "0")).join("");
}
async function signedAccess(secret: string, value = `${Date.now()}`): Promise<string> {
  return `${value}.${await hmac(value, secret)}`;
}
async function validAccess(value: string | undefined, env: Env): Promise<boolean> {
  if (!value) return false;
  const [stamp, signature] = value.split(".");
  if (!stamp || !signature || Date.now() - Number(stamp) > DAY_MS || Number.isNaN(Number(stamp))) return false;
  return constantTimeEqual(signature, await hmac(stamp, env.SESSION_SECRET));
}
async function siteAccessGranted(request: Request, env: Env): Promise<boolean> {
  return validAccess(cookies(request)[ACCESS_COOKIE], env);
}
function clientFingerprint(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
async function rateLimited(request: Request, env: Env, action: string): Promise<boolean> {
  const fingerprint = await hmac(`${action}:${clientFingerprint(request)}`, env.PIN_LOOKUP_SECRET);
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM access_attempts WHERE fingerprint = ? AND action = ? AND created_at >= ?")
    .bind(fingerprint, action, since).first<{ count: number }>();
  return Number(row?.count || 0) >= 30;
}
async function recordAttempt(request: Request, env: Env, action: string, succeeded: boolean): Promise<void> {
  const fingerprint = await hmac(`${action}:${clientFingerprint(request)}`, env.PIN_LOOKUP_SECRET);
  await env.DB.prepare("INSERT INTO access_attempts (fingerprint, action, succeeded, created_at) VALUES (?, ?, ?, ?)")
    .bind(fingerprint, action, succeeded ? 1 : 0, now()).run();
}

async function ensureAdmin(env: Env): Promise<User | null> {
  const existing = await env.DB.prepare("SELECT id, display_name, role FROM users WHERE id = 'admin'").first<User>();
  if (existing) return existing;
  if (!env.AOUNMED_ADMIN_PIN) return null;
  const hash = await pinHash(env.AOUNMED_ADMIN_PIN);
  const lookup = await hmac(`pin:${env.AOUNMED_ADMIN_PIN}`, env.PIN_LOOKUP_SECRET);
  const timestamp = now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, display_name, pin_lookup, pin_hash, role, created_at, updated_at) VALUES ('admin', 'Admin', ?, ?, 'admin', ?, ?)")
    .bind(lookup, hash, timestamp, timestamp).run();
  return await env.DB.prepare("SELECT id, display_name, role FROM users WHERE id = 'admin'").first<User>();
}
let seedPromise: Promise<void> | null = null;
async function ensureSeed(env: Env): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    await ensureAdmin(env);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM banks").first<{ count: number }>();
    if (Number(count?.count || 0) > 0) return;
    const admin = await env.DB.prepare("SELECT id FROM users WHERE id = 'admin'").first<{ id: string }>();
    if (!admin) return;
    await persistPacket(env, "example", clone(seedPacket as Packet), admin.id, "example", 1);
  })();
  try {
    await seedPromise;
  } catch (caught) {
    seedPromise = null;
    throw caught;
  }
}

async function currentUser(request: Request, env: Env): Promise<User | null> {
  if (!(await siteAccessGranted(request, env))) return null;
  const raw = cookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const tokenHash = await digest(`${env.SESSION_SECRET}:${raw}`);
  const user = await env.DB.prepare(`
    SELECT users.id, users.display_name, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ?
  `).bind(tokenHash, now()).first<User>();
  return user || null;
}
async function requireUser(request: Request, env: Env): Promise<User | Response> {
  if (!(await siteAccessGranted(request, env))) return error("site access code required", 401);
  const user = await currentUser(request, env);
  return user || error("personal PIN login required", 401);
}
async function createSession(user: User, env: Env): Promise<string> {
  const raw = `${crypto.randomUUID()}-${randomHex(24)}`;
  const tokenHash = await digest(`${env.SESSION_SECRET}:${raw}`);
  const timestamp = now();
  await env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), tokenHash, user.id, new Date(Date.now() + 30 * DAY_MS).toISOString(), timestamp).run();
  return raw;
}
function userPayload(user: User | null): Record<string, unknown> | null {
  return user ? { id: user.id, display_name: user.display_name, role: user.role } : null;
}

function packetDocument(packet: Packet): Record<string, any> { return packet.document && typeof packet.document === "object" ? packet.document : {}; }
function packetLectures(packet: Packet): any[] { return Array.isArray(packetDocument(packet).lectures) ? packetDocument(packet).lectures : []; }
function packetMeta(packet: Packet): Record<string, string> {
  const doc = packetDocument(packet);
  return { title: text(doc.title) || "Untitled bank", week: text(doc.week) || "WEEK 1", subtitle: text(doc.subtitle) || "Question bank", description: text(doc.description) };
}
function summarizePacket(id: string, packet: Packet, bank: any): Record<string, unknown> {
  const lectures = packetLectures(packet);
  const sections = lectures.flatMap((lecture) => Array.isArray(lecture.sections) ? lecture.sections : []);
  const questions = sections.flatMap((section) => Array.isArray(section.questions) ? section.questions : []);
  const media = questions.flatMap((question) => Array.isArray(question.media) ? question.media : question.image ? [{ path: question.image }] : []);
  const cover = media.find((item) => text(item?.path))?.path || null;
  return { id, kind: bank.kind, title: bank.title, week: bank.week, subtitle: bank.subtitle, description: bank.description, lecture_count: lectures.length, section_count: sections.length, question_count: questions.length, media_count: media.length, cover_image: cover, owner_id: bank.owner_id, revision: bank.revision, created_at: bank.created_at, updated_at: bank.updated_at };
}
function validatePacket(packet: unknown): packet is Packet {
  const candidate = packet as Packet;
  return Boolean(candidate && candidate.schema_version === "pdf-template-v1" && candidate.document && typeof candidate.document === "object");
}
function normalizeMediaPath(path: string): string { return path.replace(/^\.?\//, ""); }
function mediaR2Key(path: string): string | null {
  const value = text(path);
  return value.startsWith("r2://") ? value.slice(5).replace(/^\/+/, "") : null;
}
function collectR2Assets(packet: Packet): Array<{ key: string; path: string; content_type?: string }> {
  const assets: Array<{ key: string; path: string }> = [];
  for (const lecture of packetLectures(packet)) for (const section of lecture.sections || []) for (const question of section.questions || []) {
    const media = Array.isArray(question.media)
      ? question.media
      : text(question.image)
        ? [{ path: question.image }]
        : [];
    for (const item of media) {
      const key = mediaR2Key(item?.path);
      // Preserve the unique object key in the job directory.  A basename-only
      // destination would let two uploads named `image.png` overwrite one
      // another during the same export.
      if (key && !assets.some((asset) => asset.key === key)) assets.push({ key, path: `assets/r2/${key}` });
    }
  }
  return assets;
}
function basename(value: string): string { return value.split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "_") || "asset.bin"; }

async function persistPacket(env: Env, id: string, packet: Packet, ownerId: string, kind: "example" | "user", revision: number, newLectureOwnerId = ownerId): Promise<void> {
  const meta = packetMeta(packet);
  const timestamp = now();
  const lectures = packetLectures(packet);
  const bankStatements: D1PreparedStatement[] = [env.DB.prepare(`
    INSERT INTO banks (id, kind, title, week, subtitle, description, owner_id, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, week=excluded.week, subtitle=excluded.subtitle, description=excluded.description, revision=excluded.revision, updated_at=excluded.updated_at
  `).bind(id, kind, meta.title, meta.week, meta.subtitle, meta.description, ownerId, revision, timestamp, timestamp)];
  const existing = await env.DB.prepare("SELECT id, owner_id FROM lectures WHERE bank_id = ?").bind(id).all<{ id: string; owner_id: string }>();
  const incomingIds = new Set(lectures.map((lecture) => text(lecture.id)));
  const existingById = new Map((existing.results || []).map((row) => [row.id, row]));
  const changedLectureIds: string[] = [];
  for (let index = 0; index < lectures.length; index += 1) {
    const lecture = lectures[index];
    const lectureId = text(lecture.id) || crypto.randomUUID();
    lecture.id = lectureId;
    const prior = existingById.get(lectureId);
    const lectureOwner = prior?.owner_id || newLectureOwnerId;
    const lecturePayload = JSON.stringify(lecture);
    bankStatements.push(env.DB.prepare(`
      INSERT INTO lectures (id, bank_id, owner_id, position, title, description, payload_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET position=excluded.position, title=excluded.title, description=excluded.description, payload_json=excluded.payload_json, revision=lectures.revision + 1, updated_at=excluded.updated_at
    `).bind(lectureId, id, lectureOwner, index, text(lecture.title) || "Untitled lecture", text(lecture.description), lecturePayload, timestamp, timestamp));
    changedLectureIds.push(lectureId);
  }
  for (const row of existing.results || []) if (!incomingIds.has(row.id)) {
    bankStatements.push(env.DB.prepare("DELETE FROM lectures WHERE id = ?").bind(row.id));
  }
  await env.DB.batch(bankStatements);
  for (const lectureId of changedLectureIds) {
    const lecture = lectures.find((candidate) => text(candidate.id) === lectureId);
    if (!lecture) continue;
    const childStatements: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM sections WHERE lecture_id = ?").bind(lectureId)];
    for (let sectionIndex = 0; sectionIndex < (lecture.sections || []).length; sectionIndex += 1) {
      const section = lecture.sections[sectionIndex];
      const sectionId = text(section.id) || crypto.randomUUID(); section.id = sectionId;
      childStatements.push(env.DB.prepare("INSERT INTO sections (id, lecture_id, position, title, layout, payload_json) VALUES (?, ?, ?, ?, ?, ?)").bind(sectionId, lectureId, sectionIndex, text(section.title) || "Questions", text(section.layout) || "seq_single_column", JSON.stringify(section)));
      for (let questionIndex = 0; questionIndex < (section.questions || []).length; questionIndex += 1) {
        const question = section.questions[questionIndex];
        const questionId = text(question.id) || crypto.randomUUID(); question.id = questionId;
        childStatements.push(env.DB.prepare("INSERT INTO questions (id, section_id, position, number, type, stem, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(questionId, sectionId, questionIndex, Number(question.number) || questionIndex + 1, text(question.type) || "other", text(question.stem), JSON.stringify(question)));
      }
    }
    await env.DB.batch(childStatements);
  }
}
async function bankRow(env: Env, id: string): Promise<any | null> {
  return await env.DB.prepare("SELECT * FROM banks WHERE id = ?").bind(id).first<any>();
}
async function readPacket(env: Env, id: string): Promise<Packet | null> {
  const bank = await bankRow(env, id); if (!bank) return null;
  const lectureRows = await env.DB.prepare("SELECT payload_json FROM lectures WHERE bank_id = ? ORDER BY position ASC, id ASC").bind(id).all<{ payload_json: string }>();
  const packet: Packet = { schema_version: "pdf-template-v1", document: { title: bank.title, week: bank.week, subtitle: bank.subtitle, description: bank.description, lectures: (lectureRows.results || []).map((row) => parseJson(row.payload_json, {})) } };
  return packet;
}
function requestRevision(body: any, request: Request): number | null {
  const supplied = body?.revision ?? request.headers.get("if-match");
  if (supplied === undefined || supplied === null || text(supplied) === "") return null;
  const raw = text(supplied).replace(/^W\//, "").replace(/^"|"$/g, "");
  const revision = Number(raw);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

async function validatePacketAssets(env: Env, packet: Packet): Promise<string | null> {
  for (const asset of collectR2Assets(packet)) {
    const row = await env.DB.prepare("SELECT id FROM assets WHERE r2_key = ?").bind(asset.key).first<{ id: string }>();
    if (!row) return asset.key;
  }
  return null;
}

async function apiBanks(request: Request, env: Env, user: User): Promise<Response> {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM banks ORDER BY updated_at DESC, title ASC").all<any>();
    const banks: any[] = [];
    for (const bank of rows.results || []) {
      const packet = await readPacket(env, bank.id); if (packet) banks.push(summarizePacket(bank.id, packet, bank));
    }
    return json({ banks, user: userPayload(user) });
  }
  if (request.method !== "POST") return error("method not allowed", 405);
  const body = await request.json().catch(() => ({})) as any;
  const packet = validatePacket(body.packet) ? clone(body.packet) : blankPacket(text(body.title), text(body.week), text(body.description));
  const id = `bank-${crypto.randomUUID()}`;
  await persistPacket(env, id, packet, user.id, "user", 1);
  const bank = await bankRow(env, id);
  return json({ ok: true, bank: summarizePacket(id, packet, bank), packet }, 201);
}
function blankPacket(title: string, week: string, description: string): Packet {
  return { schema_version: "pdf-template-v1", document: { title: title || "New question bank", week: week || "WEEK 1", subtitle: "Editable question bank", description, output_name: `${(title || "question-bank").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`, lectures: [{ id: "lecture-1", title: "First lecture", description: description || "Add a lecture description.", sections: [{ id: "section-1", title: "Multiple-choice questions", layout: "mcq_two_column", hints: [], questions: [{ id: "question-1", number: 1, type: "mcq", stem: "New question", options: [{ label: "A", text: "First option" }, { label: "B", text: "Second option" }], answer: "A", correct_answers: ["A"], notes: [], lecture_refs: [], media: [] }] }] }] } };
}
async function apiBank(request: Request, env: Env, user: User, id: string): Promise<Response> {
  const bank = await bankRow(env, id); if (!bank) return error("bank not found", 404);
  if (request.method === "GET") { const packet = await readPacket(env, id); return packet ? json({ bank: summarizePacket(id, packet, bank), packet, user: userPayload(user) }) : error("bank not found", 404); }
  if (request.method === "DELETE") {
    if (user.role !== "admin") return error("only an admin may delete a bank", 403);
    // Export jobs reference their immutable snapshots. Remove the dependent
    // rows first so an admin can delete a bank even after it has been exported;
    // R2 snapshots/artifacts remain immutable recovery objects and can be
    // garbage-collected separately.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM export_jobs WHERE bank_id = ?").bind(id),
      env.DB.prepare("DELETE FROM packet_snapshots WHERE bank_id = ?").bind(id),
      env.DB.prepare("DELETE FROM banks WHERE id = ?").bind(id),
    ]);
    return json({ ok: true });
  }
  if (request.method !== "PUT") return error("method not allowed", 405);
  if (bank.kind === "example" && user.role !== "admin") return error("the built-in Example is admin-only", 403);
  const body = await request.json().catch(() => ({})) as any;
  if (!validatePacket(body.packet)) return error("packet must contain schema_version pdf-template-v1 and document", 400);
  const expectedRevision = requestRevision(body, request);
  if (expectedRevision === null) return error("revision is required for optimistic concurrency", 400);
  if (expectedRevision !== Number(bank.revision)) return json({ error: "bank changed since it was loaded", current_revision: bank.revision }, 409);
  const packet = clone(body.packet);
  const currentPacket = await readPacket(env, id);
  if (!currentPacket) return error("bank packet not found", 404);
  const existing = await env.DB.prepare("SELECT id, owner_id, payload_json FROM lectures WHERE bank_id = ?").bind(id).all<any>();
  const incomingById = new Map(packetLectures(packet).map((lecture) => [text(lecture.id), lecture]));
  if (user.role !== "admin" && bank.owner_id !== user.id && JSON.stringify(packetMeta(packet)) !== JSON.stringify(packetMeta(currentPacket))) {
    return error("only the bank owner or admin may change bank metadata", 403);
  }
  if (user.role !== "admin") {
    for (const row of existing.results || []) {
      const incoming = incomingById.get(row.id);
      if (!incoming) { if (row.owner_id === user.id) continue; return error("you cannot remove another contributor's lecture", 403); }
      if (row.owner_id !== user.id && JSON.stringify(parseJson(row.payload_json, {})) !== JSON.stringify(incoming)) return error("you cannot edit another contributor's lecture", 403);
    }
  }
  await persistPacket(env, id, packet, bank.owner_id, bank.kind, Number(bank.revision) + 1, user.id);
  const updated = await bankRow(env, id);
  return json({ ok: true, bank: summarizePacket(id, packet, updated), packet, revision: updated.revision });
}

async function apiLectures(request: Request, env: Env, user: User, bankId: string, lectureId?: string): Promise<Response> {
  const bank = await bankRow(env, bankId); if (!bank) return error("bank not found", 404);
  const packet = await readPacket(env, bankId); if (!packet) return error("bank packet not found", 404);
  const currentRows = await env.DB.prepare("SELECT id, owner_id, position, revision, payload_json FROM lectures WHERE bank_id = ? ORDER BY position ASC, id ASC").bind(bankId).all<any>();
  if (!lectureId && request.method === "GET") {
    return json({ lectures: (currentRows.results || []).map((row) => ({ id: row.id, owner_id: row.owner_id, position: row.position, revision: row.revision, lecture: parseJson(row.payload_json, {}) })) });
  }
  if (!lectureId && request.method === "POST") {
    if (bank.kind === "example" && user.role !== "admin") return error("the built-in Example is admin-only", 403);
    const body = await request.json().catch(() => ({})) as any;
    const expectedBankRevision = requestRevision(body, request);
    if (expectedBankRevision === null) return error("bank revision is required", 400);
    if (expectedBankRevision !== Number(bank.revision)) return json({ error: "bank changed since it was loaded", current_revision: bank.revision }, 409);
    const sourceLecture = body?.lecture && typeof body.lecture === "object" ? body.lecture : body;
    const lecture = sourceLecture && typeof sourceLecture === "object" ? clone(sourceLecture) : null;
    if (!lecture || typeof lecture !== "object" || !text(lecture.title)) return error("lecture.title is required", 400);
    lecture.id = text(lecture.id) || crypto.randomUUID();
    lecture.sections = Array.isArray(lecture.sections) && lecture.sections.length ? lecture.sections : [{ id: crypto.randomUUID(), title: "Questions", layout: "seq_single_column", hints: [], questions: [] }];
    packetLectures(packet).push(lecture);
    await persistPacket(env, bankId, packet, bank.owner_id, bank.kind, Number(bank.revision) + 1, user.id);
    const updated = await bankRow(env, bankId);
    return json({ ok: true, bank: summarizePacket(bankId, packet, updated), lecture, revision: updated.revision }, 201);
  }
  if (!lectureId) return error("lecture id is required", 400);
  const row = (currentRows.results || []).find((candidate) => candidate.id === lectureId);
  if (!row) return error("lecture not found", 404);
  if (request.method === "GET") return json({ lecture: parseJson(row.payload_json, {}), owner_id: row.owner_id, position: row.position, revision: row.revision, bank_revision: bank.revision });
  if (user.role !== "admin" && row.owner_id !== user.id) return error("you can only edit your own lecture", 403);
  const body = await request.json().catch(() => ({})) as any;
  const expectedLectureRevision = requestRevision(body, request);
  const expectedBankRevision = body.bank_revision === undefined ? null : Number(body.bank_revision);
  if (expectedLectureRevision === null) return error("lecture revision is required", 400);
  if (expectedLectureRevision !== Number(row.revision)) return json({ error: "lecture changed since it was loaded", current_revision: row.revision }, 409);
  if (expectedBankRevision === null || !Number.isInteger(expectedBankRevision)) return error("bank revision is required", 400);
  if (expectedBankRevision !== Number(bank.revision)) return json({ error: "bank changed since it was loaded", current_revision: bank.revision }, 409);
  if (request.method === "DELETE") {
    const remaining = packetLectures(packet).filter((lecture) => text(lecture.id) !== lectureId);
    if (!remaining.length) return error("a bank must keep at least one lecture", 400);
    packet.document.lectures = remaining;
    await persistPacket(env, bankId, packet, bank.owner_id, bank.kind, Number(bank.revision) + 1, user.id);
    return json({ ok: true, revision: Number(bank.revision) + 1 });
  }
  if (request.method !== "PUT") return error("method not allowed", 405);
  const lecture = body?.lecture && typeof body.lecture === "object" ? clone(body.lecture) : null;
  if (!lecture || typeof lecture !== "object" || !text(lecture.title)) return error("lecture.title is required", 400);
  lecture.id = lectureId;
  const index = packetLectures(packet).findIndex((candidate) => text(candidate.id) === lectureId);
  packet.document.lectures[index] = lecture;
  await persistPacket(env, bankId, packet, bank.owner_id, bank.kind, Number(bank.revision) + 1, user.id);
  const updated = await bankRow(env, bankId);
  return json({ ok: true, lecture, bank_revision: updated.revision, revision: Number(row.revision) + 1 });
}

async function apiAccess(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return error("method not allowed", 405);
  if (await rateLimited(request, env, "site_access")) return error("too many attempts; try again later", 429);
  const body = await request.json().catch(() => ({})) as any;
  const supplied = text(body.code);
  const expected = text(env.SITE_ACCESS_CODE);
  const ok = Boolean(supplied && expected && constantTimeEqual(supplied, expected));
  await recordAttempt(request, env, "site_access", ok);
  if (!ok) return error("invalid site access code", 401);
  const header = cookieHeader(ACCESS_COOKIE, await signedAccess(env.SESSION_SECRET), 86_400, requestIsSecure(request));
  return json({ ok: true }, 200, { "set-cookie": header });
}
async function apiAuth(request: Request, env: Env, action: string): Promise<Response> {
  if (!(await siteAccessGranted(request, env))) return error("site access code required", 401);
  if (action === "logout") {
    const raw = cookies(request)[SESSION_COOKIE];
    if (raw) await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").bind(now(), await digest(`${env.SESSION_SECRET}:${raw}`)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader(SESSION_COOKIE, "", 0, requestIsSecure(request)) });
  }
  if (await rateLimited(request, env, `pin_${action}`)) return error("too many attempts; try again later", 429);
  const body = await request.json().catch(() => ({})) as any;
  const pin = text(body.pin);
  if (!/^\d{4,8}$/.test(pin) || pin.length > MAX_PIN_LENGTH) { await recordAttempt(request, env, `pin_${action}`, false); return error("PIN must be 4–8 digits", 400); }
  let user: User | null = null;
  if (action === "register") {
    const displayName = text(body.display_name);
    if (displayName.length < 2 || displayName.length > 60) return error("display name must be 2–60 characters", 400);
    const lookup = await hmac(`pin:${pin}`, env.PIN_LOOKUP_SECRET);
    const conflict = await env.DB.prepare("SELECT id FROM users WHERE pin_lookup = ?").bind(lookup).first();
    if (conflict) return error("that PIN is already in use; choose another", 409);
    const id = `user-${crypto.randomUUID()}`;
    const timestamp = now();
    await env.DB.prepare("INSERT INTO users (id, display_name, pin_lookup, pin_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'contributor', ?, ?)")
      .bind(id, displayName, lookup, await pinHash(pin), timestamp, timestamp).run();
    user = { id, display_name: displayName, role: "contributor" };
  } else {
    const lookup = await hmac(`pin:${pin}`, env.PIN_LOOKUP_SECRET);
    const row = await env.DB.prepare("SELECT id, display_name, role, pin_hash FROM users WHERE pin_lookup = ?").bind(lookup).first<any>();
    if (row && await verifyPin(pin, row.pin_hash)) user = { id: row.id, display_name: row.display_name, role: row.role };
  }
  const ok = Boolean(user); await recordAttempt(request, env, `pin_${action}`, ok);
  if (!user) return error("invalid PIN", 401);
  const session = await createSession(user, env);
  return json({ ok: true, user: userPayload(user) }, 200, { "set-cookie": cookieHeader(SESSION_COOKIE, session, 30 * 86_400, requestIsSecure(request)) });
}

async function createExport(request: Request, env: Env, user: User, format: "pdf" | "pptx" | "both"): Promise<Response> {
  const body = await request.json().catch(() => ({})) as any;
  const bankId = text(body.bank_id);
  const bank = await bankRow(env, bankId); if (!bank) return error("bank not found", 404);
  const suppliedRevision = body.revision === undefined || body.revision === null ? null : Number(body.revision);
  if (suppliedRevision === null || !Number.isInteger(suppliedRevision)) return error("revision is required for export", 400);
  if (suppliedRevision !== Number(bank.revision)) return json({ error: "bank changed since it was loaded", current_revision: bank.revision }, 409);
  // The D1 packet is authoritative.  The browser still sends its packet for
  // compatibility with the standalone editor, but accepting it here would let
  // a caller export content that was never saved at the claimed revision.
  const packet = await readPacket(env, bankId);
  if (!packet) return error("bank packet not found", 404);
  const missingAsset = await validatePacketAssets(env, packet);
  if (missingAsset) return error(`media asset is not registered: ${missingAsset}`, 400);
  const jobId = crypto.randomUUID();
  const snapshotKey = `snapshots/${jobId}.json`;
  const snapshot = { job_id: jobId, bank_id: bankId, format, packet, assets: collectR2Assets(packet), created_at: now() };
  await env.MEDIA.put(snapshotKey, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO packet_snapshots (id, bank_id, created_by, revision, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(jobId, bankId, user.id, bank.revision, snapshotKey, now()),
    env.DB.prepare("INSERT INTO export_jobs (id, bank_id, snapshot_id, requested_by, format, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)").bind(jobId, bankId, jobId, user.id, format, now(), now()),
  ]);
  try {
    await env.EXPORT_QUEUE.send({ job_id: jobId } satisfies ExportMessage);
    console.log({ event: "export_queued", job_id: jobId, bank_id: bankId, format });
  } catch (caught) {
    const messageText = caught instanceof Error ? caught.message : "could not enqueue export";
    await env.DB.prepare("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(messageText.slice(0, 1000), now(), jobId).run();
    return error("could not queue export", 503);
  }
  return json({ ok: true, job: { id: jobId, status: "queued", format }, status_url: `/api/exports/${jobId}` }, 202);
}
async function apiExportStatus(request: Request, env: Env, user: User, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM export_jobs WHERE id = ?").bind(id).first<any>();
  if (!row) return error("export job not found", 404);
  const links: Record<string, string> = {};
  if (row.pdf_key) links.pdf = `/api/artifacts/${encodeURIComponent(id)}/pdf`;
  if (row.pptx_key) links.pptx = `/api/artifacts/${encodeURIComponent(id)}/pptx`;
  return json({ job: { id: row.id, bank_id: row.bank_id, format: row.format, status: row.status, attempts: row.attempts, error: row.error, created_at: row.created_at, updated_at: row.updated_at, downloads: links }, user: userPayload(user) });
}
async function retryExport(request: Request, env: Env, user: User, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM export_jobs WHERE id = ?").bind(id).first<any>();
  if (!row) return error("export job not found", 404);
  if (user.role !== "admin" && row.requested_by !== user.id) return error("you can only retry your own exports", 403);
  if (row.status !== "failed") return error("only failed exports can be retried", 409);
  const reset = await env.DB.prepare("UPDATE export_jobs SET status = 'queued', attempts = 0, error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'").bind(now(), id).run();
  if (!Number(reset.meta?.changes || 0)) return error("export is already being retried", 409);
  try {
    await env.EXPORT_QUEUE.send({ job_id: id } satisfies ExportMessage);
  } catch (caught) {
    const messageText = caught instanceof Error ? caught.message : "could not enqueue export retry";
    await env.DB.prepare("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(messageText.slice(0, 1000), now(), id).run();
    return error("could not queue export retry", 503);
  }
  return json({ ok: true, status_url: `/api/exports/${id}` }, 202);
}
async function apiArtifact(request: Request, env: Env, user: User, id: string, format: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT pdf_key, pptx_key FROM export_jobs WHERE id = ?").bind(id).first<any>();
  if (!row) return error("export job not found", 404);
  const key = format === "pdf" ? row.pdf_key : format === "pptx" ? row.pptx_key : null;
  if (!key) return error("artifact is not ready", 404);
  const object = await env.MEDIA.get(key); if (!object) return error("artifact is missing", 404);
  const contentType = format === "pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return new Response(object.body, { headers: {
    "content-type": contentType,
    "content-length": String(object.size),
    "content-disposition": `attachment; filename="${id}.${format}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}
async function internalInput(request: Request, env: Env, id: string): Promise<Response> {
  if (request.headers.get("x-export-token") !== env.EXPORT_INTERNAL_TOKEN) return error("forbidden", 403);
  const object = await env.MEDIA.get(`snapshots/${id}.json`); if (!object) return error("snapshot missing", 404);
  return new Response(object.body, { headers: { "content-type": "application/json" } });
}
async function internalAsset(request: Request, env: Env, key: string): Promise<Response> {
  if (request.headers.get("x-export-token") !== env.EXPORT_INTERNAL_TOKEN) return error("forbidden", 403);
  const object = await env.MEDIA.get(key); if (!object) return error("asset missing", 404);
  return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream" } });
}

async function authorizedAsset(request: Request, env: Env, key: string): Promise<Response> {
  const object = await env.MEDIA.get(key);
  if (object) return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream", "cache-control": "private, max-age=300" } });
  // Seed media is shipped as a static asset so local/deployed installs work
  // before an administrator uploads the same file into private R2 storage.
  const fallback = await env.ASSETS.fetch(new Request(new URL(`/assets/${key}`, request.url), request));
  if (!fallback.ok || (fallback.headers.get("content-type") || "").includes("text/html")) return error("asset not found", 404);
  return fallback;
}
async function internalOutput(request: Request, env: Env, id: string, format: string): Promise<Response> {
  if (request.headers.get("x-export-token") !== env.EXPORT_INTERNAL_TOKEN) return error("forbidden", 403);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  const key = `artifacts/${id}.${format}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
  const column = format === "pdf" ? "pdf_key" : format === "pptx" ? "pptx_key" : format === "audit" ? "audit_key" : null;
  if (!column) return error("invalid artifact format", 400);
  await env.DB.prepare(`UPDATE export_jobs SET ${column} = ?, updated_at = ? WHERE id = ?`).bind(key, now(), id).run();
  return json({ ok: true, key });
}

async function processExport(message: ExportMessage, env: Env): Promise<"ack" | "retry"> {
  const row = await env.DB.prepare("SELECT * FROM export_jobs WHERE id = ?").bind(message.job_id).first<any>();
  if (!row || row.status === "completed") return "ack";
  const runningAt = Date.parse(String(row.updated_at || ""));
  const staleRunning = row.status === "running" && (!Number.isFinite(runningAt) || Date.now() - runningAt >= EXPORT_LEASE_MS);
  // A duplicate Queue delivery while another container is still rendering is
  // kept alive.  If the original invocation died, the same delivery will be
  // eligible once the D1 lease expires.
  if (row.status === "running" && !staleRunning) return "retry";
  const leaseCutoff = new Date(Date.now() - EXPORT_LEASE_MS).toISOString();
  const claim = await env.DB.prepare(`
    UPDATE export_jobs
    SET status = 'running', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND (status IN ('queued', 'failed') OR (status = 'running' AND updated_at <= ?))
  `).bind(now(), row.id, leaseCutoff).run();
  if (!Number(claim.meta?.changes || 0)) return "ack";
  const attempt = Number(row.attempts || 0) + 1;
  console.log({ event: "export_started", job_id: row.id, format: row.format, attempt });
  try {
    if (!env.INTERNAL_BASE_URL) throw new Error("INTERNAL_BASE_URL is not configured");
    const container = await getRandom(env.EXPORT_CONTAINER, EXPORT_CONTAINER_POOL_SIZE);
    const snapshot = await env.MEDIA.get(`snapshots/${row.id}.json`);
    if (!snapshot) throw new Error("snapshot missing");
    const input = await snapshot.json<any>();
    const response = await container.fetch("http://export-container/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, callback_base: env.INTERNAL_BASE_URL, callback_token: env.EXPORT_INTERNAL_TOKEN }) });
    const responseText = await response.text();
    const result = parseJson<any>(responseText, {});
    if (!response.ok || result.status !== "completed") {
      const detail = text(result.error) || text(responseText).slice(0, 1000) || `container returned HTTP ${response.status}`;
      throw new Error(`container returned HTTP ${response.status}: ${detail}`);
    }
    await env.DB.prepare("UPDATE export_jobs SET status = 'completed', updated_at = ?, error = NULL WHERE id = ?").bind(now(), row.id).run();
    console.log({ event: "export_completed", job_id: row.id, format: row.format, attempt });
  } catch (caught) {
    const messageText = caught instanceof Error ? caught.message : "export failed";
    // Renderer/container/network failures are normally transient.  Let the
    // Queue redeliver a bounded number of times, while keeping deterministic
    // input errors terminal so a bad packet does not spin forever.
    const permanent = /snapshot missing|invalid job payload|unsafe asset path|asset download failed|renderer failed|invalid packet|not configured/i.test(messageText);
    if (!permanent && attempt < EXPORT_MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE export_jobs SET status = 'queued', error = ?, updated_at = ? WHERE id = ?").bind(messageText.slice(0, 1000), now(), row.id).run();
      console.warn({ event: "export_retry_scheduled", job_id: row.id, format: row.format, attempt, error: messageText.slice(0, 1000) });
      throw caught;
    }
    await env.DB.prepare("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(messageText.slice(0, 1000), now(), row.id).run();
    console.error({ event: "export_failed", job_id: row.id, format: row.format, attempt, permanent, error: messageText.slice(0, 1000) });
  }
  return "ack";
}

export class ExportContainer extends Container {
  defaultPort = 8787;
  sleepAfter = "10m";

  override onStart(): void {
    console.log({ event: "export_container_started", container_id: this.ctx.id.toString() });
  }

  override onStop(params: { exitCode: number; reason: "exit" | "runtime_signal" }): void {
    console.log({ event: "export_container_stopped", container_id: this.ctx.id.toString(), ...params });
  }

  override onError(caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error({ event: "export_container_error", container_id: this.ctx.id.toString(), error: message });
  }
}

function isStatic(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return request.method === "GET" && !pathname.startsWith("/api/") && !pathname.startsWith("/internal/") && !pathname.startsWith("/assets/");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path === "/api/health") return json({ ok: true, app: env.APP_NAME || "QUABanks" });
    if (path === "/api/access/unlock") return apiAccess(request, env);
    if (path === "/api/auth/register") return apiAuth(request, env, "register");
    if (path === "/api/auth/login") return apiAuth(request, env, "login");
    if (path === "/api/auth/logout") return apiAuth(request, env, "logout");
    // Public static files must remain reachable before either personal auth or
    // seed initialization; private R2 media is handled below after auth.
    if (isStatic(request)) return env.ASSETS.fetch(request);
    await ensureSeed(env);
    if (path === "/api/session" && request.method === "GET") return json({ access_granted: await siteAccessGranted(request, env), user: userPayload(await currentUser(request, env)) });
    if (path.startsWith("/internal/export-input/") && request.method === "GET") {
      const parts = path.split("/"); const id = parts[3];
      if (parts[4] === "asset") return internalAsset(request, env, parts.slice(5).join("/"));
      return internalInput(request, env, id);
    }
    if (path.startsWith("/internal/export-output/") && request.method === "PUT") {
      const parts = path.split("/"); return internalOutput(request, env, parts[3], parts[4]);
    }
    const userResult = await requireUser(request, env);
    if (userResult instanceof Response) return userResult;
    const user = userResult;
    if (path === "/api/banks") return apiBanks(request, env, user);
    const lectureRoute = path.match(/^\/api\/banks\/([^/]+)\/lectures(?:\/([^/]+))?$/);
    if (lectureRoute) return apiLectures(request, env, user, lectureRoute[1], lectureRoute[2]);
    if (path.startsWith("/api/banks/")) return apiBank(request, env, user, path.slice("/api/banks/".length));
    if ((path === "/api/render" || path === "/api/export-pptx") && request.method === "POST") return createExport(request, env, user, path === "/api/render" ? "pdf" : "pptx");
    if (path === "/api/exports" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as any;
      return createExport(new Request(request, { body: JSON.stringify(body) }), env, user, ["pdf", "pptx", "both"].includes(body.format) ? body.format : "both");
    }
    if (path.startsWith("/api/exports/") && request.method === "POST" && path.endsWith("/retry")) {
      return retryExport(request, env, user, path.slice("/api/exports/".length, -"/retry".length));
    }
    if (path.startsWith("/api/exports/") && request.method === "GET") return apiExportStatus(request, env, user, path.slice("/api/exports/".length));
    if (path.startsWith("/api/artifacts/") && request.method === "GET") { const parts = path.split("/"); return apiArtifact(request, env, user, parts[3], parts[4]); }
    if (path === "/api/assets" && request.method === "POST") {
      const form = await request.formData(); const file = form.get("file");
      if (!(file instanceof File)) return error("multipart field 'file' is required", 400);
      if (file.size > 100 * 1024 * 1024) return error("file is larger than 100 MiB", 413);
      const assetId = crypto.randomUUID(); const key = `assets/${assetId}-${basename(file.name)}`;
      await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
      await env.DB.prepare("INSERT INTO assets (id, owner_id, r2_key, filename, content_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(assetId, user.id, key, file.name, file.type || "application/octet-stream", file.size, now()).run();
      return json({ ok: true, asset: { id: assetId, path: `r2://${key}`, filename: file.name, content_type: file.type, byte_size: file.size } }, 201);
    }
    if (path.startsWith("/assets/") && request.method === "GET") {
      const key = path.slice("/assets/".length);
      return authorizedAsset(request, env, key);
    }
    return error("not found", 404);
  },
  async queue(batch: MessageBatch<ExportMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const disposition = await processExport(message.body, env);
        if (disposition === "retry") message.retry({ delaySeconds: 30 });
        else message.ack();
      } catch {
        // The job row is put back in `queued` by processExport.  Queue retry
        // preserves the durable checkpoint without resubmitting completed
        // artifacts or making a second concurrent container call.
        message.retry({ delaySeconds: Math.min(60, Math.max(2, 2 ** Math.max(0, message.attempts - 1))) });
      }
    }
  },
};

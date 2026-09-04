import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
const parseJsonc = (value) => JSON.parse(value.replace(/,\s*([}\]])/g, "$1"));

test("Cloudflare bindings and export boundaries stay declared", async () => {
  const config = parseJsonc(await read("wrangler.jsonc"));
  assert.equal(config.main, "src/worker.ts");
  assert.equal(config.assets.binding, "ASSETS");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.r2_buckets[0].binding, "MEDIA");
  assert.equal(config.queues.producers[0].binding, "EXPORT_QUEUE");
  assert.equal(config.durable_objects.bindings[0].class_name, "ExportContainer");
  assert.equal(config.containers[0].max_instances, 2);
  assert.equal(config.containers[0].instance_type, "basic");
  assert.equal(config.queues.consumers[0].max_concurrency, 2);
  const worker = await read("src/worker.ts");
  assert.match(worker, /getRandom\(env\.EXPORT_CONTAINER, EXPORT_CONTAINER_POOL_SIZE\)/);
  assert.doesNotMatch(worker, /idFromName\(row\.id\)/);
});

test("the preserved Example packet has stable nested lecture content", async () => {
  const packet = JSON.parse(await read("editor/data/example_packet.json"));
  assert.equal(packet.schema_version, "pdf-template-v1");
  assert.ok(Array.isArray(packet.document.lectures));
  assert.ok(packet.document.lectures.length > 0);
  const questionIds = new Set();
  for (const lecture of packet.document.lectures) for (const section of lecture.sections || []) for (const question of section.questions || []) {
    assert.ok(question.id);
    assert.equal(questionIds.has(question.id), false, `duplicate question ${question.id}`);
    questionIds.add(question.id);
  }
});

test("D1 migration contains the durable export and ownership tables", async () => {
  const migration = await read("migrations/0001_initial.sql");
  for (const table of ["users", "sessions", "banks", "lectures", "sections", "questions", "assets", "packet_snapshots", "export_jobs"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /revision INTEGER NOT NULL/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'queued'/);
});

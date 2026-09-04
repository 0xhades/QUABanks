# PDF template experiment progress

## Editable companion and navigation

- [x] Add named section destinations and clickable contents links to the PDF.
- [x] Generate an A4 portrait editable PPTX companion from the same sample packet.
- [x] Keep PPTX text, panels, questions, options, notes, answers, images, and closing copy as native
  editable objects.
- [x] Render and inspect every PPTX slide and verify PDF link metadata and PPTX structure.
- [x] Verify four PPTX contents links target the first slides of the four sections and that the OSPE
  image is embedded as a replaceable media object.

## Expanded normalized content contract

- [x] Treat `Neck - revised.pdf` only as a Tutor-output content-shape reference, not a design
  template; preserve the Week 1 visual language.
- [x] Add structured lecture-slide references and bank-source provenance.
- [x] Add optional notes and Tutor explanations under questions.
- [x] Add `mcq`, `multi_select`, `seq`, `ospe`, `other`, and `explain_why` content shapes.
- [x] Add structured question media with alt text/captions and verify an OSPE image renders.
- [x] Add per-lecture hint appendices that are omitted when the lecture has no hints.
- [x] Keep `sample_packet.json` as the common normalized end product for future Tutor or human
  input paths without implementing either ingestion path here.
- [x] Regenerate and visually inspect the expanded seven-page PDF; verify four contents links and
  four outline destinations with `pypdf`.

## Typography and closing-page revision

- [x] Embedded Work Sans for questions, options, answers, and body copy.
- [x] Embedded Fredoka for playful cover and section titles.
- [x] Added the source-inspired Arabic closing page as a versioned template page,
  including deterministic logical-line wrapping and right-to-left shaping.
- [x] Regenerated the expanded seven-page PDF and visually verified every page at 144 DPI.

- [x] Visually inspected all 20 pages of the supplied `Week 1.pdf`.
- [x] Identified the cover, MCQ, SEQ, case, media, explanation, answer-key, and footer patterns.
- [x] Defined a versioned Tutor-to-renderer JSON boundary.
- [x] Added semantic validation and deterministic pagination.
- [x] Added the Week 1 visual renderer and sample packet.
- [x] Rendered and visually verified all seven generated pages at 144 DPI; no clipping,
  overlap, broken glyphs, or unbalanced MCQ columns were found in the final output.
- [x] Verified the generated PDF reopens as A4/7 pages, contains 15 questions, and
  matches the deterministic layout plan.

## Final artifacts

- PDF: `output/pdf/week1-template-demo.pdf`
- Tutor payload example: `sample_packet.json`
- Versioned contract: `schema/pdf-template-v1.schema.json`
- Deterministic renderer: `render_template.py`
- Editable PPTX builder: `build_editable_pptx.mjs`
- Editable copy: `output/pptx/week1-template-editable.pptx`
- Audit outputs: `output/layout-plan.json` and `output/manifest.json`

## Question-bank editor PoC

- [x] Add a self-contained Bun editor under `editor/` without touching the AounMED app.
- [x] Load the real normalized sample packet and keep edits in a separate draft file.
- [x] Expose section/question navigation and editable provenance, notes, answers, hints, and media.
- [x] Add an editor-style live paper preview and JSON export/import.
- [x] Connect Save/Render actions to the existing deterministic Python PDF renderer.
- [x] Add a **Save as PPTX** editor action that writes the same draft through the existing
  editable PowerPoint builder, with an isolated audit directory and download endpoint.
- [x] Verify the editor with a local smoke check and document its startup commands.

Smoke evidence (2026-09-02): Bun bundled both browser and server entry points; the local API
returned a healthy response and four-section sample packet; a sample render produced a seven-page,
15-question PDF; a draft title round-tripped through `PUT /api/packet`; and `POST /api/reset`
restored the untouched sample. The smoke server used port 5187 because the default editor port was
already reserved on the host. Browser smoke also verified an OSPE image preview, adding a new
lecture/question, and restoring the sample without client errors. The PPTX endpoint then generated
`output/pptx/editor-preview.pptx`; the package passed `unzip -tq`, and the download route returned
the correct PowerPoint MIME type and byte-identical content. No provider or production AounMED
services were touched.

## PPTX export repair (2026-09-02)

- [x] Rebuild the PPTX layout from the current draft before export and pass the fresh
  `editor/data/render-audit/layout-plan.json` explicitly to the builder.
- [x] Reject stale layout plans by checking the draft hash and exact section/question IDs.
- [x] Reflow imported PDF frames to the editable text footprint and use content-sized fallback
  pagination, preventing long MCQ stems, options, explanations, or bank-source lines from
  overlapping the next question.
- [x] Confirmed the current draft builds five editable slides; `unzip -tq` passes and the rendered
  MCQ pages have no visible cross-question overlap.
- [x] Prefer `pdf_template/.venv/bin/python` for editor PDF preflight, with explicit local Python
  overrides and `uv` only as a fresh-checkout fallback.
- [x] Replaced the former private runtime lookup with public, project-local `pptxgenjs` and `jszip`
  dependencies. A normal `bun install` makes Save as PPTX self-contained; no Codex cache or
  `AOUNMED_PPTX_NODE_MODULES` setting is required.
- [x] Diagnosed the local `soffice` conversion check separately: LibreOffice 26.2 aborts with
  exit 134 during macOS `CreateSalInstance`/LaunchServices initialization before opening the
  deck. This is an environment-level headless LibreOffice crash, not a PPTX package error.

## Nested lecture packets, embedded fonts, and Tutor bridge (2026-09-02)

- [x] Changed the canonical packet shape to `document.lectures[].sections[]` while retaining
  validation/rendering compatibility for the original flat `document.sections[]` packets.
- [x] Added lecture and section nodes to the editor CONTENT TREE, with add/remove controls and
  a duplicate-question action in both the tree and question editor. Duplicate questions receive
  fresh IDs and remain independently editable.
- [x] Added Tutor's approved QUIZZES **Export lecture.json** route using the versioned
  `aounmed-lecture-v1` contract, and the editor's **Add lecture.json** append/import action. The
  first bridge is intentionally text-only: omitted question media is represented by an explicit
  notice rather than a broken image reference.
- [x] Embedded the supplied Work Sans, Fredoka, and Noto Sans Arabic fonts in generated PPTX files
  under `ppt/fonts/`, with PowerPoint TrueType embedding flags. The deck is therefore portable
  without a separate font installation (viewers may still substitute if they ignore embedding).
- [x] Kept PPTX export independent of transient runtime caches through the editor's declared,
  project-local `pptxgenjs` and `jszip` packages.
- [x] Confirmed LibreOffice 26.2.5.2 itself crashes on this macOS host with SIGABRT/exit 134 in
  `CreateSalInstance` while LaunchServices initializes. This occurs before the generated deck is
  opened; it is not a packet or PPTX validation failure. The editor's Python PDF renderer and
  local PptxGenJS export continue to work independently.
- [x] Rebuilt `output/pptx/week1-template-editable.pptx` from the nested sample. The final package
  has seven editable slides, six `ppt/fonts/font*.dat` parts, the expected embedded-font family
  list and TrueType embedding flags, and passes `unzip -tq`.
- [x] Browser-verified CONTENT TREE duplication, multiple sections under one lecture, independent
  per-section layouts, and append-only `aounmed-lecture-v1` import with its text-only media notice.

## Explanation spacing repair (2026-09-03)

- [x] Replaced fixed explanation slots with newline-aware, content-sized boxes in MCQ,
  single-column, and OSPE layouts.
- [x] Reduced explanation typography to 8.8pt for compact MCQs and 9.2pt for single/OSPE pages,
  with explicit top, bottom, and side margins.
- [x] Reused the same measured explanation height in fallback pagination and layout reflow so the
  editable box cannot overlap the preceding question content or the following metadata/question.
- [x] Built both the sample and current editor draft; both archives are valid and the presentation
  overflow check reports no overflow.

## Start page and bank library (2026-09-03)

### Plan

- [x] Scout the existing editor/server boundary without changing the immutable sample or the
  AounMED production application.
- [x] Add a local bank catalog that can list the preserved Example, immutable Reference, and
  user-created packets.
- [x] Make the bank catalog the first screen, with create/import actions and a safe route into the
  existing editor.
- [x] Keep the current draft intact and surface the local OSPE image as an image example.
- [x] Document storage, routes, recovery behavior, and startup commands.
- [x] Run focused syntax/build checks only; reuse the earlier renderer/PPTX evidence.

### Delivered

- [x] Added `GET/POST /api/banks`, `GET/PUT /api/banks/:id`, and local persistence under
  `editor/data/banks/` (runtime files remain ignored).
- [x] Preserved the existing draft as a stable Example snapshot in the ignored
  `editor/data/example_packet.json`, so switching to a Saved bank for export cannot replace the
  working example.
- [x] Added the start page with bank cards, descriptions, counts, optional cover media, Example /
  Reference / Saved labels, create-bank form, packet import, and unsaved-change confirmation.
- [x] Kept the existing three-pane editor and PDF/PPTX pipeline available through **Open editor**;
  rendering/export preflight uses the compatibility draft for the packet currently open without
  replacing the preserved Example snapshot.
- [x] Added the OSPE image to the current draft's Scalp example while leaving `sample_packet.json`
  unchanged as the recovery/reference source.
- [x] Hardened packet normalization for the existing draft's malformed MCQ (zero choices): it is
  retained as open-response content with a visible warning instead of blocking the editor or
  fabricating answer options.
- [x] Updated `README.md` with the bank-library model and API contract.
- [x] `bun build editor/server.ts --outfile /dev/null --target bun --format esm`, browser-bundled
  `editor/public/app.js`, and `git diff --check` pass. No provider, database, or AounMED service
  was touched.

## Example-bank PDF validation repair (2026-09-03)

### Plan

- [x] Trace the reported question ID through the active Example packet and renderer validation.
- [x] Keep malformed choice-labelled questions source-faithful without inventing answer options.
- [x] Canonicalize them into a renderable open-response section at both browser and server boundaries.
- [x] Keep the saved packet in sync with the server's canonical form before PDF/PPTX export.

### Delivered

- [x] A question marked `mcq`/`multi_select` with fewer than two or more than six options is
  downgraded to `other` with a visible warning, then moved out of `mcq_two_column` into a
  deterministic `seq_single_column` “open responses” section. This also repairs older packets
  already downgraded by a previous editor session.
- [x] Bank reads, saves, resets, PDF renders, and PPTX exports now pass through the same server
  sanitizer, so a stale browser bundle cannot send an invalid MCQ section to the renderer.
- [x] The browser adopts the server-returned canonical packet after Save draft, avoiding a second
  export with stale in-memory structure.
- [x] No answer choices or medical content are fabricated; the original stem, answer, provenance,
  and warning remain intact.
- [x] Focused verification: the live editor API accepted the previously failing draft through
  `POST /api/render` and produced a 10-page PDF with 29 questions; direct `render_template.py`
  validation of the repaired draft also passes.

## Editor hierarchy and form simplification (2026-09-03)

- [x] Hide bank-wide and lecture-wide metadata behind explicit settings controls.
- [x] Clarify lecture, section, and question levels in the content tree.
- [x] Present editor sections as separate cards and repair the cramped note editor.
- [x] Complete focused visual and build verification.

The live editor now opens on the selected section/question rather than global metadata. Bank and
lecture settings are explicit, mutually exclusive panels. The tree uses semantic accordion controls
and distinct section/question surfaces. Every editor concern is a separate card, and note text uses
a wide multiline field. Browser/build checks passed with no console errors.

## Library cleanup and progressive disclosure (2026-09-03)

- [x] Keep a single built-in Example bank card.
- [x] Represent Neck OSPE and temporal-fossa material as separate lectures.
- [x] Move Traceability ahead of Notes and collapse secondary editing cards by default.
- [x] Complete focused catalog, hierarchy, disclosure, and build verification.

The duplicate Reference remains available internally for reset/recovery but is no longer a bank
card. Only the exact legacy built-in Anatomy hierarchy is promoted; saved banks remain unchanged.
Notes, media, and hints now use closed-by-default disclosures with persistent open state. Live DOM,
visual, catalog, and build checks passed.

## Mobile workspace (2026-09-03)

- [x] Add mobile Tree / Editor / Preview navigation and responsive form layouts.
- [x] Move Traceability directly above the Answer and Tutor layer.
- [x] Verify phone and desktop rendering plus the browser bundle.

The editor now uses a sticky Tree / Edit / Preview switcher below 900px, automatically opens Edit
after choosing a question, and reflows its library, toolbars, forms, rows, preview, and controls for
touch. A 390×844 browser check had no horizontal overflow or console errors; desktop retains all
three panes. Traceability is rendered immediately before the Answer and Tutor card.

## QUABanks Cloudflare migration documentation (2026-09-04)

### Documentation/configuration checkpoint

- [x] Rename the target README for the extracted QUABanks repository and describe the
  Worker/D1/R2/Queue/Container architecture.
- [x] Document local initialization, standalone-editor fallback, D1 migration, secrets,
  provisioning, deploy, logs, rollback, API routes, ownership, and revision semantics.
- [x] Document the immutable R2 snapshot/export flow and the per-job container directory
  boundary, including the requirement to keep `INTERNAL_BASE_URL` non-placeholder.
- [x] Keep `editor/data/draft_packet.json` and `editor/data/example_packet.json` available as
  admin-owned seed material while ignoring runtime bank files, audits, exports, dependencies,
  Wrangler state, logs, and credentials.

## Worker/export hardening (2026-09-04)

- [x] Require an explicit bank revision on every collaborative save and export; parse quoted
  `If-Match` values and return `409 Conflict` for stale edits.
- [x] Enforce lecture-level contributor ownership: a contributor may add/edit/remove only their
  own lectures in a shared bank, while bank metadata and the built-in Example remain admin-owned.
- [x] Verify every `r2://` media reference against the registered `assets` table before snapshotting.
- [x] Preserve unique R2 keys in per-job paths and localize those references inside the container;
  copy built-in sample media into the job root so renderer path safety remains intact.
- [x] Add bounded Queue redelivery for transient container/network failures and a protected
  `POST /api/exports/:id/retry` endpoint; completed jobs are atomically claimed and never rerun.
- [x] Normalize local Docker callbacks from loopback to `host.docker.internal`; disposable local
  smoke test authenticated, seeded the Example bank, and completed a PDF export in one attempt.
- [x] Seed the admin-owned current editor Example packet (while retaining `sample_packet.json` for
  renderer recovery) and expose lecture-level CRUD plus admin-only bank deletion routes.
- [x] Record the safe migration order: local checks → Cloudflare deploy/smoke test → clean
  QUABanks GitHub push → recoverable source backup → targeted AounMED deletion.

### Remaining integration gates

- [x] Finish and locally type-check the Worker/Container implementation.
- [x] Provision the production D1 database, private R2 bucket, Queue, and Container resources.
- [x] Set production secrets and replace all Wrangler placeholders.
- [x] Apply the remote migration and complete the two-user PDF/PPTX deployment smoke test.
- [x] Initialize QUABanks Git history, push `main` to `0xhades/QUABanks`, and verify the
  remote tree (initial commit `ee297a8a90d100bac1728b83e5ee8e6629a2deff`).
- [x] Back up and remove only AounMED's `pdf_template`, then push that targeted deletion;
  the recoverable backup is `/private/tmp/aounmed-pdf-template-backup.2sR46/pdf_template`.

## Cloudflare deployment and smoke checkpoint (2026-09-04)

- [x] Authenticated Wrangler to the `Onlyghostz` account and created D1 `quabanks`, R2
  `quabanks-media`, and Queue `quabanks-exports`; applied migration `0001_initial.sql` remotely.
- [x] Deployed Worker `quabanks` at `https://quabanks.onlyghostz.workers.dev` with Static Assets,
  Queue consumer, D1, R2, and the two-instance export Container configuration.
- [x] Replaced the placeholder callback with the deployed HTTPS Worker URL and deployed the
  PBKDF2-compatible authentication build (Workers cap PBKDF2 at 100,000 iterations).
- [x] Production smoke: shared gate, admin bootstrap/login, two contributor registrations,
  cross-user bank reads, owned-lecture edit, 403 ownership rejection, and 409 stale-revision
  rejection.
- [x] Production export smoke: seeded Example PDF and PPTX both completed in one attempt;
  downloaded PDF validated as 6 pages and PPTX passed `unzip -t`; disposable smoke bank was
  removed, leaving only the admin-owned Example.

## Production export capacity regression (2026-09-04)

- [x] Diagnose the repeated `Queued…` / `Rendering…` loop from Queue events and persisted D1 jobs.
- [x] Route jobs through a bounded reusable two-container pool instead of allocating one Container
  Durable Object identity per export job.
- [x] Bound Queue consumer concurrency to the configured container pool and expose actionable,
  structured retry/failure diagnostics.
- [x] Improve the editor's retry label so a transient retry is distinguishable from a first queue.
- [x] Run focused type/config tests, deploy, and verify one PDF plus one PPTX production export.

Root cause: `idFromName(job_id)` created an unbounded series of distinct container instances while
the Cloudflare application permits two live instances. The first two jobs occupied that capacity;
later job-specific instances received platform HTTP 500 responses until their three attempts were
exhausted. The queue itself remained healthy, which is why invocation logs showed `outcome: ok`.

Production verification: the Example bank exported a four-page PDF and a structurally valid PPTX,
both in one attempt. A temporary four-instance rollout bridge let the new fixed pool replace the two
legacy job-named instances; production was then restored to the intended two-instance maximum.

## Browser artifact download regression (2026-09-04)

- [x] Inspect the user-downloaded PDF/PPTX bytes and identify whether corruption occurred during
  rendering, R2 storage, or browser delivery.
- [x] Route browser navigations under `/api/*` through the Worker before the SPA asset fallback.
- [x] Fetch artifact bytes through the authenticated API client and reject HTML/error bodies before
  creating a PDF/PPTX download.
- [x] Add explicit artifact media types, byte length, and no-sniff/no-store response headers.
- [x] Run focused checks, deploy, and verify browser-shaped PDF/PPTX requests return valid file
  signatures rather than `index.html`.

Root cause confirmed from the supplied files: all three are byte-identical copies of
`editor/public/index.html` (12,045 bytes), not renderer output. Cloudflare Static Assets' SPA
navigation fallback handles direct artifact-link navigations before the Worker unless
`assets.run_worker_first` explicitly includes `/api/*`.

Production verification: Worker version `147113a6-7b7e-4a70-93c9-52d83c37c5ae` returned a
392,979-byte, four-page PDF and a structurally valid 488,809-byte PPTX even when requests included
browser navigation headers. Both completed in one container attempt; neither response passed through
the 12,045-byte SPA shell.

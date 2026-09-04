# Isolated PDF-template editor

This is a self-contained Bun webapp for editing a `pdf-template-v1` packet. It is separate from
the AounMED production app and does not read or write production data, ORES, ROADS, QUIZ, or Tutor
state.

Start it from this directory:

```bash
bun run dev
```

Then open <http://localhost:5178>. Set `AOUNMED_PDF_EDITOR_PORT` to use another local port.

## Local PPTX runtime

The **Save as PPTX** action invokes `../build_editable_pptx.mjs` using the public, project-local
`pptxgenjs` and `jszip` dependencies declared in this directory. Install them once after cloning:

```bash
bun install
```

No Codex cache, private `@oai/artifact-tool` package, runtime-module environment variable, or
LibreOffice process is required. The server normally launches the builder with its own Bun
executable. `AOUNMED_PPTX_NODE` (or `AOUNMED_NODE_BIN`) remains available only for deployments that
intentionally use another Node-compatible executable.

The PDF renderer uses `../.venv/bin/python` automatically when that project environment exists. Set
`AOUNMED_PDF_EDITOR_PYTHON` (or the compatibility alias `AOUNMED_PDF_RENDER_PYTHON`) to select a
different local interpreter. Once `bun install` has completed, no package installation or network
access is needed at editor runtime.

## Editor workflow

1. Edit the loaded packet, or use **Import JSON** to load another `pdf-template-v1` packet. Use
   **Add lecture.json** to append the approved, text-only `aounmed-lecture-v1` export downloaded
   from AounMED Tutor; it creates fresh local IDs and does not overwrite the current packet. Images
   are intentionally omitted by the Tutor export for now and are retained as explicit notes.
2. Use **Save draft** to keep browser changes in `data/draft_packet.json`.
3. Use **Render PDF** for the authoritative deterministic PDF preview.
4. Use **Save as PPTX** to regenerate the PDF/layout plan for the current draft and then build the
   editable companion at `../output/pptx/editor-preview.pptx`. The current draft's layout audit is
   passed explicitly, and stale plans are rejected by packet hash/question IDs, so long MCQ stems
   cannot overlap the next question merely because an older plan exists.
5. Download the generated JSON or PPTX from the editor when needed.

The editable PPTX embeds the supplied Work Sans, Fredoka, and Noto Sans Arabic font files under
`ppt/fonts/` and sets PowerPoint's TrueType embedding flags. The deck therefore carries its intended
typefaces without requiring a separate installation; a viewer that ignores embedded fonts may still
substitute. This export path is independent of LibreOffice.

The HTTP contract is stable:

- `POST /api/export-pptx` accepts `{ "packet": <pdf-template-v1 packet> }` and returns a JSON
  result with `download_url` on success.
- `GET /api/editor.pptx` serves the latest generated editable companion.

Run focused checks with:

```bash
bun run check
bun run check:builder
```

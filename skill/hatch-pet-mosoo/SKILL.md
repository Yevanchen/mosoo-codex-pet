---
name: hatch-pet-mosoo
description: Turn one attached avatar into a complete Codex-compatible animated pet, validate the 8x9 atlas, and publish a downloadable zip under outputs/. Use for avatar-to-Codex-pet requests in the Mosoo runtime.
version: 0.1.0
dependencies:
  - scripts/
  - references/
---

# Hatch Pet for Mosoo

Create the full pet package autonomously from the one image attached to the user message. The Mosoo runtime has no built-in `image_gen`, `view_image`, `spawn_agent`, or `$CODEX_HOME` pet directory. Use the bundled CLI sequentially and make the final zip an artifact.

## Contract

- Read `references/codex-pet-contract.md`, `references/animation-rows.md`, and `references/qa-rubric.md` before generating.
- Set `SKILL_DIR` to the absolute directory containing this `SKILL.md`; the runtime catalog provides that path.
- Treat the attached image path in the user message as the identity reference. Never print `OPENAI_API_KEY`.
- Use `python3 "$SKILL_DIR/scripts/image_gen.py"`; do not invent another image client.
- Use `gpt-image-2`, `--quality low`, and a flat chroma-key background. Do not request native transparency.
- Work sequentially: base first, then each ready animation row. Do not attempt subagents.
- Only files under the session's top-level `outputs/` become downloadable artifacts. The final artifact must be `outputs/codex-pet.zip`.

## Workflow

1. Verify dependencies without exposing secrets:

   ```bash
   python3 -c 'import openai; from PIL import Image; print("pet dependencies ready")'
   test -n "$OPENAI_API_KEY"
   ```

   If either check fails, stop with one actionable error. Do not install packages ad hoc during a run.

2. Create a scratch run and its job manifest. Use the attachment path shown in the user message:

   ```bash
   RUN_DIR="$PWD/.pet-run"
   python3 "$SKILL_DIR/scripts/prepare_pet_run.py" \
     --pet-name "Codex Pet" \
     --description "A custom Codex pet based on the uploaded avatar." \
     --reference "$AVATAR_PATH" \
     --output-dir "$RUN_DIR" \
     --style-preset auto \
     --pet-notes "Preserve the avatar's recognizable face, palette, silhouette, and personality in a compact pet-safe mascot." \
     --force
   ```

3. Read `imagegen-jobs.json`. For the `base` job, run `image_gen.py edit` with the avatar plus its prompt file; write the result to the job's `output_path`. Copy it to `references/canonical-base.png` and mark the job complete in the JSON.

4. For each ready row job, run `image_gen.py edit` with every `input_images[].path` in manifest order, the job's prompt file, `--quality low`, and `--size 1536x512`. Write directly to its `output_path` and mark it complete. Retry once with `retry_prompt_file` only for a transport-level bad request. Generate `running-left` normally; do not pause for mirror approval.

5. Process and validate all rows:

   ```bash
   python3 "$SKILL_DIR/scripts/extract_strip_frames.py" --decoded-dir "$RUN_DIR/decoded" --output-dir "$RUN_DIR/frames" --states all --method auto
   python3 "$SKILL_DIR/scripts/inspect_frames.py" --frames-root "$RUN_DIR/frames" --json-out "$RUN_DIR/qa/review.json" --require-components
   python3 "$SKILL_DIR/scripts/compose_atlas.py" --frames-root "$RUN_DIR/frames" --output "$RUN_DIR/final/spritesheet.png" --webp-output "$RUN_DIR/final/spritesheet.webp"
   python3 "$SKILL_DIR/scripts/validate_atlas.py" "$RUN_DIR/final/spritesheet.webp" --json-out "$RUN_DIR/final/validation.json"
   python3 "$SKILL_DIR/scripts/make_contact_sheet.py" "$RUN_DIR/final/spritesheet.webp" --output "$RUN_DIR/qa/contact-sheet.png"
   python3 "$SKILL_DIR/scripts/render_animation_previews.py" --frames-root "$RUN_DIR/frames" --output-dir "$RUN_DIR/qa/previews"
   ```

   Deterministic validation is the runtime acceptance gate. Because Mosoo has no visual inspection tool, include contact sheet and previews in the zip for human QA instead of claiming model visual QA.

6. Package with Python standard library. The zip root must contain `pet.json` and `spritesheet.webp`; place QA under `qa/`. Always overwrite the prior demo artifact atomically:

   ```bash
   mkdir -p outputs "$RUN_DIR/package/qa"
   cp "$RUN_DIR/final/spritesheet.webp" "$RUN_DIR/package/spritesheet.webp"
   cp "$RUN_DIR/final/validation.json" "$RUN_DIR/qa/review.json" "$RUN_DIR/qa/contact-sheet.png" "$RUN_DIR/package/qa/"
   cp -R "$RUN_DIR/qa/previews" "$RUN_DIR/package/qa/previews"
   python3 - "$RUN_DIR/package/pet.json" <<'PY'
   import json, sys
   with open(sys.argv[1], "w", encoding="utf-8") as f:
       json.dump({"id":"codex-pet","displayName":"Codex Pet","description":"A custom Codex pet based on the uploaded avatar.","spritesheetPath":"spritesheet.webp"}, f, indent=2)
       f.write("\n")
   PY
   python3 - "$RUN_DIR/package" "outputs/codex-pet.zip.tmp" <<'PY'
   import os, sys, zipfile
   root, target = sys.argv[1:]
   with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
       for base, _, files in os.walk(root):
           for name in files:
               path = os.path.join(base, name)
               z.write(path, os.path.relpath(path, root))
   PY
   mv outputs/codex-pet.zip.tmp outputs/codex-pet.zip
   ```

7. Reply only after `outputs/codex-pet.zip` exists. Report validation success and the artifact name; never claim visual QA was automated.

## Failure rules

- Missing API credential or Python packages: fail fast with the missing requirement.
- Image generation failure after one retry: name the failed state and stop.
- Atlas or frame validation failure: do not package a false success.
- Never return a placeholder, opaque atlas, partial row set, or zip outside `outputs/`.

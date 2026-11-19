# Recovery notes

## What was accessible

The referenced ChatGPT conversation records these milestones:

- **1.0** — self-contained HTML foundation with image/video import, spatial cleanup, manual repair, comparisons, annotations, project/report export, and experimental WebM rendering.
- **1.1** — histogram and quality metrics, defect overlays, difference and split views, redo, brush cursor, project reopening, cancellation, and accessibility refinements.
- **2.0** — tested temporal dust restoration, scratch suppression, three restoration presets, sharpening, deterministic grain, and lossless PNG-sequence ZIP export. The log states that import, frame analysis, presets, temporal analysis, PNG export, and ZIP integrity were tested in Chromium without page errors.
- **3.0** — described as the next development phase, with motion-aware temporal restoration, scene-cut detection, better inpainting, scratch tracking, and diagnostics. No 3.0 source or completed artifact was attached to the accessible history.

The original 1.0/1.1 links point to an expired sandbox path. The 2.0 record names a download but exposes neither its URL nor an attachment. The target GitHub repository initially contained only `LICENSE`.

## What was published

`index.html` is a clean-room reconstruction based on the accessible 2.0 feature record. It preserves the documented browser-only architecture and implements the recorded capabilities without claiming to reproduce unavailable bytes. The repository keeps the pre-existing license untouched and adds this note to make provenance and limitations explicit.


## 3.0

Version 3.0 replaces the reconstructed 2.0 single file with a tested modular build: `src/engine.js` (restoration engine, runs in a Web Worker), `src/io.js` (DPX/TIFF/ZIP/mask I/O) and `src/app.js` (interface). It delivers the 3.0 roadmap items above (motion-aware temporal restoration, scene-cut detection, better inpainting, scratch tracking, diagnostics) and fixes defects found in 2.0:

- Sharpen subtracted the pre-grade blur from the graded value, so it amplified exposure and contrast changes instead of edges, and did nothing when denoise was 0.
- Temporal dust detection compared unregistered neighbouring frames, so camera movement and flicker caused false repairs or missed dust.
- "PNG ZIP" exported only the five frames around the playhead.
- Playback and frame navigation discarded the restoration and all manual work on the current frame.
- Undo lost brush strokes because the post-stroke state was never recorded.
- Heal scaled a larger patch into the brush instead of repairing the area.

`npm run build` still produces a single self-contained HTML file.

## 3.1

Version 3.1 closes the main gaps listed for 3.0:

- **16-bit pipeline.** Decoders, the engine, and the encoders all work on 16-bit RGBA. Analysis thresholds stay in 8-bit units.
- **Dense optical flow.** Robust iterative Lucas-Kanade refinement of the block field uses Geman-McClure weights and bounded corrections. The motion search is pre-normalized so that damage cannot bias it.
- **WebGPU acceleration** of the flow solver, using five compute shaders, with CPU fallback. GPU and CPU agree to within 0.00003 px.
- **PatchMatch inpainting** for larger holes.
- **New output formats:** 16-bit PNG and TIFF, and 10-bit DPX encoders. MP4 and WebM muxers are fed by WebCodecs.
- **Parallel range rendering** across a worker pool, plus a worker-side frame cache.
- **Fixed:** brightness matching could be biased by large damaged areas. This affected heal quality in 3.0 as well.

## 3.2

Version 3.2 adds the operator tools of high-end restoration suites:
- Click&Fix, using local high-sensitivity detection from the cached analysis.
- Motion-compensated frame rebuild.
- A history (revert) brush.
- Tracked protect regions.
- Infrared dirt-channel cleaning, with RGBA DPX and TIFF alpha kept as the infrared layer.
- A motion-confidence view.
- Per-shot settings with manual splits.
- Stabilization from clip-level similarity-transform motion, with smooth and lock modes, edge zoom, and an Output view.

Projects save shots, regions, rebuilt frames, history-brush masks, and the clip scan.

## 3.3 and 3.4

Version 3.3 added:
- Keyframed parameters, with linear or clamped Catmull-Rom curves.
- Shot-level faded-color restoration.
- Sub-pixel color-separation registration: similarity alignment on gradient structure, refined by Gauss-Newton.
- Damaged-frame detection in the clip scan, a per-shot assessment panel, and one-click rebuild.
- Cleaning of the neighbors used to rebuild a frame.
- Sub-pixel global motion, which also improves stabilization.
- **Fixed:** motion analysis was cached without the color-registration setting in its key.

Version 3.4 added:
- OpenEXR reading and writing, verified bit-exactly against ffmpeg's stored values.
- A batch render queue that keeps a full project snapshot per clip.
- Project loading now waits for paint layers to decode before rendering.

## 3.5 to 3.7

- **3.5:** repair regions for persistent defects. They refine the box down to the actual defect pixels, fill them from the frames the camera revealed, and synthesize the rest. The test harness's settings API now stores values the way the sliders do.
- **3.6:** colorization by geodesic chrominance blending, with a colour-hint brush and propagation along the camera path. **Fixed:** the geodesic distances were stored as 32-bit floats while the heap keys were 64-bit, which made valid queue entries look stale.
- **3.7:** local separation dewarping, and Cineon-log DPX in and out.

## 3.8

Version 3.8 moves the block motion search onto WebGPU:
- Full search at the coarsest level, then candidate refinement on the finer levels.
- Expansion of the block field into the per-pixel flow.
- Lucas-Kanade refinement, which was already on the GPU.

The median filtering and outlier repair of the small block field stay on the CPU and are shared with the CPU path. The block vectors are identical to the CPU's, and a browser test enforces this. Shader validation errors now fail GPU set-up loudly instead of silently producing zeros.

**Fixed:** a WGSL binding was named `ref`, which is a reserved word.

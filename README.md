# FrameRestore Studio 3.8

FrameRestore Studio is a browser-based film-restoration workspace. It removes dust, dirt, and line scratches, corrects flicker, and reduces noise. Every frame stays on your computer: there is no server, account, or upload.

Open `index.html` in a current Chrome or Edge, or build the single-file version with `npm run build`.

## What it does

**Automatic restoration**
- The pipeline is 16-bit end to end. 10-, 12- and 16-bit scans keep their precision through every stage, and only the on-screen preview is reduced to 8 bit.
- Temporal dust and dirt detection compares each frame with motion-compensated previous and next frames, using sign-consistent spike detection, edge- and noise-adaptive thresholds, and hysteresis.
- Motion is estimated as dense, per-pixel optical flow. A three-level block search initializes it, and robust iterative Lucas-Kanade refines it. This registers rotation, zoom, and parallax that rigid blocks cannot. On a test with 2.5° of rotation and 3% zoom, alignment error drops from 0.89 to 0.25.
- Motion analysis runs on the GPU through WebGPU when one is available, and falls back to the CPU automatically. The block search, field expansion, and Lucas-Kanade refinement all run there. The GPU block search reproduces the CPU's block vectors exactly. On an NVIDIA RTX-class GPU, motion analysis for one reference takes about 50 ms at 1080p, against 790 ms on the CPU, and about 110 ms at 4K, against 3.2 s.
- Motion estimation is normalized for local brightness first. Flickering archival footage therefore still registers correctly.
- Scene cuts are detected from histograms. Frames at a cut use two references from the same shot, or fall back to spatial detection.
- Spatial blotch detection handles single photographs and isolated frames. It uses morphological top-hat filtering normalized by local texture activity.
- Holes from spatial repairs and from heal-from-surroundings are filled with multi-scale PatchMatch texture synthesis, which copies real texture and grain from nearby. Small specks use a fast diffusion fill.
- Vertical line scratches are tracked across horizontal bands. Scratches found in the previous frame lower the threshold nearby, so tracking carries from frame to frame.
- Deflicker applies a local gain grid toward the neighboring frames. After a clip scan, it also follows a clip-level brightness target.
- Denoise uses motion-compensated temporal averaging, or an edge-preserving bilateral filter for stills.
- Repairs are grain-matched: noise measured around each repair is put back, so fills do not look smeared.
- Brightness matching between frames ignores damaged areas, so large dirt or heal marks cannot darken or lighten the repair.

**Manual repair tools**
- **Click&Fix:** click a defect and it is detected under the brush with much higher sensitivity than the automatic pass, then repaired from neighboring frames. It falls back to texture synthesis when no clean neighbor exists.
- **Rebuild frame:** a destroyed frame, such as a splice, burn, or missing frame, is replaced by motion-compensated interpolation of its neighbors. Rebuilt frames are never used as references for the frames around them.
- **History brush:** paints the original back wherever automatic repair went wrong, on a single frame.
- **Protect regions:** rectangles drawn around faces, stars, or text. **Track** follows a region through its shot by template matching, and dragging a region on any frame re-keys it.
- **Repair regions** remove persistent defects such as gate hair, burnt-in subtitles, logos, and wires. The app first finds the actual defect pixels inside the drawn box. Those pixels either disagree with the motion-compensated scene, or stay fixed on screen while the scene moves. It then fetches what they hide from the frames the camera moved past, nearest first, level-matched at the seam. Anything no frame reveals is synthesized. Clean pixels inside the box keep their own grain, and a region can span the whole clip.

**Color**
- **Faded-color restoration** rebuilds the dye range and removes fading casts, such as the magenta of faded cyan and yellow dyes. It sets per-channel black and white points and balances the channel midtones with per-channel gamma. After a clip scan the analysis is done once per shot, so the correction cannot flicker.
- **Color-separation registration** brings the red and blue records onto the green one with sub-pixel similarity transforms. It fixes misregistered three-strip separations, shrinkage, and lateral chromatic aberration. It aligns on edge structure, so it also works where the records are anti-correlated.
- **Local dewarp** adds a dense flow between records for non-uniform warping that one global transform cannot fix. On a test record warped by up to 1.6 px, the error drops from 4.55 to 3.51 with global registration and to 0.93 with local dewarp.
- **Colorization** works from painted color hints (Q brush) using geodesic chrominance blending (Yatziv & Sapiro). Each pixel takes the color of the hints it is geodesically closest to, and crossing a luminance edge costs extra distance. Hints therefore fill their own regions and stop at edges. Hints carry through the shot along the camera path, and luminance is never changed.
- **Source encoding** recognizes Cineon-log, printing-density DPX scans from the file header. They are converted into the display-referred working space and written back out as log DPX.

**Clip assessment**
- **Scan clip** also finds damaged frames, such as splices, burns, and tears. A frame is flagged when it disagrees with both motion-compensated neighbors while they agree with each other. Brightness and contrast are normalized first, so flicker and flashes are not flagged.
- The **Assessment** panel lists every shot with its frames, high-frequency weave, flicker, and damaged frames. **Rebuild damaged frames** repairs them all at once, and the report includes the same table.
- A rebuilt frame is made from neighbors whose own scratches and dirt are cleaned first, so their defects are not carried in.

**Shots, keyframes and stabilization**
- **Keyframes** animate any setting within a shot along linear or smooth curves. Smooth curves are Catmull-Rom splines clamped so they never overshoot a key. Editing a slider on an animated shot sets a key at that frame.
- Shots come from scene cuts found by **Scan clip** or from manual splits. Any shot can have its own restoration settings, and the sliders follow the shot you are on.
- **Stabilization** removes gate weave and camera shake. The clip scan measures frame-to-frame motion as a similarity transform: shift, rotation, and scale, fitted robustly so that moving objects are ignored. **Smooth** keeps intended camera moves, and **Lock** holds a shot still, each with an edge zoom. The **Output** view shows exactly what will render.
- **Infrared dirt removal:** RGBA DPX and TIFF scans that carry an infrared layer, as written by scanners with infrared cleaning, use it as a dirt map. This catches dirt that is nearly invisible in color.
- The **Motion** view maps where motion compensation is unreliable.

**Control and review**
- The defect review lists every detected repair. You can zoom to one, or accept and reject repairs individually or all at once.
- The protect mask marks regions that automatic repair must never touch.
- The heal brush paints over damage that detection missed. It repairs from neighboring frames, or from surroundings for stills, inside the same non-destructive pipeline.
- Clone, blur, paint, and erase work on a per-frame layer above the automatic result.
- Undo and redo cover edits, masks, reviews, and settings changes.
- Settings preview live while you drag a slider, because motion analysis is cached.

**Inspection**
- Views include restored, original, draggable split, amplified difference, and defect overlay. Hold `\` to flip to the original.
- Zoom runs from 3% to 3200%, with nearest-neighbor display for pixel inspection.
- The RGB histogram and per-frame metrics show detection mode, defects, scratches, flicker correction, motion confidence, grain level, and processing time.
- The clip scan plots brightness across the clip, marks scene cuts, and shows which frames were processed or edited.

**Media and output**
- Imports browser-playable video (MP4/H.264, WebM), with automatic frame-rate detection and a manual override.
- Imports image sequences in PNG, JPEG, WebP, TIFF, or DPX, by multi-select, folder import, or drag and drop.
- DPX support covers 8, 10 (packing A/B/0), 12, and 16 bit. TIFF support covers 8 and 16 bit, uncompressed, LZW with predictor, and PackBits.
- Imports OpenEXR sequences: scanline, half or float, uncompressed, ZIPS, or ZIP. Imports and exports Cineon-log DPX.
- Renders an in/out range as 16-bit PNG, 16-bit TIFF, 10-bit DPX, OpenEXR half-float (scene-linear, ZIP), or 8-bit PNG, to a folder or a ZIP.
- The **batch queue** stores each clip with its full project: settings, keys, shots, masks, edits, regions, rebuilt frames, range, and format. **Run queue** renders every clip unattended and reports each one's status.
- Renders H.264 MP4 or VP9 WebM video through the browser's hardware-accelerated encoder.
- Range renders run across a pool of background workers in parallel, and frames are still written in order.
- Exports single PNG frames and an HTML restoration report with before/after images and a per-frame log.
- Project files save settings, protect mask, heal marks, review decisions, paint layers, notes, and history.
- Processing runs in background workers, so the interface stays responsive. Each worker keeps recent frames, so stepping through a clip or adjusting a slider does not re-send whole frames.

## Run it

1. Clone the repository and open `index.html` in Chrome or Edge.
2. Drop in a video, an image, or a folder of numbered frames.
3. Pick a preset and browse. With **Auto-restore** on, each frame is restored as you land on it.
4. Check the **Defects** view and the review list. Reject false repairs, and protect anything that must stay.
5. Set in and out points with `I` and `O`, then choose **Render to folder**.

Press `?` in the app for all keyboard shortcuts.

For a single portable file, run this and open the result:

```
npm run build
```

The output is `dist/framerestore-studio.html`.

## Tests

No dependencies are needed. Node 20 or newer is required.

```
npm test               # static smoke check plus engine and I/O tests
npm run test:browser   # drives the real UI in headless Chrome or Edge
npm run bench          # engine timing at 1920×1080 (CPU)
FRS_NO_GPU=1 npm run test:browser                          # force the CPU path
FRS_PAGE=dist/framerestore-studio.html npm run test:browser  # test the single-file build
```

The engine tests use synthetic footage with known defects. They check:
- Detection recall and false alarms on panning shots, and the benefit of motion compensation.
- Dense-flow registration on rotating and zooming shots.
- Robustness to flicker, deflicker accuracy, and scratch repair.
- Review and protect behavior, heal quality, and PatchMatch quality against diffusion.
- 16-bit precision, so a graded ramp keeps its gradations.
- Frame interpolation against blending, and global motion recovery of shift, rotation, and zoom.
- Stabilization of synthetic gate weave, infrared cleaning, and Click&Fix on a defect the automatic pass missed.
- Separation registration, faded-color recovery, damaged-frame detection that ignores cuts and flashes, and keyframe curves.
- OpenEXR checked against ffmpeg in both directions, to within one code value.
- Persistent-defect fill from revealed frames, colorization that stops at edges, local dewarp, and Cineon reference points.

When ffmpeg is installed, the I/O tests check that ffmpeg reads the 16-bit PNG and TIFF files exactly and the 10-bit DPX files within 10-bit quantization. The browser tests check that the GPU and CPU flow agree to within 0.01 px. They also check that rendered MP4, WebM, DPX, and TIFF output passes ffprobe and decodes in ffmpeg without errors. Finally, they drive Click&Fix, the history brush, frame rebuild, the clip scan and lock stabilization, per-shot settings, keyframes, region tracking, infrared cleaning, and damaged-frame detection through the real interface. They also cover a two-clip batch queue, gate-hair and subtitle removal, colorization, and Cineon log input and output.

## Scope and limitations

FrameRestore Studio is an independent project. It has not been benchmarked against commercial restoration suites such as DIAMANT-Film / DustBuster+, MTI DRS Nova, or PFClean. Their names are trademarks of their respective owners, and this project contains none of their code or assets.

Compared with the DIAMANT-Film suite as described in its public release notes, it covers:
- Dust and scratch cleaning, deflicker, and denoise.
- Click&Fix-style repair, interpolation repair, and a history brush.
- Tracked protect regions, infrared dirt masks, and a motion-confidence view.
- Stabilization and per-shot settings.

Beyond what those notes describe, FrameRestore automatically detects damaged frames with one-click rebuild and produces a per-shot damage assessment. Its repair regions also refine a rough box down to the actual defect pixels before filling them.

It does not have:

- **Learned filters.** DIAMANT ships DeepDust, DeepScratch, and DeepInPaint, which need an RTX GPU and a model pack of more than 2 GB. FrameRestore uses classical methods so it can run fully offline in a browser. Inpainting is PatchMatch texture synthesis.
- **Spectral dye-fade modeling based on film stock.** DIAMANT's Scan2Screen plugin has it; fade restoration here is statistical.
- **A floating-point pipeline.** Processing is 16-bit integer, and EXR goes through a fixed 2.2 curve rather than full color management such as ACES or OCIO. Cineon log is supported.
- **Full GPU coverage.** Motion analysis runs on the GPU, but detection, repair, denoise, and grading run on CPU workers. A 1080p frame takes about 0.63 s with the GPU and 1.8 s without. Three workers render about 3.2 frames per second at 1080p on a 32-thread CPU with one GPU. Commercial GPU-native systems are likely faster still.
- **Audio or high-bit-depth video output.** Video output is 8-bit 4:2:0 H.264 or VP9, and MP4 files are limited to 4 GB. Use image sequences for masters.
- **Reliable variable-frame-rate input.** Video input goes through the browser's media element, so convert variable-frame-rate video to an image sequence first.
- **Fine tracking.** Region tracking is translation-only template matching, so it does not follow rotation or scaling.

## License

Apache 2.0. See [`LICENSE`](LICENSE). Provenance of earlier versions is in [`docs/RECOVERY_NOTES.md`](docs/RECOVERY_NOTES.md).

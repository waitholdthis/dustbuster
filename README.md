# FrameRestore Studio

FrameRestore Studio is an independent, browser-based film-restoration workspace inspired by the workflow of professional archival cleanup tools. It is a self-contained HTML application: open `index.html` in a current version of Chrome or Edge and work locally—no server, account, or upload is required.

## Repository status

This repository contains the latest source that could be recovered from the project record. The prior ChatGPT work log confirms a tested **FrameRestore Studio 2.0** standalone HTML build, but its original sandbox download is no longer exposed by the referenced conversation and Version 3.0 was only handed off as a future development phase. The `index.html` here is therefore a source-level reconstruction of the documented 2.0 application and its verified feature set, not a byte-for-byte copy of the expired download. See [`docs/RECOVERY_NOTES.md`](docs/RECOVERY_NOTES.md).

## Features

- Still-image and video import with frame navigation
- Non-destructive restoration controls and archival presets
- Temporal dust detection using adjacent frames
- Conservative scratch suppression and spatial denoising
- Exposure, contrast, saturation, sharpening, and deterministic grain
- Manual heal, clone, blur, paint, and annotation tools
- Original/restored, split, difference, and defect-overlay views
- Histogram, brightness, changed-pixel, and candidate-defect diagnostics
- Undo/redo history and portable project metadata
- PNG frame, restoration report, and uncompressed PNG-sequence ZIP export

## Run it

1. Download or clone the repository.
2. Open `index.html` in Chrome or Edge.
3. Choose an image or video using **Import media**.
4. Select a preset or tune the controls, then choose **Analyze & restore**.
5. Inspect the result and export a PNG, project file, report, or frame sequence.

All media processing happens inside the browser. Large or long videos are intentionally bounded by browser memory and performance.

## Quick local check

No dependencies are required. A lightweight source check is included:

```powershell
node tests/smoke-check.mjs
```

## Scope and limitations

FrameRestore Studio is a functional prototype, not a verified replacement for DIAMANT-FILM DustBuster+. It does not include optical-flow motion compensation, trained AI inpainting, professional 16-bit DPX/TIFF/EXR pipelines, source-audio rendering, or production-grade 4K/8K batch infrastructure. DIAMANT-FILM and DustBuster+ are trademarks of their respective owners; this project is independent and contains no proprietary code or assets from that product.

## License

See the existing [`LICENSE`](LICENSE) file.


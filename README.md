# img2vid

Browser-native image and video tools. Open `index.html` and choose the editor, or go directly to `img.html` / `vid.html`.

Live demo: http://sokrypton.github.io/img2vid

## Project Layout

- `index.html`: landing page linking to the tools.
- `img.html`: image editor and single-video frame tools.
- `vid.html`: multi-clip video editor and merger.
- `shared.js`: shared decoding/encoding utilities used by both pages.
- `libs/`: local JS dependencies (e.g. GIF encoder).

## Image Editor (`img.html`)

Designed for single images or a single video source. Key capabilities:

- Upload image or video (MP4/WebM).
- Image actions: extend, replace, crop, and add reference layouts.
- Video actions: extract frames and crop video via canvas + MediaRecorder.
- Playback controls with frame stepping and a scrubber.
- Download in PNG/JPG/WebP with quality controls.
- Optional WebCodecs path for faster frame extraction when supported.

## Video Editor (`vid.html`)

Focused on multi-clip trimming, cropping, ordering, and export.

- Upload multiple MP4/WebM clips.
- List and grid views for quick clip management.
- Drag to reorder clips (entire card is draggable).
- Modal editor for per-clip trim, frame stepping, and local crop.
- Global preview with a global crop overlay applied after clip crops.
- Subsampling, FPS, and output size controls.
- Export to WebM, MP4, or GIF with bitrate/quality options.
- Per-clip and global previews render at correct sizes (no upscaling).

## Shared Decoding/Encoding (`shared.js`)

- Demuxing and codec inspection.
- Frame extraction via WebCodecs or playback fallback.
- Frame analysis logging (timestamps and visual duplicates).
- Encoding helpers for WebM/MP4/GIF.

## Usage

1. Open `index.html` locally in a modern browser.
2. Choose Image Editor or Video Editor.
3. Load files, edit, then download.

No build step, no server required.

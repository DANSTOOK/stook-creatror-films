# Filmora Engine

Desktop video editor with a WebGL2 compositing core, built for two jobs at once:
conventional video editing, and authoring transparent sprite/UI assets for game
engines such as Godot.

**Stack:** Electron 32 + React 18 + TypeScript 5 + WebGL2 + Zustand + Tailwind,
with a native FFmpeg pipe exporter.

## Commands

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

`npm run dist` packages installers with electron-builder.

> **Why the scripts call `node` directly.** The generated `node_modules/.bin`
> shims (`.cmd`, `.ps1` and the `sh` one alike) split their own path on spaces
> and on `&`. Under a checkout such as `OneDrive - FEMSA Proximidad & Salud`,
> `basedir` collapses to `C:\Users\<you>\OneDrive`, so `vitest` resolves to
> `C:\Users\<you>\vitest\vitest.mjs` and every script dies with
> `MODULE_NOT_FOUND`. Invoking each tool's real entry point through `node`
> sidesteps the shims entirely and behaves identically on every platform.

## Layout

```
src/
  main/                    Electron main process
    index.ts               App lifecycle, window, sandboxed webPreferences
    preload.ts             contextBridge surface (window.filmora)
    ipc/fileSystem.ts      Native dialogs, allowlisted file I/O, ffprobe
    exporter/
      EncoderPipeline.ts   Raw RGBA -> ffmpeg stdin, with backpressure
      HardwareAccel.ts     NVENC / QuickSync / VideoToolbox / AMF selection
  renderer/
    App.tsx                Layout grid
    engine/
      Compositor.ts        Ping-pong FBO render loop
      GLProgram.ts         Program + render target wrappers
      FrameRenderer.ts     Viewport draw and deterministic export draw
      LUTLoader.ts         .cube parser + TEXTURE_3D upload
      TextureManager.ts    Source -> GL texture cache with LRU eviction
      MediaSourceRegistry.ts  Video/image elements and seek alignment
      probeMedia.ts        Duration, size and alpha detection from the decoder
      WebCodecsEncoder.ts  GPU-side encoding to an Annex-B elementary stream
      KeyframeEvaluator.ts Cubic bezier and linear interpolation
      shaders/             BaseVertex, MaskingSDF, ColorGrading, ChromaKey,
                           PixelArtFilter
    audio/
      AudioEngine.ts       Master gain, per-clip EQ, panning, scheduling
      DynamicDucking.ts    Sidechain compression (realtime + offline)
      WaveformExtractor.ts Async PCM peak computation
    components/
      MediaLibrary/  PreviewViewport/  Inspector/  Timeline/  ExportDialog/
    media/
      importMedia.ts       Dialog, drop and picker import; project rehydration
    hooks/
      useTransport.ts      Playback clock and keyboard shortcuts
      useAudioPlayback.ts  Audio decode, scheduling and waveform extraction
    store/
      useProjectStore.ts   Single source of truth
      useHistoryStore.ts   Undo/redo via the Command pattern
      useMediaStore.ts     Derived runtime caches (waveform peaks)
      types.ts             Serializable document schema and factories
  shared/
    types/                 Timeline, keyframe, IPC and shader types
    utils/                 Timecode, math, id helpers
tests/                     Vitest unit suite
```

Files beyond the original specification (`GLProgram.ts`, `FrameRenderer.ts`,
`MediaSourceRegistry.ts`, `timelineOps.ts`, `snapping.ts`, `ExportDialog/`,
`hooks/`) exist so the GPU wrappers, the pure timeline logic and the export
driver are each testable in isolation.

## Alpha handling

This is the load-bearing detail for game-asset export, so it is worth stating
once, explicitly:

| Stage | Alpha form |
| --- | --- |
| Source textures, effect buffers | straight (non-premultiplied) |
| Scene accumulator | premultiplied - the only form in which `over` is correct |
| Resolve pass, canvas, `readPixels` | straight again |

Godot imports straight alpha. Premultiplying on the way out is what produces
dark fringes around sprites, so **Premultiply alpha** is off by default in the
export dialog and should stay off for game assets.

Only three export formats carry a real alpha channel:

| Format | Alpha | Notes |
| --- | --- | --- |
| PNG sequence | yes | Lossless, one file per frame - best sprite-sheet source |
| ProRes 4444 | yes | `yuva444p10le`, 16-bit alpha |
| WebM / VP9 | yes | `yuva420p`; alt-ref frames forced off, they drop alpha |
| MP4 / H.264, H.265 | no | Delivery renders; alpha is flattened |

Hardware encoders (NVENC, QuickSync, VideoToolbox, AMF) cannot carry alpha at
all, so enabling **Export alpha channel** forces a software encoder rather than
silently flattening transparency. The dialog says so instead of failing quietly.

## Engine notes

**Render loop.** Each visible clip is rasterized into a project-sized buffer,
pushed through its enabled passes (chroma key -> grade -> mask -> pixel art) by
swapping two framebuffers, then blended into the scene accumulator with
`blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`. Everything with a GL handle owns an
explicit `dispose()`; VRAM is not garbage collected.

**LUTs.** `.cube` files are parsed to a flat `Float32Array` (red varies fastest,
which is already the order `texImage3D` wants) and uploaded as `RGB16F` with
`LINEAR` filtering, so trilinear interpolation is done by the sampler hardware
and grading costs one fetch per pixel.

**Keyframes.** Easing belongs to the *outgoing* keyframe: the curve authored on
keyframe N shapes the segment N to N+1. Values are held outside the keyframe
range rather than extrapolated. Bezier inversion is Newton-Raphson with a
bisection fallback for degenerate curves.

**Keyframe time is timeline time**, not clip-relative. That is why moving a clip
shifts its keyframes, and why the razor inserts a boundary keyframe carrying the
interpolated value on both halves - so a cut is visually invisible.

**Snapping** is measured in screen pixels (10 px default), not frames, so the
magnet feels identical at every zoom level. Both clip edges are tested during a
move, not just the leading one.

**Timeline rendering** is a single canvas rather than a DOM node per clip, with
off-screen clips culled before any 2D call. That is what holds 60fps at 100+
clips.

**Export** does not reuse the viewport draw path. `FrameRenderer.renderExact`
awaits every contributing decoder before compositing; the viewport path happily
draws a stale frame, which in a render would silently duplicate frames.

## Export paths

Two ways frames reach ffmpeg, chosen automatically per render:

| | `rawvideo` | `annexb-h264` / `annexb-hevc` |
| --- | --- | --- |
| Selected for | anything needing alpha, PNG/ProRes/WebM, pixel-art scaling | opaque MP4 (H.264 / H.265) |
| Renderer sends | uncompressed RGBA (`readPixels`) | encoded chunks from `VideoEncoder` |
| ffmpeg does | encodes | muxes only (`-c:v copy`) |
| Alpha | preserved | none - no browser encoder carries it |

The WebCodecs path builds a `VideoFrame` straight from the canvas, so the frame
never leaves the GPU as raw pixels and IPC carries compressed chunks instead of
~33 MB per second of 4K RGBA. `detectCodecSupport` probes the platform and
returns `null` when nothing fits, in which case the raw path runs unchanged.

**Codec candidates are ordered high-level-first on purpose.** Verified on an AMD
Radeon / ANGLE D3D11 machine: at 4K, `avc1.640033` (High 5.1) is supported while
`avc1.640028`, `avc1.4d0028` and `avc1.42e01e` are all rejected. A list ordered
baseline-first would silently fail every 4K export.

The encoder is configured with `avc: { format: 'annexb' }`, so chunks begin with
the `00 00 00 01` start code that ffmpeg's `-f h264` demuxer expects.

## Editing controls

Right-click opens a context menu everywhere it should:

| Target | Menu |
| --- | --- |
| Track header | Rename, add above/below, move up/down, hide, mute, lock, delete |
| Clip | Split at playhead, duplicate, toggle mask / chroma key / pixel art, delete |
| Empty timeline | Add video / audio / text track, split at playhead |
| Media item | Add to timeline, remove from library |

Track headers also carry an inline delete button, names are renamed by
double-clicking, and the toolbar has an explicit Delete for the selection.

Deleting a track takes its clips with it, and the menu says how many
(`Delete track (3 clips)`) rather than asking for confirmation - every one of
these actions is a normal undoable transaction.

## Playback smoothness

A video element drops below `HAVE_CURRENT_DATA` whenever it seeks or rebuffers.
Skipping the layer for those frames is what made playback flicker, so the
compositor holds the last decoded texture instead and only contributes nothing
when a source has never produced a frame at all.

Drift corrections are also rate limited (600 ms apart, 0.25 s threshold, never
past the media duration). Assigning `currentTime` starts a seek, so correcting
on every animation frame would keep the decoder permanently mid-seek - the
correction itself becomes the stutter.

Measured after the fix: 78 samples across 2.6 s of playback, zero blank frames.

## Importing media

Three ways in, all converging on `media/importMedia.ts`, so an asset built from
a drop is indistinguishable from one opened through Electron:

- the native dialog (desktop app only),
- a drag onto the media panel,
- the file picker.

The dialog is the only one that needs Electron, so the panel falls back to the
picker in a browser rather than throwing. Save, Open and Export genuinely
require the native bridge - those buttons are disabled with an explanatory
tooltip instead of failing at click time.

Unsupported files are reported by name and reason rather than silently ignored.

**Reopening a project re-reads media from disk.** Object URLs die with the page,
so `toDocument()` deliberately blanks `uri` and persists `sourcePath` instead;
`rehydrateAssets` rebuilds the blobs on load. Anything it cannot restore - a
moved file, or media dropped into a browser session that never had a path - is
flagged `missing` in the panel instead of silently rendering nothing.

## Media probing

`ffmpeg-static` bundles ffmpeg but **not** ffprobe, so on a machine with no
ffprobe on PATH the main-process probe returns nothing useful - which would
import every video as a one-frame clip. Duration, dimensions and transparency
therefore come from the browser decoder (`engine/probeMedia.ts`), which has to
decode the file anyway; ffprobe is treated as optional enrichment and its
failure never blocks an import.

Alpha is detected by drawing one frame onto a cleared canvas (downscaled to
128px on the long edge) and scanning for any pixel under an alpha of 250. The
tolerance keeps lossy-codec rounding on an opaque source from being misread as
transparency.

## Security posture

`contextIsolation` on, `nodeIntegration` off, a CSP in `index.html`, and the
renderer can only read files the user actually chose through a dialog - every
path is added to an allowlist in the main process first. Imported media reaches
the page as a blob URL, never a `file://` path.

## Tests

129 unit tests across seven suites, run with `npm test`:

- `KeyframeEvaluator.test.ts` - bezier endpoints and monotonicity, easing
  direction, hold-outside-range, vector and scalar interpolation, unsorted-track
  safety, transform resolution.
- `LUTLoader.test.ts` - header parsing, domain limits, channel ordering,
  comments and CRLF, identity round-trip, and the malformed-input cases
  (truncated, oversized, 1D, inverted domain).
- `TimelineSnapping.test.ts` - pixel-space threshold and zoom behaviour, tie
  resolution, both-edge clip snapping, plus the razor: duration conservation,
  no gap or overlap, source-offset advance, deep-copied config, boundary
  keyframe insertion, and refusal to cut on a boundary.
- `MediaProbe.test.ts` - alpha scanning: partial transparency, the near-opaque
  tolerance, and that only the alpha byte is ever inspected.
- `ExportPipeline.test.ts` - ffmpeg argument construction for both pipe modes
  (including that the WebCodecs path never re-encodes), alpha capability per
  format, hardware codec selection, and WebCodecs eligibility.
- `ImportMedia.test.ts` - file classification and MIME mapping, rejection of
  unsupported drops, and append-to-timeline positioning.
- `TrackOperations.test.ts` - track insert/reorder/delete with contiguous
  ordering, that deleting a track takes only its own clips and is undoable,
  and clip duplication (placement, fresh identity, deep copy).

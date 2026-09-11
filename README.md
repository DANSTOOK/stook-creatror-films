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
      AudioEngine.ts       Clip and track strips, buses, master, scheduling
      DynamicDucking.ts    Sidechain compression (realtime + offline)
      mixRouting.ts        Mute/solo/gain rules shared by playback and export
      renderMix.ts         Offline mix for export, including baked ducking
      WaveformExtractor.ts Async PCM peak computation
    components/
      MediaLibrary/  PreviewViewport/  Inspector/  Timeline/  ExportDialog/
      Mixer/               Faders, pan, EQ, buses, auto ducking
      ProjectSettings/     Frame rate, resolution, duration, alpha background
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
`MediaSourceRegistry.ts`, `timelineOps.ts`, `snapping.ts`, `mixRouting.ts`,
`ExportDialog/`, `hooks/`) exist so the GPU wrappers, the pure timeline logic,
the mixing rules and the export driver are each testable in isolation.

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

## Audio mixing

The engine has always had gain, a three-band EQ, panning, two buses and a
sidechain compressor. None of it was reachable from the interface, which in
practice meant none of it existed. The **Mixer** is that interface.

Signal path, identical in the monitor and in the render:

```
clip:   gain -> low shelf 120 Hz -> peak 1 kHz -> high shelf 8 kHz -> pan
track:  gain -> pan
bus:    music | dialogue
master: gain
```

**Mute and solo are separate states.** While anything is soloed, non-soloed
tracks are silent *without* being muted, so clearing the solo restores exactly
the mute states the user set rather than a flattened version of them. Mute wins
over solo on the same track.

**Bus assignment is explicit.** It used to be sniffed from the track name at
playback time (anything containing "dialog"), so renaming a track silently
re-routed it and a track called "VO" could never drive the sidechain. The name
now only picks the *default* at creation; after that it is a property in the
mixer.

**The export applies the same mix.** `AudioEngine` (realtime) and `renderMix`
(offline) are two separate graphs - one scheduled against an `AudioContext`
clock, one rendered as fast as `OfflineAudioContext` can go - and they read
their numbers from the same module, `mixRouting.ts`. A fader that moved only
the monitor would be worse than no fader at all.

**Auto ducking** runs two different ways for the same reason. Live, an
`AnalyserNode` on the dialogue bus drives the music bus gain. Offline, there is
no realtime graph to analyse, so the music and dialogue buses are rendered
separately, the dialogue is reduced to a per-block RMS envelope, the gain curve
is computed from it and baked into the music, and the two are summed. The
second render is skipped entirely when no track feeds the dialogue bus, since
it could only ever produce a gain of exactly 1 - and the mixer says so rather
than leaving a switch that appears to work.

Gains are interpolated across each 128-sample block rather than stepped: a gain
that jumps between blocks is a 375 Hz buzz at 48 kHz, which is a far worse
artefact than the ducking it implements.

## Project settings

Frame rate, resolution, duration and the transparent background are editable
after the fact, not only adopted from the first import.

The frame rate is the one with a real decision behind it. Frame numbers are
meaningless without the rate that reads them, so changing `fps` by assignment
silently re-times the edit: a cut authored at second 4 on a 24 fps timeline
lands at second 1.6 once the project is read as 60 fps. **Keep the edit at the
same times** is on by default and rescales every frame-valued field - clip
starts, durations, source offsets, keyframes, markers, the playhead and the
project length - so only the grid changes. Turning it off keeps the frame
numbers and lets the edit play faster or slower, which is what you want when
the timeline was authored against frame counts.

Durations are floored at one frame: rounding a 1-frame clip of 60 fps material
down to 0 at 24 fps would delete it outright.

## Markers

Markers were drawable, and the magnet already snapped to them, but nothing
could create one. They are now project data rather than editor UI state, which
is what makes them saved, undoable and visible to every snap consumer without
being passed around.

`M` drops one at the playhead, ready to be named. The ruler's context menu adds
one under the pointer, renames, moves to the playhead, deletes and clears all;
clicking a flag selects it and jumps there, and the chevrons beside the Marker
button step between them. One marker per frame - a second one on the same frame
would be drawn exactly on top of the first, so it could never be clicked and
therefore never deleted.

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

## Frame rate

The project takes its frame rate and resolution from the **first clip
imported** into an empty project - the "new sequence from clip" behaviour every
NLE has. Without it the project sat at its 30 fps default and 60 fps footage was
silently halved on export, which looks exactly like the editor losing frames.

`ProjectState.fps` is a `number`, deliberately widened from the original
`24 | 30 | 60`: 25 and 50 fps (PAL) and the 23.976/29.97 pulldown rates are
ordinary source material, and snapping them to one of three values resamples
footage for no reason.

Two sources of truth, in order of preference:

1. **ffmpeg**, parsed from the stream summary it prints for a file. `ffprobe`
   is not bundled with `ffmpeg-static`, so the previous ffprobe-based probe
   never actually ran.
2. **Measurement**, for files dropped in with no path on disk:
   `requestVideoFrameCallback` reports the media time of each presented frame,
   and the median gap between them is the frame interval. The result is snapped
   to a standard rate within 4%, since a project running at 29.9994 fps would
   drift against its audio.

## Playback speed

The clock and the transport commands are separate hooks on purpose.
`usePlaybackClock` owns the `requestAnimationFrame` loop that advances the
playhead and must be mounted **exactly once**, by `App`; `useTransport` is
effect-free and safe to call anywhere.

This is not hypothetical tidiness. `useTransport` originally owned the loop and
was called from two components, so two loops advanced the same playhead and
everything played at exactly double speed. `usePlaybackClock` now counts its own
mounts and logs an error if a second one appears, because "everything is too
fast" is very hard to trace back to a duplicated hook.

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

## End-to-end test

```bash
npm run test:e2e
```

Boots real Electron, renders through the real WebGL2 compositor, and pipes into
the real bundled FFmpeg. Nothing is stubbed, and the runner does not trust the
harness's own report - it probes the MP4 with ffmpeg and parses the PNG IHDR
chunks byte by byte.

The scenario imports a generated clip, trims both ends, razors the remainder in
half, grades only the right half to greyscale, animates a transparent sprite
across the frame with eased keyframes, then exports twice: an MP4, and a PNG
sequence with the video track hidden (the Godot sprite path).

14 checks: edit arithmetic, no blank composites, no duplicated frames, MP4 codec
/ resolution / fps / duration, PNG count / size / colour type 6, and surviving
soft alpha edges.

**Export throughput, measured** (640x360, software rendering under SwiftShader,
so a floor rather than a typical figure): 17.2 fps, of which 52.1 ms/frame is
the renderer and 5.7 ms/frame is the IPC and FFmpeg pipe together. The
bottleneck is seeking an `HTMLVideoElement` once per frame, not encoding.
Sequential decoding through a WebCodecs `VideoDecoder` is the real fix and has
not been done.

**It found a real bug on its first run.** Exactly half the frames composited
blank - the graded half. `gl.getError()` returned `0x502`
(`INVALID_OPERATION`): with no LUT loaded the colour-grading program never
bound its `sampler3D`, leaving it defaulted to texture unit 0 where the
`sampler2D` input already lived. WebGL2 rejects a draw whose samplers of
different types share a unit, so the entire pass was silently dropped. The
compositor now always binds a 1x1x1 identity texture to that unit. No unit test
could have caught this: it needs a real GL context.

## Project file

`PROJECT_FILE_VERSION` is 2. Version 1 files still open: `normalizeProject`
fills the fields that did not exist then - track volume, pan, solo and bus,
clip pan and EQ, the markers list and the master/ducking block - with the
values that reproduce version 1 behaviour exactly, including deriving the bus
from the track name the way playback used to. Reopening an old project has to
sound identical to how it sounded when it was saved, or the mixer has quietly
re-mixed somebody's edit.

## Tests

243 unit tests across fifteen suites, run with `npm test`:

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
- `Mixer.test.ts` - mute/solo resolution including mute winning over solo,
  gain and pan clamping, bus assignment being decided once at creation rather
  than re-sniffed on rename, the mix signature ignoring playhead movement while
  catching a fader, the ducking envelope (unity while silent, floor honoured,
  recovery after speech), and the offline path: block RMS, interpolated gain
  curve, ducking landing where the dialogue is, and reporting a gain of exactly
  1 when there is no dialogue to duck against.
- `Markers.test.ts` - creation at the playhead and at a frame, sort order,
  refusal to stack two markers on one frame, rename without moving, re-sorting
  on a move, undo/redo, snap targets, and surviving the document round trip.
- `ProjectSettings.test.ts` - retiming: wall-clock positions and lengths held
  across a rate change, source offsets and keyframes and markers carried, a
  1-frame clip never rounded away, no-op and nonsense rates refused; plus the
  store wiring (export settings kept in step, undoable) and the version 1
  migration.

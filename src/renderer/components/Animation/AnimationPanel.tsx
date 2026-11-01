import { Copy, Eraser, Eye, EyeOff, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Clip } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { MAX_SIZE, MIN_SIZE, useDrawStore } from '@renderer/animation/drawStore';
import { celAt, exposureAt, exposureCount, frameOfExposure, MAX_ONION, MAX_STEP, stepOf, strokeCount } from '@renderer/animation/model';

/**
 * The 2D animation panel: the brush, the exposure sheet, and the layers.
 *
 * The sheet runs DOWN, as an X-sheet does in OpenToonz and as it has on paper
 * for a century, rather than across like the timeline. It is a different
 * instrument for a different job: the timeline is where a clip sits in the
 * film, the sheet is where a drawing sits in the clip.
 *
 * Everything here acts on the selected animation clip. Nothing selected, or
 * something that is not an animation, and the panel says so rather than
 * showing dead controls.
 */

const COLORS = ['#ffffff', '#0f172a', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#6366f1', '#ec4899'];

export function AnimationPanel(): JSX.Element {
  const t = useT();
  const clips = useProjectStore((state) => state.project.clips);
  const selected = useProjectStore((state) => state.ui.selectedClipIds);
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const addAnimationClip = useProjectStore((state) => state.addAnimationClip);
  const setAnimationStep = useProjectStore((state) => state.setAnimationStep);
  const setOnionSkin = useProjectStore((state) => state.setOnionSkin);
  const addAnimationLayer = useProjectStore((state) => state.addAnimationLayer);
  const removeAnimationLayer = useProjectStore((state) => state.removeAnimationLayer);
  const updateAnimationLayer = useProjectStore((state) => state.updateAnimationLayer);
  const clearCel = useProjectStore((state) => state.clearCel);
  const duplicateCel = useProjectStore((state) => state.duplicateCel);
  const seek = useProjectStore((state) => state.setCurrentFrame);

  const drawing = useDrawStore((state) => state.clipId);
  const brush = useDrawStore((state) => state.brush);
  const color = useDrawStore((state) => state.color);
  const size = useDrawStore((state) => state.size);
  const activeLayer = useDrawStore((state) => state.layerId);
  const pick = useDrawStore((state) => state.pick);
  const start = useDrawStore((state) => state.start);
  const stop = useDrawStore((state) => state.stop);

  // The selected animation clip, or the only one there is: picking a clip to
  // draw on should not be a step of its own when there is no choice.
  const animClips = Object.values(clips).filter((clip): clip is Clip => Boolean(clip.anim));
  const clip = animClips.find((candidate) => selected.includes(candidate.id)) ?? (animClips.length === 1 ? animClips[0] : undefined);
  const anim = clip?.anim;

  const header = (
    <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
      <span className="text-xs font-medium text-slate-200">{t('animation.title')}</span>
      <button
        type="button"
        data-testid="animation-add"
        onClick={() => {
          const id = addAnimationClip();
          // Made to be drawn on: the brush is in hand straight away.
          start(id);
        }}
        className="flex items-center gap-1 rounded-control bg-cyan-500/15 px-2 py-1 text-2xs text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
      >
        <Plus size={12} />
        {t('animation.add')}
      </button>
    </div>
  );

  if (!clip || !anim) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <p data-testid="animation-empty" className="px-3 py-6 text-center text-2xs text-slate-400">
          {t('animation.selectClip')}
        </p>
      </div>
    );
  }

  const step = stepOf(anim);
  const count = exposureCount(anim, clip);
  const here = exposureAt(anim, clip, currentFrame);
  const onion = anim.onion;
  const layerId = activeLayer ?? anim.layers[anim.layers.length - 1]?.id ?? null;
  const on = drawing === clip.id;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The brush ----------------------------------------------------- */}
        <section className="border-b border-white/5 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="animation-draw"
              aria-pressed={on}
              onClick={() => (on ? stop() : start(clip.id, layerId))}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-control px-2 py-1.5 text-2xs ring-1 ${
                on ? 'bg-cyan-500/25 text-cyan-100 ring-cyan-400/40' : 'bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10'
              }`}
            >
              <Pencil size={12} />
              {t('animation.draw')}
            </button>
            <button
              type="button"
              data-testid="animation-brush-pencil"
              aria-pressed={brush === 'pencil'}
              title={t('animation.pencil')}
              onClick={() => pick({ brush: 'pencil' })}
              className={`rounded-control px-2 py-1.5 ring-1 ${brush === 'pencil' ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              data-testid="animation-brush-eraser"
              aria-pressed={brush === 'eraser'}
              title={t('animation.erase')}
              onClick={() => pick({ brush: 'eraser' })}
              className={`rounded-control px-2 py-1.5 ring-1 ${brush === 'eraser' ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
            >
              <Eraser size={12} />
            </button>
          </div>

          <label className="mt-2 flex items-center gap-2 text-2xs text-slate-400">
            <span className="w-14 shrink-0">{t('animation.size')}</span>
            <input
              type="range"
              data-testid="animation-size"
              min={MIN_SIZE * 1000}
              max={MAX_SIZE * 1000}
              step={0.1}
              value={size * 1000}
              onChange={(event) => pick({ size: Number(event.target.value) / 1000 })}
              className="flex-1"
            />
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                data-testid={`animation-color-${swatch.slice(1)}`}
                aria-pressed={color === swatch}
                onClick={() => pick({ color: swatch })}
                style={{ background: swatch }}
                className={`h-5 w-5 rounded-full ring-1 ${color === swatch ? 'ring-2 ring-cyan-300' : 'ring-white/20'}`}
              />
            ))}
            <input
              type="color"
              data-testid="animation-color"
              value={color}
              onChange={(event) => pick({ color: event.target.value })}
              className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </div>
        </section>

        {/* Exposure ------------------------------------------------------ */}
        <section className="border-b border-white/5 px-3 py-2">
          <label className="flex items-center gap-2 text-2xs text-slate-400">
            <span className="w-14 shrink-0">{t('animation.step')}</span>
            <select
              data-testid="animation-step"
              value={step}
              onChange={(event) => setAnimationStep(clip.id, Number(event.target.value))}
              className="min-w-0 flex-1 rounded-control bg-white/5 px-2 py-1 text-2xs text-slate-200 ring-1 ring-white/10"
            >
              {Array.from({ length: MAX_STEP }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value === 1 ? t('animation.stepOnes') : value === 2 ? t('animation.stepTwos') : t('animation.stepN', { n: value })}
                </option>
              ))}
            </select>
          </label>
        </section>

        {/* Onion skin ---------------------------------------------------- */}
        <section className="border-b border-white/5 px-3 py-2">
          <label className="flex items-center gap-2 text-2xs text-slate-300">
            <input
              type="checkbox"
              data-testid="animation-onion"
              checked={onion?.enabled !== false}
              onChange={(event) => setOnionSkin(clip.id, { enabled: event.target.checked })}
            />
            <span>{t('animation.onion')}</span>
          </label>
          {onion?.enabled !== false && (
            <>
              <div className="mt-2 flex items-center gap-2">
                <label className="flex flex-1 items-center gap-1.5 text-2xs text-slate-400">
                  <span className="shrink-0">{t('animation.onionBefore')}</span>
                  <input
                    type="number"
                    data-testid="animation-onion-before"
                    min={0}
                    max={MAX_ONION}
                    value={onion?.before ?? 1}
                    onChange={(event) => setOnionSkin(clip.id, { before: Number(event.target.value) })}
                    className="w-12 rounded-control bg-white/5 px-1.5 py-1 text-2xs text-slate-200 ring-1 ring-white/10"
                  />
                </label>
                <label className="flex flex-1 items-center gap-1.5 text-2xs text-slate-400">
                  <span className="shrink-0">{t('animation.onionAfter')}</span>
                  <input
                    type="number"
                    data-testid="animation-onion-after"
                    min={0}
                    max={MAX_ONION}
                    value={onion?.after ?? 1}
                    onChange={(event) => setOnionSkin(clip.id, { after: Number(event.target.value) })}
                    className="w-12 rounded-control bg-white/5 px-1.5 py-1 text-2xs text-slate-200 ring-1 ring-white/10"
                  />
                </label>
              </div>
              <label className="mt-2 flex items-center gap-2 text-2xs text-slate-400">
                <span className="w-14 shrink-0">{t('animation.onionBy')}</span>
                <select
                  data-testid="animation-onion-by"
                  value={onion?.by ?? 'drawings'}
                  onChange={(event) => setOnionSkin(clip.id, { by: event.target.value as 'drawings' | 'frames' })}
                  className="min-w-0 flex-1 rounded-control bg-white/5 px-2 py-1 text-2xs text-slate-200 ring-1 ring-white/10"
                >
                  <option value="drawings">{t('animation.onionByDrawings')}</option>
                  <option value="frames">{t('animation.onionByFrames')}</option>
                </select>
              </label>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{t('animation.onionHint')}</p>
            </>
          )}
        </section>

        {/* Layers -------------------------------------------------------- */}
        <section className="border-b border-white/5 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-2xs text-slate-300">
              <Layers size={12} />
              {t('animation.layers')}
            </span>
            <button
              type="button"
              data-testid="animation-add-layer"
              onClick={() => pick({ layerId: addAnimationLayer(clip.id) })}
              className="rounded-control bg-white/5 px-1.5 py-1 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              title={t('animation.addLayer')}
            >
              <Plus size={12} />
            </button>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {/* Topmost first, as it is seen - the opposite of the order it is drawn in. */}
            {[...anim.layers].reverse().map((layer) => (
              <li key={layer.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid={`animation-layer-visible-${layer.id}`}
                  onClick={() => updateAnimationLayer(clip.id, layer.id, { visible: !layer.visible })}
                  className="rounded p-1 text-slate-400 hover:text-slate-200"
                >
                  {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                <button
                  type="button"
                  data-testid={`animation-layer-${layer.id}`}
                  aria-pressed={layerId === layer.id}
                  onClick={() => pick({ layerId: layer.id })}
                  className={`min-w-0 flex-1 truncate rounded-control px-2 py-1 text-left text-2xs ring-1 ${
                    layerId === layer.id ? 'bg-cyan-500/20 text-cyan-100 ring-cyan-400/30' : 'bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10'
                  }`}
                >
                  {layer.name}
                </button>
                {anim.layers.length > 1 && (
                  <button
                    type="button"
                    data-testid={`animation-layer-remove-${layer.id}`}
                    onClick={() => removeAnimationLayer(clip.id, layer.id)}
                    className="rounded p-1 text-slate-500 hover:text-red-300"
                    title={t('animation.removeLayer')}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* The exposure sheet -------------------------------------------- */}
        <section className="px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-2xs text-slate-300">{t('animation.sheet')}</span>
            <span data-testid="animation-counts" className="text-[10px] text-slate-500">
              {t('animation.strokes', { count: strokeCount(anim) })}
            </span>
          </div>
          <ol data-testid="animation-sheet" className="mt-1.5 flex flex-col">
            {Array.from({ length: count }, (_, exposure) => {
              const layer = anim.layers.find((candidate) => candidate.id === layerId) ?? anim.layers[anim.layers.length - 1];
              const own = layer?.cels.find((cel) => cel.at === exposure);
              const held = layer ? celAt(layer, exposure) : null;
              return (
                <li key={exposure} className="flex items-stretch gap-1">
                  <button
                    type="button"
                    data-testid={`animation-cel-${exposure}`}
                    aria-current={exposure === here}
                    onClick={() => seek(frameOfExposure(anim, clip, exposure))}
                    className={`flex flex-1 items-center gap-2 border-l-2 px-2 py-1 text-left text-[10px] ${
                      exposure === here ? 'border-cyan-400 bg-cyan-500/10 text-cyan-100' : 'border-white/10 text-slate-400 hover:bg-white/5'
                    }`}
                  >
                    <span className="w-6 shrink-0 tabular-nums text-slate-500">{exposure + 1}</span>
                    {/* A drawing of its own is a filled mark; a held one is a line
                        continuing down, which is how an X-sheet shows a hold. */}
                    <span aria-hidden className={own ? 'h-2 w-2 rounded-full bg-cyan-300' : held ? 'h-3 w-px bg-slate-600' : 'h-2 w-2 rounded-full ring-1 ring-white/15'} />
                    <span className="truncate">{own ? t('animation.strokes', { count: own.strokes.length }) : ''}</span>
                  </button>
                  {!own && held && (
                    <button
                      type="button"
                      data-testid={`animation-cel-duplicate-${exposure}`}
                      onClick={() => duplicateCel(clip.id, layerId ?? '', exposure)}
                      className="rounded px-1 text-slate-600 hover:text-cyan-300"
                      title={t('animation.duplicateDrawing')}
                    >
                      <Copy size={11} />
                    </button>
                  )}
                  {own && (
                    <button
                      type="button"
                      data-testid={`animation-cel-clear-${exposure}`}
                      onClick={() => clearCel(clip.id, layerId ?? '', exposure)}
                      className="rounded px-1 text-slate-600 hover:text-red-300"
                      title={t('animation.clearDrawing')}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

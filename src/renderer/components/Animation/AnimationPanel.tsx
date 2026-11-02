import { ArrowRight, Circle, Copy, Eraser, Eye, EyeOff, Layers, Minus, Pencil, Plus, Square, Download, Trash2, Triangle, Wand2 } from 'lucide-react';
import type { Clip } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useT } from '@renderer/i18n';
import { Step, Steps } from '@renderer/components/Common/Steps';
import { MAX_SIZE, MIN_SIZE, useDrawStore } from '@renderer/animation/drawStore';
import { celAt, exposureAt, exposureCount, frameOfExposure, MAX_ONION, MAX_STEP, stepOf, strokeCount } from '@renderer/animation/model';
import { nextDrawing } from '@renderer/animation/keys';
import { canTween, nextCelAfter } from '@renderer/animation/tween';
import { hasDrawings, toLottie } from '@renderer/animation/lottie';
import { notify } from '@renderer/notifications/notifications';
import { MAX_SIDES, MIN_SIDES, SHAPE_KINDS } from '@renderer/animation/shapes';
import { placeOf } from '@renderer/animation/motion';

/**
 * The 2D animation panel.
 *
 * Laid out as the three things that have to happen in order - make the clip,
 * draw on it, move on to the next drawing - because the first version showed
 * everything at once and gave no clue which came first. Everything beyond
 * those three folds away.
 *
 * The exposure sheet runs DOWN, as an X-sheet does in OpenToonz and as it has
 * on paper for a century, rather than across like the timeline. They are
 * different instruments: the timeline says where the clip sits in the film,
 * the sheet says where a drawing sits in the clip.
 *
 * What OpenToonz does and this deliberately does NOT is split the drawings of
 * a level (its Level Strip) from the order they play in (its Xsheet). It is
 * more powerful and it is the thing its own users ask about most often. One
 * sheet, where a drawing is made at the place it plays, answers the common
 * case without the lesson.
 */

const COLORS = ['#ffffff', '#0f172a', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#6366f1', '#ec4899'];

export function AnimationPanel(): JSX.Element {
  const t = useT();
  const clips = useProjectStore((state) => state.project.clips);
  const selected = useProjectStore((state) => state.ui.selectedClipIds);
  const currentFrame = useProjectStore((state) => state.project.currentFrame);
  const width = useProjectStore((state) => state.project.width);
  const height = useProjectStore((state) => state.project.height);
  const fps = useProjectStore((state) => state.project.fps);
  const addAnimationClip = useProjectStore((state) => state.addAnimationClip);
  const setAnimationStep = useProjectStore((state) => state.setAnimationStep);
  const setOnionSkin = useProjectStore((state) => state.setOnionSkin);
  const addAnimationLayer = useProjectStore((state) => state.addAnimationLayer);
  const removeAnimationLayer = useProjectStore((state) => state.removeAnimationLayer);
  const updateAnimationLayer = useProjectStore((state) => state.updateAnimationLayer);
  const clearCel = useProjectStore((state) => state.clearCel);
  const duplicateCel = useProjectStore((state) => state.duplicateCel);
  const addBlankCel = useProjectStore((state) => state.addBlankCel);
  const tweenFrom = useProjectStore((state) => state.tweenFrom);
  const setLayerKeyframe = useProjectStore((state) => state.setLayerKeyframe);
  const setLayerParent = useProjectStore((state) => state.setLayerParent);
  const seek = useProjectStore((state) => state.setCurrentFrame);

  const drawing = useDrawStore((state) => state.clipId);
  const mode = useDrawStore((state) => state.mode);
  const tool = useDrawStore((state) => state.tool);
  const sides = useDrawStore((state) => state.sides);
  const brush = useDrawStore((state) => state.brush);
  const color = useDrawStore((state) => state.color);
  const size = useDrawStore((state) => state.size);
  const activeLayer = useDrawStore((state) => state.layerId);
  const pick = useDrawStore((state) => state.pick);
  const start = useDrawStore((state) => state.start);
  const stop = useDrawStore((state) => state.stop);

  // The selected animation clip, or the only one there is: choosing which clip
  // to draw on should not be a step of its own when there is no choice.
  const animClips = Object.values(clips).filter((clip): clip is Clip => Boolean(clip.anim));
  const clip = animClips.find((candidate) => selected.includes(candidate.id)) ?? (animClips.length === 1 ? animClips[0] : undefined);
  const anim = clip?.anim;

  const makeOne = (): void => {
    const id = addAnimationClip();
    // Made to be drawn on: the brush is in hand straight away, so the step
    // after this one is already live.
    start(id);
  };

  /* Nothing yet: say what to do, rather than what is missing. --------------- */
  if (!clip || !anim) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <span className="text-xs font-medium text-slate-200">{t('animation.title')}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <span aria-hidden className="grid h-12 w-12 place-items-center rounded-xl bg-white/5 text-slate-300 ring-1 ring-white/10">
            <Pencil size={22} />
          </span>
          <p data-testid="animation-empty" className="text-xs text-slate-300">
            {animClips.length > 0 ? t('animation.selectClip') : t('animation.startHere')}
          </p>
          {/* One thing to press, and it is the first step. */}
          <button
            type="button"
            data-testid="animation-add"
            onClick={makeOne}
            className="flex items-center gap-1.5 rounded-control bg-cyan-500/20 px-3 py-2 text-xs text-cyan-100 ring-1 ring-cyan-400/40 hover:bg-cyan-500/30"
          >
            <Plus size={14} />
            {t('animation.add')}
          </button>
          <ol className="mt-1 space-y-1 text-left text-[10px] leading-relaxed text-slate-500">
            <li>1. {t('animation.how1')}</li>
            <li>2. {t('animation.how2')}</li>
            <li>3. {t('animation.how3')}</li>
          </ol>
        </div>
      </div>
    );
  }

  const step = stepOf(anim);
  const count = exposureCount(anim, clip);
  const here = exposureAt(anim, clip, currentFrame);
  const onion = anim.onion;
  const layerId = activeLayer ?? anim.layers[anim.layers.length - 1]?.id ?? null;
  const on = drawing === clip.id;
  const chosen = anim.layers.find((entry) => entry.id === layerId);
  const at = placeOf(chosen?.motion, currentFrame);
  const placeNow = { position: { x: at.x, y: at.y }, scale: { x: at.scaleX, y: at.scaleY }, rotation: at.rotation };
  const drawn = strokeCount(anim);
  const ownCel = chosen?.cels.find((cel) => cel.at === here);

  const saveLottie = async (): Promise<void> => {
    const made = toLottie(anim, clip, width, height, fps);
    const path = await window.filmora?.animSaveLottie?.(`${clip.name}.json`, made.json);
    if (!path) return;
    // Said out loud rather than silently: an eraser cannot be expressed in
    // Lottie in a way every player honours, so those strokes are left out.
    notify(made.dropped > 0 ? t('animation.lottieDropped', { count: made.dropped }) : t('animation.lottieSaved'), made.dropped > 0 ? 'warning' : 'success');
  };
  // The step the eye should be on: the first one not finished. Only that one
  // opens by itself - two open at once is what made the first version read as
  // a wall of controls again.
  const twoDone = drawn > 0;
  const threeDone = (chosen?.cels.length ?? 0) > 1;
  // What is open, and it is not simply "the first unfinished one".
  //
  // Step 2 stays open while the brush is in hand: a first stroke marks it
  // done, and folding the tools away the moment one line is drawn takes them
  // off the screen in the middle of the work. Step 3 opens as soon as there
  // is anything drawn, because Next drawing is the button that actually makes
  // an animation and hiding it while drawing is exactly backwards.
  //
  // Before a single stroke, only step 2 is open - which is the whole point:
  // one thing to do, and it is the next one.
  const openTwo = on || !twoDone;
  const openThree = twoDone;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <span className="text-xs font-medium text-slate-200">{t('animation.title')}</span>
        <button
          type="button"
          data-testid="animation-add"
          onClick={makeOne}
          className="flex items-center gap-1 rounded-control bg-white/5 px-2 py-1 text-2xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
        >
          <Plus size={12} />
          {t('animation.add')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <Steps>
          {/* 1 ------------------------------------------------------------- */}
          <Step number={1} title={t('animation.step1')} hint={t('animation.step1Hint')} done summary={clip.name} testId="animation-step-1">
            <p className="text-2xs text-slate-400">{t('animation.step1Done', { name: clip.name })}</p>
          </Step>

          {/* 2 ------------------------------------------------------------- */}
          <Step
            number={2}
            title={t('animation.step2')}
            hint={t('animation.step2Hint')}
            done={twoDone}
            open={openTwo}
            summary={t('animation.strokes', { count: drawn })}
            testId="animation-step-2"
          >
            {/* Draw it, or move what is drawn. Two jobs, and the pointer can
                only do one at a time. */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="animation-mode-draw"
                aria-pressed={mode === 'draw'}
                onClick={() => pick({ mode: 'draw' })}
                className={`flex-1 rounded-control px-2 py-1 text-2xs ring-1 ${mode === 'draw' ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
              >
                {t('animation.modeDraw')}
              </button>
              <button
                type="button"
                data-testid="animation-mode-animate"
                aria-pressed={mode === 'animate'}
                onClick={() => { pick({ mode: 'animate' }); if (!on) start(clip.id, layerId); }}
                className={`flex-1 rounded-control px-2 py-1 text-2xs ring-1 ${mode === 'animate' ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
              >
                {t('animation.modeAnimate')}
              </button>
            </div>
            {mode === 'animate' && <p className="text-[10px] leading-relaxed text-slate-500">{t('animation.animateHint')}</p>}
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
                {on ? t('animation.drawing') : t('animation.draw')}
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

            {/* Freehand, or a shape dragged out. A shape becomes an ordinary
                stroke, so the eraser, undo and everything else work on it. */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid="animation-tool-freehand"
                aria-pressed={tool === 'freehand'}
                title={t('animation.freehand')}
                onClick={() => pick({ tool: 'freehand' })}
                className={`flex-1 rounded-control px-1.5 py-1 ring-1 ${tool === 'freehand' ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
              >
                <Pencil size={11} className="mx-auto" />
              </button>
              {SHAPE_KINDS.map((kind) => {
                const Icon = kind === 'line' ? Minus : kind === 'rectangle' ? Square : kind === 'ellipse' ? Circle : Triangle;
                return (
                  <button
                    key={kind}
                    type="button"
                    data-testid={`animation-tool-${kind}`}
                    aria-pressed={tool === kind}
                    title={t(`animation.shape.${kind}`)}
                    onClick={() => pick({ tool: kind })}
                    className={`flex-1 rounded-control px-1.5 py-1 ring-1 ${tool === kind ? 'bg-white/15 text-white ring-white/20' : 'bg-white/5 text-slate-400 ring-white/10'}`}
                  >
                    <Icon size={11} className="mx-auto" />
                  </button>
                );
              })}
            </div>
            {tool === 'polygon' && (
              <label className="flex items-center gap-2 text-2xs text-slate-400">
                <span className="w-14 shrink-0">{t('animation.sides')}</span>
                <input
                  type="number"
                  data-testid="animation-sides"
                  min={MIN_SIDES}
                  max={MAX_SIDES}
                  value={sides}
                  onChange={(event) => pick({ sides: Number(event.target.value) })}
                  className="w-14 rounded-control bg-white/5 px-1.5 py-1 text-2xs text-slate-200 ring-1 ring-white/10"
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-2xs text-slate-400">
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

            <div className="flex flex-wrap items-center gap-1.5">
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

            <p data-testid="animation-keys" className="text-[10px] leading-relaxed text-slate-500">
              {t('animation.keys')}
            </p>
          </Step>

          {/* 3 ------------------------------------------------------------- */}
          <Step
            number={3}
            title={t('animation.step3')}
            hint={t('animation.step3Hint')}
            done={threeDone}
            open={openThree}
            summary={t('animation.drawings', { count: chosen?.cels.length ?? 0 })}
            testId="animation-step-3"
          >
            {/* The one button that moves the work on: go to the next exposure,
                ready for the next drawing. */}
            <button
              type="button"
              data-testid="animation-next-drawing"
              onClick={() => seek(frameOfExposure(anim, clip, Math.min(count - 1, nextDrawing(anim, clip, chosen, here))))}
              className="flex w-full items-center justify-center gap-1.5 rounded-control bg-cyan-500/15 px-2 py-1.5 text-2xs text-cyan-100 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25"
            >
              <ArrowRight size={12} />
              {t('animation.nextDrawing')}
            </button>

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

            {/* In-betweens: only offered when the two drawings correspond,
                because two that do not cannot be blended into anything but a
                smear. The reason is said out loud when they do not. */}
            {nextCelAfter(chosen ?? anim.layers[anim.layers.length - 1], here) !== null && (
              <button
                type="button"
                data-testid="animation-tween"
                disabled={!canTween(chosen, here)}
                title={canTween(chosen, here) ? undefined : t('animation.tweenWhy')}
                onClick={() => tweenFrom(clip.id, layerId ?? '', here)}
                className="flex w-full items-center justify-center gap-1.5 rounded-control bg-white/5 px-2 py-1.5 text-2xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
              >
                <Wand2 size={12} />
                {t('animation.tween')}
              </button>
            )}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="animation-new-drawing"
                onClick={() => addBlankCel(clip.id, layerId ?? '', here)}
                disabled={Boolean(ownCel)}
                className="flex-1 rounded-control bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
              >
                {t('animation.newDrawing')}
              </button>
              <button
                type="button"
                data-testid="animation-duplicate-here"
                onClick={() => duplicateCel(clip.id, layerId ?? '', here)}
                disabled={Boolean(ownCel)}
                className="flex-1 rounded-control bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
              >
                {t('animation.duplicateDrawing')}
              </button>
            </div>

            {/* The sheet itself: a drawing of its own is a filled mark, a held
                one a line continuing down, as an X-sheet shows a hold. */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-2xs text-slate-300">{t('animation.sheet')}</span>
              <span data-testid="animation-counts" className="text-[10px] text-slate-500">
                {t('animation.strokes', { count: drawn })}
              </span>
            </div>
            <ol data-testid="animation-sheet" className="flex max-h-56 flex-col overflow-y-auto">
              {Array.from({ length: count }, (_, exposure) => {
                const layer = chosen ?? anim.layers[anim.layers.length - 1];
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
                      <span
                        aria-hidden
                        className={own ? 'h-2 w-2 rounded-full bg-cyan-300' : held ? 'h-3 w-px bg-slate-600' : 'h-2 w-2 rounded-full ring-1 ring-white/15'}
                      />
                      <span className="truncate">{own ? t('animation.strokes', { count: own.strokes.length }) : ''}</span>
                    </button>
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
                  </li>
                );
              })}
            </ol>
          </Step>
        </Steps>

        {/* Everything beyond the three steps, folded. ---------------------- */}
        <details className="mt-2 rounded-control bg-panel-900/60 px-2 py-1" data-testid="animation-more">
          <summary className="cursor-pointer text-2xs text-slate-400">{t('animation.more')}</summary>

          <section className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
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
                <div className="flex items-center gap-2">
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
                <label className="flex items-center gap-2 text-2xs text-slate-400">
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
                <p className="text-[10px] leading-relaxed text-slate-500">{t('animation.onionHint')}</p>
              </>
            )}
          </section>

          <section className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
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
            <ul className="flex flex-col gap-1">
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
            <label className="flex items-center gap-2 text-2xs text-slate-400">
              <span className="w-14 shrink-0">{t('animation.opacity')}</span>
              <input
                type="range"
                data-testid="animation-layer-opacity"
                min={5}
                max={100}
                value={Math.round((chosen?.opacity ?? 1) * 100)}
                onChange={(event) => layerId && updateAnimationLayer(clip.id, layerId, { opacity: Number(event.target.value) / 100 })}
                className="flex-1"
              />
            </label>
          </section>

          {/* Cut-out: the layer moved as a whole, with the keyframes the rest of
              the app already uses. A key is written at the playhead. */}
          <section className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
            <span className="text-2xs text-slate-300">{t('animation.cutout')}</span>
            <p className="text-[10px] leading-relaxed text-slate-500">{t('animation.cutoutHint')}</p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="animation-key-position"
                onClick={() => layerId && setLayerKeyframe(clip.id, layerId, 'position', currentFrame, placeNow.position)}
                className="flex-1 rounded-control bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                {t('animation.keyPosition')}
              </button>
              <button
                type="button"
                data-testid="animation-key-scale"
                onClick={() => layerId && setLayerKeyframe(clip.id, layerId, 'scale', currentFrame, placeNow.scale)}
                className="flex-1 rounded-control bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                {t('animation.keyScale')}
              </button>
              <button
                type="button"
                data-testid="animation-key-rotation"
                onClick={() => layerId && setLayerKeyframe(clip.id, layerId, 'rotation', currentFrame, placeNow.rotation)}
                className="flex-1 rounded-control bg-white/5 px-1.5 py-1 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                {t('animation.keyRotation')}
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="flex flex-1 items-center gap-1 text-[10px] text-slate-500">
                X
                <input
                  type="number"
                  data-testid="animation-move-x"
                  step={0.01}
                  value={Number(placeNow.position.x.toFixed(3))}
                  onChange={(event) => layerId && setLayerKeyframe(clip.id, layerId, 'position', currentFrame, { x: Number(event.target.value), y: placeNow.position.y })}
                  className="w-full min-w-0 rounded-control bg-white/5 px-1 py-0.5 text-slate-200 ring-1 ring-white/10"
                />
              </label>
              <label className="flex flex-1 items-center gap-1 text-[10px] text-slate-500">
                Y
                <input
                  type="number"
                  data-testid="animation-move-y"
                  step={0.01}
                  value={Number(placeNow.position.y.toFixed(3))}
                  onChange={(event) => layerId && setLayerKeyframe(clip.id, layerId, 'position', currentFrame, { x: placeNow.position.x, y: Number(event.target.value) })}
                  className="w-full min-w-0 rounded-control bg-white/5 px-1 py-0.5 text-slate-200 ring-1 ring-white/10"
                />
              </label>
              <label className="flex flex-1 items-center gap-1 text-[10px] text-slate-500">
                °
                <input
                  type="number"
                  data-testid="animation-move-rotation"
                  step={1}
                  value={Number(placeNow.rotation.toFixed(1))}
                  onChange={(event) => layerId && setLayerKeyframe(clip.id, layerId, 'rotation', currentFrame, Number(event.target.value))}
                  className="w-full min-w-0 rounded-control bg-white/5 px-1 py-0.5 text-slate-200 ring-1 ring-white/10"
                />
              </label>
            </div>
            {anim.layers.length > 1 && (
              <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <span className="shrink-0">{t('animation.parent')}</span>
                <select
                  data-testid="animation-parent"
                  value={chosen?.parentId ?? ''}
                  onChange={(event) => layerId && setLayerParent(clip.id, layerId, event.target.value || null)}
                  className="min-w-0 flex-1 rounded-control bg-white/5 px-1.5 py-0.5 text-slate-200 ring-1 ring-white/10"
                >
                  <option value="">{t('animation.parentNone')}</option>
                  {anim.layers
                    .filter((entry) => entry.id !== layerId)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </section>

          {/* Out as Lottie: the payment for keeping strokes as data rather
              than pixels. After Effects, Figma, a web page or a phone can all
              read it, and it scales because it is shapes and not an image. */}
          <section className="mt-2 space-y-1.5 border-t border-white/5 pt-2">
            <span className="text-2xs text-slate-300">{t('animation.lottie')}</span>
            <p className="text-[10px] leading-relaxed text-slate-500">{t('animation.lottieHint')}</p>
            <button
              type="button"
              data-testid="animation-lottie"
              disabled={!hasDrawings(anim)}
              onClick={() => void saveLottie()}
              className="flex w-full items-center justify-center gap-1.5 rounded-control bg-white/5 px-2 py-1.5 text-2xs text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            >
              <Download size={12} />
              {t('animation.lottieSave')}
            </button>
          </section>
        </details>
      </div>
    </div>
  );
}

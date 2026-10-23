import type { ExportSettings } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { getActiveFrameRenderer } from '@renderer/engine/FrameRenderer';
import { streamTimelineAudio } from '@renderer/audio/renderMix';
import { buildAsset } from '@renderer/media/importMedia';
import { notify, dismissNotification } from '@renderer/notifications/notifications';
import { recommendedAudioBitrateKbps, recommendedBitrateKbps } from '@shared/utils/bitrate';
import { t } from '@renderer/i18n';
import { canCompound, compoundSpan, subsetProject } from './compound';

/**
 * Making a compound clip: the chosen clips rendered together, exactly as the
 * export draws them - over transparency, so what is not covered stays see-
 * through (VP9 with alpha, which the viewer plays; ProRes it cannot) - with
 * their sound mixed in, into a file in the app's folder; then that file put in their place as one clip that keeps them
 * (edit/compound.ts). One undo step for the swap.
 */

export async function makeCompound(clipIds: readonly string[]): Promise<string | null> {
  const { project, assets } = useProjectStore.getState();
  const renderer = getActiveFrameRenderer();
  if (!renderer || !canCompound(project, clipIds) || !window.filmora?.compoundTarget) return null;
  const clips = clipIds.map((id) => project.clips[id]).filter(Boolean);
  const span = compoundSpan(clips);
  const subset = subsetProject(project, clipIds);
  const waiting = notify(t('compound.making', { count: clips.length }), 'info', { persistent: true });
  let jobId: string | null = null;
  try {
    const target = await window.filmora.compoundTarget();
    // The sound of the clips, mixed as the export mixes it.
    const mixPath = await window.filmora.exportAudioOpen();
    const mix = await streamTimelineAudio(subset, assets, span.from, span.to, (samples) => window.filmora.exportAudioAppend(mixPath, samples.buffer as ArrayBuffer)).catch(() => null);
    await window.filmora.exportAudioClose(mixPath, mix === null);
    const settings: ExportSettings = {
      format: 'webm-vp9',
      outputPath: target,
      width: project.width,
      height: project.height,
      fps: project.fps,
      startFrame: span.from,
      endFrame: span.to,
      exportAlpha: true,
      premultiplyAlpha: false,
      pixelArtScaling: false,
      // Twice the export's: it is decoded again, and drawn again, before it is delivered.
      bitrateKbps: recommendedBitrateKbps(project.width, project.height, project.fps) * 2,
      hardwareEncoder: 'none',
      pipeMode: 'rawvideo',
      ...(mix ? { audioPath: mixPath, audioRawFormat: { sampleRate: mix.sampleRate, channels: mix.channels }, audioBitrateKbps: recommendedAudioBitrateKbps(mix.channels) } : {}),
    };
    const started = await window.filmora.exportStart(settings);
    jobId = started.jobId;
    renderer.beginExclusive();
    renderer.startSequentialDecode();
    try {
      await renderer.ensureLUTs(subset);
      for (let frame = span.from; frame < span.to; frame += 1) {
        const rgba = await renderer.renderExact(subset, frame, false);
        await window.filmora.exportFrame(jobId, rgba.buffer as ArrayBuffer);
      }
    } finally {
      renderer.stopSequentialDecode();
      renderer.endExclusive();
    }
    await window.filmora.exportFinish(jobId);
    jobId = null;

    const count = Object.values(useProjectStore.getState().project.clips).filter((clip) => clip.compound).length + 1;
    const name = `${t('compound.name')} ${count}`;
    const asset = await buildAsset({ name: `${name}.webm`, uri: await window.filmora.mediaUrl(target), sourcePath: target, hasAudio: Boolean(mix) }, project.fps);
    const mark = useHistoryStore.getState().undoStack.length;
    useProjectStore.getState().addAssets([asset]);
    const added = useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === target) ?? asset;
    const clipId = useProjectStore.getState().replaceWithCompound(clipIds, added.uri, name);
    useHistoryStore.getState().squash(mark, 'Make compound clip');
    if (clipId) notify(t('compound.made', { count: clips.length }), 'success');
    return clipId;
  } catch (error) {
    if (jobId) await window.filmora.exportCancel(jobId).catch(() => undefined);
    notify(t('compound.failed', { detail: error instanceof Error ? error.message : String(error) }), 'error');
    return null;
  } finally {
    dismissNotification(waiting);
  }
}

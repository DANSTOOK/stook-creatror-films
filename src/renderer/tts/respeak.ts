import type { ClipSpeech } from '@shared/types';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { useHistoryStore } from '@renderer/store/useHistoryStore';
import { generate, voiceTrackFor, type TtsOptions } from './speak';

/**
 * Saying a voice clip again, with the words or the voice changed.
 *
 * The clip kept what it was asked to say (`Clip.speech`), so the inspector can
 * put the script back in front of you and this can make it again - which is
 * what Clipchamp does and what the panel alone could not: before this, a voice
 * you did not like could only be deleted and the script retyped.
 *
 * The order of the three steps is the whole design:
 *
 *  1. The voice is MADE first, while nothing on the timeline has been touched.
 *     A failure or a cancel then leaves the edit exactly as it was, rather than
 *     having taken away the voice that was there and put nothing in its place.
 *  2. The old clip is REMOVED next, before a track is chosen - because the
 *     track is chosen by what is free, and with the old clip still sitting
 *     there the new voice would be sent to a different row and leave an empty
 *     track behind it.
 *  3. Only then is the new voice placed, at the same frame.
 *
 * All of it is squashed into one undo step, so one Ctrl+Z puts the old voice
 * back, words and all.
 *
 * What it does NOT keep: a trim. The clip is made afresh, so one that had been
 * cut short comes back whole. And captions are not remade: captions are their
 * own clips once made, and a second set appearing quietly would be worse than
 * none.
 */
export async function respeakClip(
  clipId: string,
  speech: ClipSpeech,
  onProgress?: (fraction: number) => void,
  jobId?: string,
): Promise<string | null> {
  const clip = useProjectStore.getState().project.clips[clipId];
  if (!clip || !speech.text.trim()) return null;
  const startFrame = clip.startFrame;
  const options: TtsOptions = {
    language: speech.language,
    voice: speech.voice,
    speed: speech.speed,
    pitch: speech.pitch,
    enhance: speech.enhance,
    captions: false,
    effect: speech.effect as TtsOptions['effect'],
  };

  const made = await generate(speech.text, options, speech.voice, onProgress, jobId);
  if (!made) return null;

  const mark = useHistoryStore.getState().undoStack.length;
  useProjectStore.getState().removeClips([clipId]);
  useProjectStore.getState().addAssets([made.asset]);
  const asset =
    useProjectStore.getState().assets.find((candidate) => candidate.sourcePath === made.asset.sourcePath) ?? made.asset;
  const fps = useProjectStore.getState().project.fps;
  const length = Math.max(1, Math.round(made.seconds * fps));
  const trackId = voiceTrackFor(startFrame, startFrame + length);
  const newId = useProjectStore.getState().addAssetToTimeline(asset, trackId, startFrame);
  if (newId) {
    useProjectStore.getState().updateClip(newId, { speech: { ...speech } });
  }
  useHistoryStore.getState().squash(mark, 'Say it again');
  if (newId) useProjectStore.getState().setUi({ selectedClipIds: [newId] });
  return newId;
}

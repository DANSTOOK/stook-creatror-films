import type { CaptionContent, CaptionWord, Clip, ProjectState } from '@shared/types';
import type { FrameRange } from './silences';
import { speedOf } from '@renderer/timing/clipSpeed';

/**
 * Filler words out of a talking clip - the "eh", "em", "um" and "uh" between
 * the words that matter - found in its captions, which know when each word
 * was said, as Descript's and CapCut's "remove filler words" do. The words'
 * moments are cut out of the clip (and its linked sound), what follows
 * closing up, and the words leave the captions' text; the captions follow
 * the edit as they always do (captions/follow.ts). Only sounds that are
 * never words are taken: "este", "like" or "so" can be words, and stay.
 */

const FILLERS = new Set([
  // Spanish
  'eh', 'ehh', 'ehhh', 'ehm', 'ehmm', 'em', 'emm', 'emmm', 'mm', 'mmm', 'mmmm', 'hmm', 'hm', 'ah', 'ahh', 'ahm', 'mhm',
  // English
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'uhmm', 'er', 'erm', 'ehrm',
]);

/** A word, bare: lower case, without punctuation around it. */
const bare = (text: string): string => text.toLocaleLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');

export const isFiller = (text: string): boolean => FILLERS.has(bare(text));

/** Where a caption's word is on the timeline, in frames. */
function wordFrames(caption: Clip, word: CaptionWord, fps: number): FrameRange {
  const speed = speedOf(caption);
  return {
    from: caption.startFrame + (word.start * fps - caption.sourceOffsetFrames) / speed,
    to: caption.startFrame + (word.end * fps - caption.sourceOffsetFrames) / speed,
  };
}

export interface FillerPlan {
  /** Timeline frames to cut out of the clip, in order, merged where they touch. */
  ranges: FrameRange[];
  /** How many filler words. */
  count: number;
  /** The captions' content with the fillers taken out, by caption id. */
  captions: Map<string, CaptionContent>;
}

/** The fillers said in clip `clipId`, from the captions that follow it. */
export function fillerPlan(project: ProjectState, clipId: string): FillerPlan {
  const clip = project.clips[clipId];
  const empty: FillerPlan = { ranges: [], count: 0, captions: new Map() };
  if (!clip) return empty;
  const end = clip.startFrame + clip.durationFrames;
  const ranges: FrameRange[] = [];
  const captions = new Map<string, CaptionContent>();
  let count = 0;
  for (const caption of Object.values(project.clips)) {
    const content = caption.caption;
    if (!content?.words?.length || content.link?.clipId !== clipId) continue;
    const kept: CaptionWord[] = [];
    let dropped = 0;
    for (const word of content.words) {
      if (!isFiller(word.text)) {
        kept.push(word);
        continue;
      }
      const span = wordFrames(caption, word, project.fps);
      // A frame either side, so no half of the sound is left; never past the clip.
      const from = Math.max(clip.startFrame, Math.floor(span.from) - 1);
      const to = Math.min(end, Math.ceil(span.to) + 1);
      if (to <= from) continue;
      ranges.push({ from, to });
      dropped += 1;
    }
    if (dropped === 0) continue;
    count += dropped;
    const text = kept.map((word) => word.text).join(' ').replace(/\s+([,.;:!?…])/g, '$1').trim();
    captions.set(caption.id, { ...content, words: kept, text, manualBreaks: false });
  }
  ranges.sort((a, b) => a.from - b.from);
  const merged: FrameRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return { ranges: merged, count, captions };
}

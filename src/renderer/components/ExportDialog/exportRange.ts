import type { ProjectState } from '@shared/types';
import { projectContentLength } from '@renderer/components/Timeline/timelineOps';

/**
 * Where an export ends by default: at the end of the last clip.
 *
 * The timeline keeps a second of room after its content so there is somewhere
 * to drop the next clip, and the export used to render that too - every file
 * the user made ended in a second of black (19:28.7 from 19:27.7 of footage).
 * The room is for editing, not for the film.
 *
 * A project with no clips has no content end; it falls back to the timeline
 * length rather than offering to render nothing.
 */
export function exportEndFrame(project: Pick<ProjectState, 'clips' | 'durationFrames'>): number {
  const content = projectContentLength(project as ProjectState);
  return content > 0 ? content : project.durationFrames;
}

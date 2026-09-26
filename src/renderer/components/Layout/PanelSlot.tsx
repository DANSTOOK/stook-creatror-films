import { useState, type ReactNode } from 'react';
import { useExitGhost } from '@renderer/motion/ghost';

/**
 * What an area of the editor (media, inspector, timeline) shows while it is
 * open, and how it comes and goes.
 *
 * The content is only mounted while the area is open - its width goes to the
 * picture the moment it is put away, and the interface tests count exactly
 * that. So the layout itself changes at once (the viewer is a WebGL surface:
 * growing it frame by frame would mean re-rendering it at every size), and
 * the motion is on the content: it slides in from the edge it belongs to, and
 * slides back out that way as a ghost (motion/ghost.ts) when it is hidden.
 * While the video plays or a render runs, both happen at once.
 *
 * The editor's first layout does not slide: nothing was opened, it was there.
 */

let editorShown = false;

/** Called once the editor has painted its first layout (App). */
export function markEditorShown(): void {
  editorShown = true;
}

const EXIT = { left: 'slide-left', right: 'slide-right', bottom: 'slide-down' } as const;

export function PanelSlot({
  edge,
  className,
  children,
}: {
  edge: 'left' | 'right' | 'bottom';
  className: string;
  children: ReactNode;
}): JSX.Element {
  // Decided once, as it mounts: opened by the user, or part of the first layout.
  const [enters] = useState(() => editorShown);
  const ref = useExitGhost<HTMLDivElement>(EXIT[edge]);
  return (
    <div ref={ref} data-edge={edge} className={`${className} ${enters ? 'scf-panel-enter' : ''}`}>
      {children}
    </div>
  );
}

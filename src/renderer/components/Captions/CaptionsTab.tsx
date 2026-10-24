import { useEffect, useState } from 'react';
import { TranscriptPanel } from './TranscriptPanel';
import { GenerateCaptionsForm } from './GenerateCaptionsDialog';

/**
 * The library's Captions tab: the transcript, and - when asked for, from the
 * menu, the timeline or the tab's own button - the form that generates
 * captions from the sound, in its place, as CapCut's captions panel has it.
 * Generating or cancelling brings the transcript back.
 */

export const OPEN_CAPTIONS_FORM = 'scf:open-captions-form';

/** Asked for while the tab was not there to hear it: shown when it comes. */
let pending = false;

export function openCaptionsForm(): void {
  pending = true;
  window.dispatchEvent(new Event(OPEN_CAPTIONS_FORM));
}

export function CaptionsTab(): JSX.Element {
  const [form, setForm] = useState(() => {
    const asked = pending;
    pending = false;
    return asked;
  });
  useEffect(() => {
    const open = (): void => {
      pending = false;
      setForm(true);
    };
    window.addEventListener(OPEN_CAPTIONS_FORM, open);
    return () => window.removeEventListener(OPEN_CAPTIONS_FORM, open);
  }, []);
  return form ? <GenerateCaptionsForm onClose={() => setForm(false)} /> : <TranscriptPanel />;
}

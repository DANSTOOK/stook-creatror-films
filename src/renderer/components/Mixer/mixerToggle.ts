import { create } from 'zustand';

/**
 * Whether the mixer is open, for the buttons that open it away from where it
 * is kept (App owns it, with what it remembers): the timeline's Mixer
 * button reads it here and asks for a change with an event.
 */
export const useMixerOpen = create<{ open: boolean }>(() => ({ open: false }));

export const MIXER_TOGGLE_EVENT = 'scf:toggle-mixer';

export function toggleMixer(): void {
  window.dispatchEvent(new Event(MIXER_TOGGLE_EVENT));
}

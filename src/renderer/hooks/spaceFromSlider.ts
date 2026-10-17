/**
 * Space pressed on a slider in the editor: play and pause.
 *
 * The editor's shortcuts leave keys alone while a field has the focus, so as
 * not to steal what is being typed. A slider is not typed into, and has no
 * use for Space - but it keeps the focus after it is clicked or dragged, so
 * every Space after touching opacity, volume or a fader was swallowed and
 * the playhead would not start. Space on a slider goes to the transport
 * instead; a slider in a dialog keeps it, since a dialog is not the editor.
 *
 * Read by tag and type rather than `instanceof`, so it holds for a slider in
 * a panel's own window too (Layout/PanelWindow), whose elements belong to
 * that window's classes.
 */
export function spaceFromSlider(event: Pick<KeyboardEvent, 'key' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  const target = event.target as (HTMLInputElement & { closest?: (selector: string) => Element | null }) | null;
  return (
    event.key === ' ' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    target?.tagName === 'INPUT' &&
    target.type === 'range' &&
    !target.closest?.('[aria-modal="true"]')
  );
}

import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Keep the caret where it is when the text under it is laid out again.
 *
 * A caption's lines are re-flowed as it is typed (rules.reflowText), so the
 * value React writes back differs from what was typed - a space became a
 * line break - and the browser answers a changed value by sending the caret
 * to the end. The re-flow only swaps spaces and breaks, one for one, so the
 * caret belongs at the same count of characters: remembered at the
 * keystroke, put back once the new value is in.
 *
 * Returns the function to call from `onChange`, before the value is sent on.
 */
export function useKeptCaret(ref: RefObject<HTMLTextAreaElement>, value: string): () => void {
  const wanted = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const at = wanted.current;
    wanted.current = null;
    if (!element || at === null || document.activeElement !== element) return;
    const caret = Math.min(at, element.value.length);
    if (element.selectionStart !== caret || element.selectionEnd !== caret) element.setSelectionRange(caret, caret);
  }, [ref, value]);
  return () => {
    wanted.current = ref.current?.selectionStart ?? null;
  };
}

/** Whether a change to a textarea was Enter: the author breaking the line themselves. */
export const isLineBreakInput = (event: { nativeEvent: Event }): boolean => {
  const type = (event.nativeEvent as InputEvent).inputType;
  return type === 'insertLineBreak' || type === 'insertParagraph';
};

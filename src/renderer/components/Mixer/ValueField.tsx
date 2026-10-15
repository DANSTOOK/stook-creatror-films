import { useRef, useState } from 'react';

/**
 * A readout you can type into.
 *
 * The mixer could only be set by dragging faders, which is right for finding
 * a level by ear and wrong for setting one you already know. The numbers
 * under the faders are now fields: click, type "-6", press Enter.
 *
 * It shows exactly what the readout showed before - the same formatter - and
 * only becomes a draft while it has focus, so a fader moved elsewhere still
 * updates it. Enter and blur commit; Escape, or anything the parser refuses,
 * puts back the value that was there.
 */

export interface ValueFieldProps {
  /** For screen readers, since the printed value is the only visible label. */
  label: string;
  value: number;
  /** How the value reads when the field is not being typed into. */
  format(value: number): string;
  /** What a typed string means, or null when it means nothing. */
  parse(text: string): number | null;
  onCommit(value: number): void;
  className?: string;
  testId?: string;
}

export function ValueField({ label, value, format, parse, onCommit, className, testId }: ValueFieldProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  // Null unless the field is being typed into: a value changed elsewhere (a
  // fader, an undo) shows at once, and a draft belongs to whoever is typing.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    const text = draft;
    setDraft(null);
    if (text === null) return;
    const parsed = parse(text);
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      role="spinbutton"
      aria-label={label}
      aria-valuenow={value}
      aria-valuetext={format(value)}
      data-testid={testId}
      className={
        className ??
        'w-full rounded-control bg-transparent px-1 text-center text-2xs tabular-nums text-slate-300 ' +
          'hover:bg-panel-800 focus:bg-panel-950 focus:text-slate-100 focus:outline-none focus:ring-1 focus:ring-accent'
      }
      value={draft ?? format(value)}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          inputRef.current?.blur();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(null);
          inputRef.current?.blur();
        }
      }}
      spellCheck={false}
      autoComplete="off"
    />
  );
}

export default ValueField;

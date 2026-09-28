import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Clip } from '@shared/types';
import { useT } from '@renderer/i18n';
import { useProjectStore } from '@renderer/store/useProjectStore';
import { fontString } from '@renderer/text/fonts';
import type { TitleLayout } from '@renderer/text/layout';
import { TITLE_SAFE } from '@renderer/text/titleStyle';

/**
 * Typing into a title where it is, as Final Cut does on a double-click.
 *
 * The editable text is laid over the drawn title in the title's own space -
 * project pixels, with the same font, sizes, spacing, alignment and line
 * length - and carried onto the picture by the same matrix the compositor
 * uses. Its letters are transparent: what is seen is the real title, redrawn
 * as each key lands, with the caret and the selection on top.
 *
 * A contentEditable rather than a textarea because a lower third sets its
 * second line smaller than its first, and a textarea has one size.
 *
 * Every key stays here: none reaches the editor's shortcuts (Space does not
 * play, Delete does not delete the clip). Escape or Ctrl+Enter - or a click
 * elsewhere - finish, and the whole edit is one undo step.
 */

export interface TitleTextEditorProps {
  clip: Clip;
  layout: TitleLayout;
  frame: { width: number; height: number };
  /** Title pixels to picture pixels: CSS matrix() order, already in CSS pixels. */
  matrix: [number, number, number, number, number, number];
  onDone(): void;
}

/** The lines a contentEditable holds, the way Chrome lays them out. */
export function readLines(root: HTMLElement): string[] {
  const lines = [''];
  // After a block ends, whatever comes next starts a line of its own.
  let pending = false;
  const newLineIfNeeded = (): void => {
    if (pending) {
      lines.push('');
      pending = false;
    }
  };
  const visit = (node: Node): void => {
    node.childNodes.forEach((child, index) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (text === '') return;
        newLineIfNeeded();
        lines[lines.length - 1] += text;
        return;
      }
      if (child.nodeName === 'BR') {
        // The last <br> of a block (or of the whole thing) holds an empty line
        // open; it is not a line of its own.
        if (index === node.childNodes.length - 1) return;
        newLineIfNeeded();
        lines.push('');
        return;
      }
      if (child.nodeName === 'DIV' || child.nodeName === 'P') {
        // A block starts a line, unless the line it would start is still empty.
        if (pending || lines[lines.length - 1] !== '') lines.push('');
        pending = false;
        visit(child);
        pending = true;
        return;
      }
      visit(child);
    });
  };
  visit(root);
  return lines;
}

export function TitleTextEditor({ clip, layout, frame, matrix, onDone }: TitleTextEditorProps): JSX.Element | null {
  const t = useT();
  const updateTitle = useProjectStore((state) => state.updateTitle);
  const rootRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  /** One undo step for the whole edit, however many keys. */
  const mergeKey = useRef(`title:${clip.id}:viewer-edit:${Date.now()}`);

  const title = clip.title;
  const style = title?.style;
  const unit = frame.height / 1080;
  const firstSize = (style?.fontSize ?? 0) * unit;
  const otherSize = firstSize * (style?.secondaryScale ?? 1);

  /** Each line at its own size, as the renderer sets them. */
  const restyle = (root: HTMLElement): void => {
    if (!style) return;
    // Which line each block is: the first, unless text came before it.
    let line = -1;
    let textBefore = false;
    root.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE && child.textContent && line === -1) textBefore = true;
      if (child instanceof HTMLElement && (child.nodeName === 'DIV' || child.nodeName === 'P')) {
        line = line === -1 ? (textBefore ? 1 : 0) : line + 1;
        const size = line === 0 ? firstSize : otherSize;
        child.style.fontSize = `${size}px`;
        child.style.lineHeight = `${size * style.lineHeight}px`;
        child.style.letterSpacing = `${(style.letterSpacing / 100) * size}px`;
        child.style.minHeight = `${size * style.lineHeight}px`;
      }
    });
  };

  // The text goes in once, as the edit starts; from then on the element owns it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !title) return;
    root.replaceChildren(
      ...title.text.split(/\r?\n/).map((paragraph) => {
        const line = document.createElement('div');
        if (paragraph === '') line.appendChild(document.createElement('br'));
        else line.textContent = paragraph;
        return line;
      }),
    );
    restyle(root);
    root.focus();
    // Everything selected: typing replaces a template's words, arrows keep them.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(root);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Once, for this clip's edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id]);

  // The title gone from under the editor (deleted, undone): the edit is over.
  useEffect(() => {
    if (!title) doneRef.current();
  }, [title]);

  if (!title || !style) return null;

  const wrapWidth = Math.max(1, frame.width * TITLE_SAFE * style.maxWidth - (style.box.enabled ? style.box.padding * unit * 2 : 0));
  const block = layout.block;
  // Lines are aligned inside the line length, so the box sits where the
  // alignment puts the text's edge: its left, its middle or its right.
  const left =
    style.align === 'left' ? block.x : style.align === 'right' ? block.x + block.width - wrapWidth : block.x + block.width / 2 - wrapWidth / 2;
  // CSS pixels per title pixel, to draw the outline a constant width on screen.
  const cssPerPx = Math.max(1e-6, Math.hypot(matrix[0], matrix[1]));
  const family = fontString(style.fontFamily, style.fontWeight, firstSize).replace(/^\d+ [\d.]+px /, '');

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here is an editor shortcut.
    event.stopPropagation();
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      doneRef.current();
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      // A line break is a new line, the one kind the title knows.
      event.preventDefault();
      document.execCommand('insertParagraph');
    }
  };

  const layer: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: frame.width,
    height: frame.height,
    transformOrigin: '0 0',
    transform: `matrix(${matrix.join(',')})`,
    pointerEvents: 'none',
  };

  return (
    <div className="absolute inset-0 overflow-visible" data-testid="title-editor-layer">
      <div style={layer}>
        <div
          ref={rootRef}
          role="textbox"
          aria-multiline="true"
          aria-label={t('title.editInViewer')}
          data-testid="title-editor"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          onKeyDown={onKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
          onPaste={(event) => {
            // Plain text only: a title has no formatting to paste into.
            event.preventDefault();
            document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
          }}
          onInput={(event) => {
            const root = event.currentTarget;
            restyle(root);
            updateTitle(clip.id, { text: readLines(root).join('\n') }, mergeKey.current);
          }}
          onBlur={() => doneRef.current()}
          style={{
            position: 'absolute',
            left,
            top: block.y,
            width: wrapWidth,
            minHeight: firstSize * style.lineHeight,
            fontFamily: family,
            fontWeight: style.fontWeight,
            fontSize: firstSize,
            fontKerning: 'normal',
            textAlign: style.align,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            // The drawn title shows through; only the caret and selection are ours.
            color: 'transparent',
            caretColor: '#ffffff',
            outline: `${1.5 / cssPerPx}px dashed rgba(96, 165, 250, 0.9)`,
            outlineOffset: 4 / cssPerPx,
            pointerEvents: 'auto',
            cursor: 'text',
            userSelect: 'text',
          }}
        />
      </div>
    </div>
  );
}

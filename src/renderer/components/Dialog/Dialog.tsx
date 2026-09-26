import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { useT } from '@renderer/i18n';

/**
 * The one dialog.
 *
 * Every modal in the editor used to build its own frame, and each got a
 * different subset of the basics: the export dialog had role="dialog", the
 * speed dialog had nothing - not even Escape - the mixer and project settings
 * were closed by a listener in App, and none of them kept the keyboard inside
 * or gave focus back when they closed. This is the frame they all share:
 *
 * - role="dialog" (or "alertdialog"), aria-modal, and a name from its title;
 * - Escape closes it - the topmost one only, and nothing behind it hears the
 *   key - unless it is not `dismissible` (an export mid-render);
 * - Tab and Shift+Tab stay inside, and focus returns to whatever had it
 *   before, as the WAI-ARIA dialog pattern asks;
 * - a 15px sentence-case title, and a footer with the buttons on the right:
 *   Cancel (or Close), then the primary action last, as Windows and the
 *   Apple HIG both order them.
 *
 * The root keeps the `panel` class the interface tests find dialogs by.
 */

export interface DialogProps {
  title: string;
  icon?: LucideIcon;
  onClose(): void;
  /** Playing its exit animation; see usePresence. */
  closing?: boolean;
  /** Escape and the close button work. False while closing would lose work. */
  dismissible?: boolean;
  /** The ✕ in the title bar. Off where the dialog has its own Close button up there. */
  showCloseButton?: boolean;
  role?: 'dialog' | 'alertdialog';
  /** Width, as a Tailwind class. */
  widthClass?: string;
  /** Extra classes for the dialog box. */
  className?: string;
  testId?: string;
  /** Things beside the title, such as the export's actions. */
  headerActions?: ReactNode;
  /** Buttons on the right of the footer, primary last. */
  footer?: ReactNode;
  /** Something on the left of the footer, apart from the buttons. */
  footerStart?: ReactNode;
  /** Stacking level of the overlay. */
  zClass?: string;
  /**
   * Where focus starts: the first field (the default), or the dialog itself
   * where the first control is a slider an arrow key would move.
   * An element marked data-autofocus wins either way.
   */
  initialFocus?: 'field' | 'dialog';
  /** Classes for the scrolling body. */
  bodyClassName?: string;
  children?: ReactNode;
}

/** Open dialogs, innermost last: only the top one answers Escape and traps Tab. */
const openDialogs: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  icon: Icon,
  onClose,
  closing = false,
  dismissible = true,
  showCloseButton = true,
  role = 'dialog',
  widthClass = 'w-[440px]',
  className = '',
  testId,
  headerActions,
  footer,
  footerStart,
  zClass = 'z-50',
  bodyClassName = 'p-4',
  initialFocus = 'field',
  children,
}: DialogProps): JSX.Element {
  const t = useT();
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  // Read through refs, so the listeners below are set up once per dialog.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const token = Symbol('dialog');
    openDialogs.push(token);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = boxRef.current;

    // Focus goes in: to whatever asked for it, else the first field or
    // button, else the dialog itself.
    const marked = box?.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    const wanted =
      marked ??
      (initialFocus === 'dialog'
        ? box
        : box?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ??
          box?.querySelector<HTMLElement>(FOCUSABLE) ??
          box);
    wanted?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent): void => {
      if (openDialogs[openDialogs.length - 1] !== token || !box) return;
      if (event.key === 'Escape') {
        // Nothing behind the dialog hears it: not the full-screen viewer, not
        // the timeline's "clear the selection".
        event.preventDefault();
        event.stopImmediatePropagation();
        if (dismissibleRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        box.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!box.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === box)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      const index = openDialogs.indexOf(token);
      if (index >= 0) openDialogs.splice(index, 1);
      // Back to where the user was, if it is still there.
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once per dialog
  }, []);

  return (
    <div
      data-closing={closing}
      className={`scf-overlay fixed inset-0 ${zClass} flex items-center justify-center bg-black/50`}
    >
      <div
        ref={boxRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        data-closing={closing}
        className={`scf-dialog panel rounded-panel ${widthClass} max-h-[90vh] shadow-2xl shadow-black/60 outline-none ${className}`}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[color:var(--hairline)] bg-gradient-to-b from-panel-800 to-panel-900 px-4">
          <h2 id={titleId} className="flex min-w-0 items-center gap-2 text-base font-semibold text-slate-100">
            {Icon && <Icon size={16} className="shrink-0 text-slate-400" aria-hidden />}
            <span className="truncate">{title}</span>
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            {showCloseButton && dismissible && (
              <button
                type="button"
                className="tool-button w-7 px-0"
                onClick={onClose}
                aria-label={t('dialog.close')}
                title={t('dialog.closeEsc')}
              >
                <X size={15} />
              </button>
            )}
          </div>
        </header>

        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>

        {(footer || footerStart) && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-panel-700 px-4 py-3">
            {footerStart && <div className="mr-auto flex items-center gap-2">{footerStart}</div>}
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export default Dialog;

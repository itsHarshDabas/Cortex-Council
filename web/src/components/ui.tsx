import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/** "awaiting_approval" → "Awaiting approval". */
export const statusLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

/* ---- icons -------------------------------------------------------------- */

const PATHS = {
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  check: "M20 6 9 17l-5-5",
  undo: "M3 7v6h6M3.5 13a9 9 0 1 0 2.1-9.4L3 7",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
  stop: "M6 6h12v12H6z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  chevron: "M9 6l6 6-6 6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/* ---- modal -------------------------------------------------------------- */

// Only the topmost dialog reacts to Escape.
const stack: symbol[] = [];
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  role?: "dialog" | "alertdialog";
}

/** Accessible dialog: labelled, closes on Escape or backdrop click, keeps focus inside and restores it on close. */
export function Modal({ title, onClose, children, size = "md", role = "dialog" }: ModalProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const me = Symbol(title);
    stack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>("[autofocus]") ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack.at(-1) !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0]!;
        const last = items.at(-1)!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(me), 1);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${size}`} role={role} aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <header className="modal-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="ghost icon-only" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ---- confirm ------------------------------------------------------------ */

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
type Request = ConfirmOptions & { resolve: (ok: boolean) => void };

let show: ((r: Request) => void) | null = null;

/** Promise-based replacement for window.confirm(), rendered by <ConfirmHost />. */
export const confirmDialog = (opts: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => (show ? show({ ...opts, resolve }) : resolve(window.confirm(opts.title))));

export function ConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  useEffect(() => {
    show = setReq;
    return () => {
      show = null;
    };
  }, []);
  if (!req) return null;
  const done = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <Modal title={req.title} onClose={() => done(false)} size="sm" role="alertdialog">
      {req.body && <div className="modal-body muted">{req.body}</div>}
      <footer className="modal-foot">
        <button type="button" onClick={() => done(false)}>
          Cancel
        </button>
        <button type="button" className={req.danger ? "danger" : "primary"} onClick={() => done(true)} autoFocus>
          {req.confirmLabel ?? "Confirm"}
        </button>
      </footer>
    </Modal>
  );
}

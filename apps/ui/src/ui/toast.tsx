/**
 * App-wide toasts: short confirmations ("Gate disetujui", "CSV diunduh") and
 * errors raised off the page that caused them. One polite live region is always
 * mounted so screen readers hear each message once.
 */
import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  action?: { label: string; run: () => void };
}

interface ToastStore {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>, timeoutMs?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (toast, timeoutMs = toast.tone === 'danger' ? 8000 : 4000) => {
    const id = nextId++;
    // ponytail: keeps the newest 4; a queue is unnecessary at this volume.
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-4) });
    if (timeoutMs > 0) window.setTimeout(() => get().dismiss(id), timeoutMs);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

export const toast = (tone: ToastTone, text: string, action?: Toast['action']) =>
  useToastStore.getState().push(action ? { tone, text, action } : { tone, text });

export function ToastHost() {
  const toasts = useToastStore((store) => store.toasts);
  const dismiss = useToastStore((store) => store.dismiss);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div key={item.id} className="toast" data-tone={item.tone}>
          <span className="toast-text">{item.text}</span>
          {item.action ? (
            <button type="button" className="toast-action" onClick={() => { item.action?.run(); dismiss(item.id); }}>
              {item.action.label}
            </button>
          ) : null}
          <button type="button" className="toast-close" aria-label="Tutup notifikasi" onClick={() => dismiss(item.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

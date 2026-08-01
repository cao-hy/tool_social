'use client';

import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastInput {
  title?: string;
  message: string;
  type: ToastType;
  ttlMs?: number;
}

interface ToastItem extends ToastInput {
  id: string;
}

interface ToastApi {
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DEFAULT_TTL_MS = 5000;
const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((input: ToastInput) => {
    const id = crypto.randomUUID();
    setToasts((current) => [{ ...input, id }, ...current].slice(0, MAX_TOASTS));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, title) => push({ message, title, type: 'success' }),
      error: (message, title) => push({ message, title, type: 'error', ttlMs: 8000 }),
      info: (message, title) => push({ message, title, type: 'info' }),
      warning: (message, title) => push({ message, title, type: 'warning', ttlMs: 7000 }),
      dismiss,
    }),
    [dismiss, push],
  );

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismiss(toast.id), toast.ttlMs ?? DEFAULT_TTL_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismiss, toasts]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[80] grid w-[min(380px,calc(100vw-2rem))] gap-3">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast phải được dùng bên trong ToastProvider.');
  return context;
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const Icon = TOAST_ICONS[toast.type];
  const tone = TOAST_TONES[toast.type];
  return (
    <div className={`rounded-lg border bg-white p-4 shadow-lg shadow-slate-900/10 ${tone.border}`}>
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.icon}`} />
        <div className="min-w-0 flex-1">
          {toast.title ? (
            <p className="text-sm font-semibold text-slate-950">{toast.title}</p>
          ) : null}
          <p className={`text-sm ${toast.title ? 'mt-1' : ''} ${tone.text}`}>{toast.message}</p>
        </div>
        <button
          aria-label="Đóng thông báo"
          className="h-7 w-7 shrink-0 rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          onClick={onDismiss}
          type="button"
        >
          <X className="mx-auto h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const TOAST_ICONS = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
  warning: TriangleAlert,
} satisfies Record<ToastType, typeof CheckCircle2>;

const TOAST_TONES = {
  success: {
    border: 'border-emerald-200',
    icon: 'text-emerald-600',
    text: 'text-slate-700',
  },
  error: {
    border: 'border-red-200',
    icon: 'text-red-600',
    text: 'text-slate-700',
  },
  info: {
    border: 'border-brand-200',
    icon: 'text-brand-600',
    text: 'text-slate-700',
  },
  warning: {
    border: 'border-amber-200',
    icon: 'text-amber-600',
    text: 'text-slate-700',
  },
} satisfies Record<ToastType, { border: string; icon: string; text: string }>;

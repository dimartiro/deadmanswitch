import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface Toast {
	id: number;
	kind: ToastKind;
	title: string;
	detail?: string;
	createdAt: number;
}

interface ToastState {
	toasts: Toast[];
	push: (t: Omit<Toast, "id" | "createdAt">) => number;
	dismiss: (id: number) => void;
}

let nextId = 1;
const DEFAULT_TTL_MS = 5000;

export const useToastStore = create<ToastState>((set, get) => ({
	toasts: [],
	push: (t) => {
		const id = nextId++;
		const toast: Toast = { ...t, id, createdAt: Date.now() };
		set({ toasts: [...get().toasts, toast] });
		setTimeout(() => get().dismiss(id), DEFAULT_TTL_MS);
		return id;
	},
	dismiss: (id) =>
		set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
	success: (title: string, detail?: string) =>
		useToastStore.getState().push({ kind: "success", title, detail }),
	error: (title: string, detail?: string) =>
		useToastStore.getState().push({ kind: "error", title, detail }),
	info: (title: string, detail?: string) =>
		useToastStore.getState().push({ kind: "info", title, detail }),
};

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
	value: string;
	label: string;
	hint?: string;
}

/**
 * Cyberpunk-styled combobox that replaces the native `<select>`. The
 * native element is unstyled on the dropdown popup itself (the OS
 * renders it), which breaks the dark terminal aesthetic. This renders
 * the list ourselves with matching tokens.
 */
export function Dropdown({
	value,
	onChange,
	options,
	placeholder = "Select…",
	className = "",
	disabled = false,
}: {
	value: string;
	onChange: (v: string) => void;
	options: DropdownOption[];
	placeholder?: string;
	className?: string;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState<number>(-1);
	const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const selected = options.find((o) => o.value === value);

	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			const target = e.target as Node;
			const inTrigger = containerRef.current?.contains(target);
			const inPopup = listRef.current?.contains(target);
			if (!inTrigger && !inPopup) {
				setOpen(false);
			}
		}
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				setOpen(false);
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlight((h) => Math.min(h + 1, options.length - 1));
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlight((h) => Math.max(h - 1, 0));
			}
			if (e.key === "Enter") {
				if (highlight >= 0 && highlight < options.length) {
					e.preventDefault();
					onChange(options[highlight].value);
					setOpen(false);
				}
			}
		}
		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKey);
		};
	}, [open, highlight, options, onChange]);

	useEffect(() => {
		if (!open || highlight < 0 || !listRef.current) return;
		const list = listRef.current;
		const el = list.children[highlight] as HTMLElement | undefined;
		if (!el) return;
		const elTop = el.offsetTop;
		const elBottom = elTop + el.offsetHeight;
		if (elTop < list.scrollTop) {
			list.scrollTop = elTop;
		} else if (elBottom > list.scrollTop + list.clientHeight) {
			list.scrollTop = elBottom - list.clientHeight;
		}
	}, [open, highlight]);

	useLayoutEffect(() => {
		if (!open || !buttonRef.current) return;
		function position() {
			const btn = buttonRef.current;
			if (!btn) return;
			const rect = btn.getBoundingClientRect();
			const estimatedHeight = Math.min(options.length * 40 + 8, 264);
			const margin = 4;
			const spaceBelow = window.innerHeight - rect.bottom;
			const spaceAbove = rect.top;
			const openUp =
				spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
			const maxHeight = Math.min(
				264,
				Math.max(120, openUp ? spaceAbove - margin - 8 : spaceBelow - margin - 8),
			);
			setPopupStyle({
				position: "fixed",
				left: rect.left,
				width: rect.width,
				top: openUp ? undefined : rect.bottom + margin,
				bottom: openUp ? window.innerHeight - rect.top + margin : undefined,
				maxHeight,
			});
		}
		position();
		window.addEventListener("scroll", position, true);
		window.addEventListener("resize", position);
		return () => {
			window.removeEventListener("scroll", position, true);
			window.removeEventListener("resize", position);
		};
	}, [open, options.length]);

	function toggle() {
		if (disabled) return;
		setOpen((o) => {
			if (!o) {
				const i = options.findIndex((opt) => opt.value === value);
				setHighlight(i >= 0 ? i : 0);
			}
			return !o;
		});
	}

	return (
		<div ref={containerRef} className={`relative ${className}`}>
			<button
				ref={buttonRef}
				type="button"
				onClick={toggle}
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				className="input flex items-center justify-between gap-2 text-left w-full cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
			>
				<span
					className={`truncate ${selected ? "text-ink-900" : "text-ink-400"}`}
				>
					{selected?.label ?? placeholder}
				</span>
				<span
					className={`text-ink-500 text-[0.7rem] transition-transform ${
						open ? "rotate-180 text-neon-500" : ""
					}`}
				>
					▾
				</span>
			</button>

			{open &&
				createPortal(
					<div
						ref={listRef}
						role="listbox"
						className="overflow-y-auto"
						style={{
							...popupStyle,
							backgroundColor: "#1C2127",
							border: "1px solid #2A3340",
							borderRadius: "3px",
							boxShadow:
								"0 0 0 1px rgba(0, 255, 179, 0.12), 0 16px 48px rgba(0, 0, 0, 0.75)",
							zIndex: 1000,
						}}
					>
						{options.length === 0 ? (
							<div className="px-3 py-2 text-sm text-ink-500 font-mono">
								No options
							</div>
						) : (
							options.map((opt, i) => {
								const isHighlighted = i === highlight;
								const isSelected = value === opt.value;
								return (
									<button
										key={opt.value}
										type="button"
										role="option"
										aria-selected={isSelected}
										onMouseEnter={() => setHighlight(i)}
										onClick={() => {
											onChange(opt.value);
											setOpen(false);
										}}
										className={`w-full text-left px-3 py-2 font-mono text-sm transition-colors flex items-center justify-between gap-3 ${
											isHighlighted
												? "bg-neon-500/10 text-neon-500"
												: isSelected
													? "text-neon-500 bg-neon-500/5"
													: "text-ink-700 hover:bg-mist"
										}`}
									>
										<span className="truncate">{opt.label}</span>
										<span className="flex items-center gap-2 shrink-0">
											{opt.hint && (
												<span className="text-[0.68rem] text-ink-400 truncate max-w-[140px]">
													{opt.hint}
												</span>
											)}
											{isSelected && (
												<span className="text-neon-500 text-xs">▸</span>
											)}
										</span>
									</button>
								);
							})
						)}
					</div>,
					document.body,
				)}
		</div>
	);
}

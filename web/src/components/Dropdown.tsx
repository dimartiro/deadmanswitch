import { useEffect, useRef, useState } from "react";

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
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const selected = options.find((o) => o.value === value);

	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
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
		if (open && highlight >= 0 && listRef.current) {
			const el = listRef.current.children[highlight] as
				| HTMLElement
				| undefined;
			el?.scrollIntoView({ block: "nearest" });
		}
	}, [open, highlight]);

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

			{open && (
				<div
					ref={listRef}
					role="listbox"
					className="absolute left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto z-30"
					style={{
						background: "#0E1114",
						border: "1px solid #202731",
						borderRadius: "3px",
						boxShadow:
							"0 0 0 1px rgba(0, 255, 179, 0.08), 0 12px 40px rgba(0, 0, 0, 0.6)",
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
												: "text-ink-700 hover:bg-muted"
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
				</div>
			)}
		</div>
	);
}

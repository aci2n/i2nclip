interface SwipeOptions {
	enabled: boolean;
	key: unknown;
	onleft?: () => unknown;
	onright?: () => unknown;
	onup?: () => unknown;
}
// Presentation-only input: callbacks retain navigation and resource ownership.
export function previewSwipes(node: HTMLElement, options: SwipeOptions) {
	let start: { id: number; x: number; y: number } | null;
	function down(event: PointerEvent) {
		start = null;
		if (!event.isPrimary) {
			return;
		}
		if (
			!options.enabled ||
			event.pointerType !== "touch" ||
			event.target === node
		) {
			return;
		}
		if (!(event.target instanceof Element)) {
			return;
		}
		if (event.target.closest("button, a, input, textarea, select, audio")) {
			return;
		}
		// Native video controls occupy the bottom strip; leave their gestures alone.
		const video = event.target.closest("video");
		if (video && event.clientY >= video.getBoundingClientRect().bottom - 64) {
			return;
		}
		start = { id: event.pointerId, x: event.clientX, y: event.clientY };
	}
	function up(event: PointerEvent) {
		const previous = start;
		start = null;
		if (!previous || previous.id !== event.pointerId || !options.enabled) {
			return;
		}
		const x = event.clientX - previous.x;
		const y = event.clientY - previous.y;
		if (Math.abs(x) >= 50 && Math.abs(x) > Math.abs(y) * 1.5) {
			(x < 0 ? options.onleft : options.onright)?.();
		} else if (y <= -50 && Math.abs(y) > Math.abs(x) * 1.5) {
			options.onup?.();
		}
	}
	function cancel() {
		start = null;
	}
	node.addEventListener("pointerdown", down);
	node.addEventListener("pointerup", up);
	node.addEventListener("pointercancel", cancel);
	return {
		update(next: SwipeOptions) {
			if (next.key !== options.key || !next.enabled) {
				cancel();
			}
			options = next;
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("pointerup", up);
			node.removeEventListener("pointercancel", cancel);
		},
	};
}

export interface ByteRange {
	start: number;
	end: number;
	partial: boolean;
}

// End is exclusive throughout the browser bridge. Unsupported/malformed ranges
// are ignored, as HTTP permits; null means a valid but unsatisfiable range.
export function byteRange(
	header: string | null,
	size: number,
): ByteRange | null {
	const full = { start: 0, end: size, partial: false };
	if (!header) {
		return full;
	}
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) {
		return full;
	}
	const first = match[1] ? Number(match[1]) : undefined;
	const last = match[2] ? Number(match[2]) : undefined;
	if (
		(first !== undefined && !Number.isSafeInteger(first)) ||
		(last !== undefined && !Number.isSafeInteger(last))
	) {
		return full;
	}
	if (!size) {
		return null;
	}
	if (first === undefined) {
		if (!last) {
			return null;
		}
		return { start: Math.max(0, size - last), end: size, partial: true };
	}
	if (first >= size || (last !== undefined && last < first)) {
		return null;
	}
	return {
		start: first,
		end: last === undefined ? size : Math.min(size, last + 1),
		partial: true,
	};
}

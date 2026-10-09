// Pull a cover image out of an audio file, if the file has one.
// MP3 stores it in an ID3v2 APIC frame, FLAC in a picture block, and M4A in a
// covr atom. The rest of the file is left alone. No picture means null, and
// the card stays a play icon.

export function audioArt(bytes) {
	if (bytes.length < 8) return null;
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
		return id3(bytes);
	if (text(bytes, 0, 4) === "fLaC") return flac(bytes);
	if (text(bytes, 4, 4) === "ftyp") return mp4(bytes);
	return null;
}

function id3(bytes) {
	const major = bytes[3];
	if (major < 3 || major > 4) return null;
	// Unsynchronisation and an extended header would shift every frame. Those
	// tags are uncommon for a cover, so leave them without a picture.
	if (bytes[5] & 0xc0) return null;
	const tagEnd = Math.min(bytes.length, 10 + synchsafe(bytes, 6));
	let o = 10;
	let best = null;
	while (o + 10 <= tagEnd) {
		const id = text(bytes, o, 4);
		if (id === "\0\0\0\0") break;
		const size = major === 4 ? synchsafe(bytes, o + 4) : u32(bytes, o + 4);
		const flags = (bytes[o + 8] << 8) | bytes[o + 9];
		o += 10;
		if (o + size > tagEnd) break;
		if (id === "APIC" && (flags & 0x00c0) === 0) {
			const pic = apic(bytes.subarray(o, o + size));
			if (pic && (pic.kind === 3 || !best)) best = pic;
			if (best?.kind === 3) return best.bytes;
		}
		o += size;
	}
	return best?.bytes ?? null;
}

function apic(frame) {
	if (frame.length < 4) return null;
	let o = 1;
	const mimeEnd = frame.indexOf(0, o);
	if (mimeEnd < 0) return null;
	o = mimeEnd + 1;
	const kind = frame[o++];
	const enc = frame[0];
	if (enc === 1 || enc === 2) {
		while (o + 1 < frame.length && !(frame[o] === 0 && frame[o + 1] === 0))
			o += 2;
		o += 2;
	} else {
		const descEnd = frame.indexOf(0, o);
		if (descEnd < 0) return null;
		o = descEnd + 1;
	}
	if (o >= frame.length) return null;
	return { kind, bytes: frame.subarray(o) };
}

function flac(bytes) {
	let o = 4;
	let best = null;
	while (o + 4 <= bytes.length) {
		const last = bytes[o] & 0x80;
		const type = bytes[o] & 0x7f;
		const size = (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
		o += 4;
		if (o + size > bytes.length) break;
		if (type === 6) {
			const pic = vorbisPicture(bytes.subarray(o, o + size));
			if (pic && (pic.kind === 3 || !best)) best = pic;
			if (best?.kind === 3) return best.bytes;
		}
		o += size;
		if (last) break;
	}
	return best?.bytes ?? null;
}

function vorbisPicture(block) {
	if (block.length < 32) return null;
	const kind = u32(block, 0);
	let o = 4;
	const mimeLen = u32(block, o);
	o += 4 + mimeLen;
	if (o + 4 > block.length) return null;
	const descLen = u32(block, o);
	o += 4 + descLen + 16;
	if (o + 4 > block.length) return null;
	const dataLen = u32(block, o);
	o += 4;
	if (o + dataLen > block.length) return null;
	return { kind, bytes: block.subarray(o, o + dataLen) };
}

function mp4(bytes) {
	return walk(bytes, 0, bytes.length);
}

function walk(bytes, start, end) {
	let o = start;
	while (o + 8 <= end) {
		let size = u32(bytes, o);
		const kind = text(bytes, o + 4, 4);
		let header = 8;
		if (size === 1) {
			if (o + 16 > end) return null;
			size = u32(bytes, o + 8) * 2 ** 32 + u32(bytes, o + 12);
			header = 16;
		} else if (size === 0) {
			size = end - o;
		}
		if (size < header || o + size > end) return null;
		const body = o + header;
		const bodyEnd = o + size;
		if (kind === "moov" || kind === "udta" || kind === "ilst") {
			const found = walk(bytes, body, bodyEnd);
			if (found) return found;
		} else if (kind === "meta") {
			const found = walk(bytes, body + 4, bodyEnd);
			if (found) return found;
		} else if (kind === "covr") {
			const image = covr(bytes, body, bodyEnd);
			if (image) return image;
		}
		o += size;
	}
	return null;
}

function covr(bytes, start, end) {
	let o = start;
	while (o + 8 <= end) {
		const size = u32(bytes, o);
		if (size < 8 || o + size > end) return null;
		if (text(bytes, o + 4, 4) === "data" && size > 16)
			return bytes.subarray(o + 16, o + size);
		o += size;
	}
	return null;
}

function synchsafe(bytes, o) {
	return (
		((bytes[o] & 0x7f) << 21) |
		((bytes[o + 1] & 0x7f) << 14) |
		((bytes[o + 2] & 0x7f) << 7) |
		(bytes[o + 3] & 0x7f)
	);
}

function u32(bytes, o) {
	return (
		bytes[o] * 16777216 +
		bytes[o + 1] * 65536 +
		bytes[o + 2] * 256 +
		bytes[o + 3]
	);
}

function text(bytes, o, n) {
	let out = "";
	for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[o + i]);
	return out;
}

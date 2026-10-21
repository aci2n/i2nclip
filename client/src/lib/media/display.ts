import type { Metadata } from "../protocol/meta-plain.ts";

/** Plain presentation data; no application workflows or key material. */
export interface MediaDisplay {
	readonly id: string;
	readonly metadata: Metadata | null;
	readonly ready: boolean;
	readonly busy: boolean;
	readonly url: string;
	readonly preview: string;
	readonly text: string | null;
	readonly textTruncated: boolean;
	readonly message: string;
	readonly error: boolean;
}

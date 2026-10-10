import { get } from "svelte/store";
import { sendUpload } from "../media/upload.js";
import { sendPendingUpload } from "./pending-upload.js";
import { createSession } from "./session.js";

export async function submitContextUpload(
	source,
	withTags,
	platform,
	services = { createSession, sendUpload },
) {
	if (!source.srcUrl) {
		await platform.notify("Nothing to upload.");
		return;
	}
	const pending = { ...source, id: crypto.randomUUID() };
	const storageKey = `upload:${pending.id}`;
	const session = services.createSession(platform);
	try {
		await platform.session.set({ [storageKey]: pending });
		await session.ready;
		if (withTags || !get(session).privateKey) {
			await platform.openUpload(pending.id, withTags ? "upload" : "unlock");
			return;
		}
		await sendPendingUpload(
			{ id: pending.id, source: pending, session, platform },
			services.sendUpload,
		);
	} catch (error) {
		const message =
			error.name === "AbortError"
				? "Library changed. Upload cancelled."
				: error.message || "Upload failed.";
		// Reset may have cleared this entry; do not recreate discarded work.
		const stored = await platform.session.get(storageKey);
		if (stored[storageKey]) {
			await platform.session.set({
				[storageKey]: { ...stored[storageKey], error: message },
			});
			await platform.openUpload(pending.id, "upload");
		}
		await platform.notify(message);
	} finally {
		session.dispose();
	}
}

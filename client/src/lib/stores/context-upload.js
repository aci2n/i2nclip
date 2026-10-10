import { get } from "svelte/store";
import { sendUpload } from "../media/upload.js";
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
	const controller = new AbortController();
	let unsubscribe = () => {};
	try {
		await platform.session.set({ [storageKey]: pending });
		await session.ready;
		if (withTags || !get(session).privateKey) {
			await platform.openUpload(pending.id, withTags ? "upload" : "unlock");
			return;
		}
		const credentials = session.credentials();
		unsubscribe = session.subscribe((value) => {
			if (
				value.privateKey !== credentials.privateKey ||
				value.serverUrl !== credentials.serverUrl
			)
				controller.abort();
		});
		await services.sendUpload(
			pending,
			credentials,
			platform,
			"",
			undefined,
			controller.signal,
		);
		controller.signal.throwIfAborted();
		await platform.session.remove(storageKey);
		// Notification failure cannot turn a saved upload into a retry.
		await Promise.resolve()
			.then(() => platform.notify("Uploaded."))
			.catch(() => {});
	} catch (error) {
		const message = controller.signal.aborted
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
		unsubscribe();
		session.dispose();
	}
}

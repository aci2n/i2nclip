import { get } from "svelte/store";
import { sendUpload } from "../media/upload.js";
import {
	createUploadTask,
	sendPendingUpload,
} from "../media/upload-workflow.js";
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
	const session = services.createSession(platform);
	let task;
	try {
		await session.pending.put(pending.id, pending);
		await session.ready;
		if (withTags || !get(session).privateKey) {
			await platform.openUpload(pending.id, withTags ? "upload" : "unlock");
			return;
		}
		task = createUploadTask({ session });
		await sendPendingUpload(
			{ id: pending.id, source: pending, task, platform },
			services.sendUpload,
		);
	} catch (error) {
		const message =
			error.name === "AbortError"
				? "Library changed. Upload cancelled."
				: error.message || "Upload failed.";
		// Reset may have cleared this entry; do not recreate discarded work.
		if (await session.pending.fail(pending.id, message)) {
			await platform.openUpload(pending.id, "upload");
		}
		await platform.notify(message);
	} finally {
		task?.dispose();
		session.dispose();
	}
}

import { get } from "svelte/store";
import * as api from "../api.js";
import { audioArt } from "../media/audio-art.js";
import { checkFileSize, prepareMedia, sendUpload } from "../media/upload.js";
import { thumbnail } from "../media/thumbnail.js";
import { normalizeTag, splitTags, tagTokens } from "../protocol/crypto.js";
import { uniqueTags } from "../protocol/tags.js";
import { createIdentity } from "./identity.js";
import { createPairing } from "./pairing.js";
import {
	errorDetails,
	serviceTracing,
	traceEvent,
	traceMessage,
} from "./trace.js";

const canceled = () =>
	new DOMException("Library changed. Try again.", "AbortError");

// One engine per host. Transports only deliver messages; they never own state.
export function createLibraryRuntime({
	repository,
	defaultServerUrl,
	platform = {},
	api: http = api,
	upload = sendUpload,
	pairing: pairingServices = {},
	authorizeRegistration,
	uploadLane,
	nextJobOrder,
	libraryId,
	completedRetentionMs = 5000,
}) {
	const clients = new Map();
	const views = new Map();
	const media = new Map();
	const mutations = new Set();
	const downloads = new Map();
	const helpers = new Map();
	let jobs = new Map();
	let completionTimer;
	let disposed = false;
	let pumping = false;
	let changingContext = 0;
	let mutationRevision = 0;
	let lastEpoch = 0;
	let jobTail = Promise.resolve();
	let nextOrder = 0;
	const enqueue = (action) => {
		const result = jobTail.then(action);
		jobTail = result.catch(() => {});
		return result;
	};
	const identity = createIdentity(
		repository,
		defaultServerUrl,
		enqueue,
		authorizeRegistration,
	);
	const pairing = createPairing(identity, pairingServices);
	const instanceId = crypto.randomUUID();
	function sessionState() {
		const value = get(identity);
		return {
			ready: value.ready,
			configured: Boolean(value.wrappedKey),
			unlocked: Boolean(value.privateKey) && !value.busy,
			serverUrl: value.serverUrl,
			publicKey: value.publicKey,
			pendingRegistration: value.pendingRegistration
				? {
						serverUrl: value.pendingRegistration.serverUrl,
						publicKey: value.pendingRegistration.publicKey,
						method: value.pendingRegistration.method,
						authorizerLibraryId: value.pendingRegistration.authorizerLibraryId,
					}
				: null,
			epoch: value.epoch,
			busy: value.busy,
			error: value.error,
		};
	}
	const uploadState = () =>
		[...jobs.values()].map(({ source: _source, ...job }) => ({ ...job }));
	const pairingState = () => ({ ...get(pairing) });
	function publishPairing() {
		for (const client of clients.values())
			send(client, {
				type: "state",
				topic: "pairing",
				value: pairingState(),
			});
	}
	function send(client, message) {
		if (!clients.has(client.id)) return;
		try {
			const outgoing = {
				...message,
				instanceId,
				sequence: ++client.sequence,
				clientId: client.id,
			};
			if (serviceTracing) traceMessage("owner → client", client.id, outgoing);
			client.send(outgoing);
		} catch {
			disconnect(client.id);
		}
	}
	function broadcast(topic, value) {
		for (const client of clients.values())
			send(client, { type: "state", topic, value });
	}
	function publishUploads() {
		if (disposed) return;
		broadcast("uploads", uploadState());
		clearTimeout(completionTimer);
		const batches = new Map();
		for (const job of jobs.values()) {
			if (!batches.has(job.batchId)) batches.set(job.batchId, []);
			batches.get(job.batchId).push(job);
		}
		const complete = [...batches.values()].filter((batch) =>
			batch.every((job) => job.status === "completed"),
		);
		if (!complete.length || disposed) return;
		const deadline = Math.min(
			...complete.map(
				(batch) =>
					Math.max(
						...batch.map(
							(job) => job.completedAt || job.createdAt || Date.now(),
						),
					) + completedRetentionMs,
			),
		);
		completionTimer = setTimeout(
			() => {
				void enqueue(async () => {
					if (disposed) return;
					for (const batch of complete) {
						if (
							batch.some(
								(job) => jobs.get(job.id) !== job || job.status !== "completed",
							)
						)
							continue;
						if (
							Math.max(
								...batch.map(
									(job) => job.completedAt || job.createdAt || Date.now(),
								),
							) +
								completedRetentionMs >
							Date.now()
						)
							continue;
						for (const job of batch) {
							await repository.removeJob(job.id);
							jobs.delete(job.id);
						}
					}
					publishUploads();
				}).catch((error) => {
					if (!disposed) {
						traceEvent("upload.cleanup.failed", errorDetails(error));
						completionTimer = setTimeout(publishUploads, completedRetentionMs);
					}
				});
			},
			Math.max(0, deadline - Date.now()),
		);
	}

	function viewState(view) {
		return {
			id: view.id,
			query: view.query,
			ids: [...view.ids],
			next: view.next,
			loading: view.loading,
			status: view.status,
			empty: view.empty,
		};
	}
	function publishView(view) {
		const client = clients.get(view.clientId);
		if (client)
			send(client, { type: "state", topic: "view", value: viewState(view) });
	}
	function snapshot(client) {
		return {
			session: sessionState(),
			uploads: uploadState(),
			pairing: pairingState(),
			media: Object.fromEntries(media),
			views: Object.fromEntries(
				[...views.values()]
					.filter((view) => view.clientId === client.id)
					.map((view) => [view.id, viewState(view)]),
			),
		};
	}
	function clearViews() {
		traceEvent("library.invalidate", {
			libraryId,
			epoch: identity.epoch,
			views: views.size,
			downloads: downloads.size,
		});
		media.clear();
		mutations.clear();
		mutationRevision++;
		broadcast("mediaReset", null);
		for (const view of views.values()) {
			view.controller?.abort();
			view.revision++;
			Object.assign(view, {
				ids: [],
				next: null,
				loading: false,
				status: "",
				empty: null,
			});
			publishView(view);
		}
	}
	const unsubscribeIdentity = identity.subscribe((value) => {
		if (value.epoch !== lastEpoch) {
			lastEpoch = value.epoch;
			clearViews();
		}
		broadcast("session", sessionState());
		if (value.privateKey && !value.busy) {
			for (const view of views.values())
				if (!view.ids.length && !view.loading)
					void search(view, view.query).catch(() => {});
			if (!changingContext) void pump();
		}
	});
	const unsubscribePairing = pairing.subscribe(publishPairing);
	const ready = identity.ready.then(async () => {
		const stored = (await repository.jobs()).sort((a, b) => a.order - b.order);
		for (const job of stored) {
			nextOrder = Math.max(nextOrder, job.order || 0);
			if (job.status === "completed" && !job.completedAt)
				job.completedAt = Date.now();
			if (["uploading", "preparing"].includes(job.status))
				job.status = "interrupted";
			else if (job.status === "queued") job.status = "paused";
			job.auto = false;
			job.progress = null;
			jobs.set(job.id, job);
			await repository.putJob(job);
		}
		publishUploads();
	});
	function credentials() {
		return identity.credentials();
	}
	function guard(epoch, signal) {
		signal?.throwIfAborted();
		if (disposed || epoch !== identity.epoch) throw canceled();
	}
	async function updateEntity(item, epoch, signal) {
		guard(epoch, signal);
		const existing = media.get(item.id);
		const retainFeedback =
			Boolean(existing) && existing.metaHash === item.metaHash;
		const next = {
			...existing,
			...item,
			busy: mutations.has(item.id),
			deleted: false,
			progress: existing?.progress ?? null,
			message: retainFeedback ? existing.message : "",
			error: retainFeedback ? existing.error : false,
		};
		if (item.metadata) {
			const expected = await tagTokens(
				credentials().privateKey,
				item.metadata.tags || [],
			);
			guard(epoch, signal);
			if (
				expected.length !== (item.tokens || []).length ||
				expected.some((token) => !item.tokens?.includes(token))
			)
				next.message = "Tags on the server do not match this file.";
		}
		media.set(item.id, next);
		broadcast("media", next);
		return next;
	}
	async function search(view, query, more = false, refresh = false) {
		if (more && (view.loading || !view.next)) return;
		const captured = credentials();
		view.controller?.abort();
		const controller = new AbortController();
		view.controller = controller;
		const signal = AbortSignal.any([controller.signal, identity.signal]);
		const epoch = identity.epoch;
		const version = ++view.revision;
		const changesAtStart = mutationRevision;
		const after = more ? view.next : null;
		Object.assign(view, {
			query,
			loading: true,
			status: "Loading…",
			empty: null,
		});
		traceEvent("search.start", {
			libraryId,
			id: view.id,
			revision: version,
			more,
			refresh,
		});
		if (!more) view.additions = new Set();
		if (!more && !refresh) Object.assign(view, { ids: [], next: null });
		publishView(view);
		try {
			const page = await http.list({ ...captured, tags: query, after, signal });
			guard(epoch, signal);
			if (version !== view.revision || !views.has(view.id)) return;
			for (const item of page.items) {
				// A response begun before a local mutation cannot replace newer data.
				if (changesAtStart !== mutationRevision && media.has(item.id)) continue;
				if (mutations.has(item.id) || (more && media.has(item.id))) continue;
				await updateEntity(item, epoch, signal);
			}
			guard(epoch, signal);
			if (version !== view.revision) return;
			view.ids = [
				...new Set([
					...(more ? view.ids : []),
					...page.items
						.filter((item) => !media.get(item.id)?.deleted)
						.map((item) => item.id),
					...[...view.additions].filter((id) => !media.get(id)?.deleted),
				]),
			];
			Object.assign(view, {
				next: page.next,
				status: "",
				empty: view.ids.length
					? null
					: splitTags(query).length
						? "search"
						: "library",
			});
		} catch (error) {
			traceEvent("search.failed", {
				libraryId,
				id: view.id,
				revision: version,
				...errorDetails(error),
			});
			if (version === view.revision && !signal.aborted)
				view.status = error.message;
		} finally {
			if (version === view.revision) {
				view.loading = false;
				traceEvent("search.settled", {
					libraryId,
					id: view.id,
					revision: version,
					items: view.ids.length,
				});
				publishView(view);
			}
		}
	}
	function refreshViews() {
		for (const view of views.values())
			void search(view, view.query, false, true).catch(() => {});
	}
	async function publishUpload(item, epoch, signal) {
		if (!item?.id) return;
		await updateEntity(item, epoch, signal);
		const tags = new Set((item.metadata?.tags || []).map(normalizeTag));
		for (const view of views.values()) {
			if (!splitTags(view.query).every((tag) => tags.has(normalizeTag(tag))))
				continue;
			view.additions.add(item.id);
			if (!view.ids.includes(item.id)) view.ids.push(item.id);
			view.empty = null;
			publishView(view);
		}
	}
	function ownedView(client, id) {
		const view = views.get(id);
		if (!view || view.clientId !== client.id)
			throw new Error("Library view ended.");
		return view;
	}
	async function mutateMedia(id, action) {
		if (mutations.has(id)) throw new Error("This file is busy. Try again.");
		const item = media.get(id);
		if (!item || item.deleted) throw new Error("This file is unavailable.");
		const epoch = identity.epoch;
		const signal = identity.signal;
		const captured = credentials();
		mutations.add(id);
		Object.assign(item, { busy: true, message: "", error: false });
		broadcast("media", { ...item });
		try {
			const result = await action(item, { ...captured, id, signal });
			guard(epoch, signal);
			mutationRevision++;
			return result;
		} catch (error) {
			traceEvent("media.mutation.failed", {
				libraryId,
				id,
				...errorDetails(error),
			});
			if (epoch === identity.epoch)
				Object.assign(item, { message: error.message, error: true });
			throw error;
		} finally {
			if (epoch === identity.epoch) {
				mutations.delete(id);
				item.busy = false;
				broadcast("media", { ...item });
			}
		}
	}
	async function content(client, id, callerSignal) {
		const captured = credentials();
		const epoch = identity.epoch;
		const item = media.get(id);
		if (!item || item.deleted) throw new Error("This file is unavailable.");
		let entry = downloads.get(id);
		if (entry?.controller.signal.aborted || entry?.epoch !== epoch)
			entry = null;
		if (!entry) {
			traceEvent("download.start", { libraryId, id, epoch });
			const controller = new AbortController();
			const signal = AbortSignal.any([controller.signal, identity.signal]);
			entry = { controller, consumers: new Set(), epoch };
			entry.promise = http
				.getContent({
					...captured,
					id,
					signal,
					onProgress: (progress) => {
						if (epoch === identity.epoch && downloads.get(id) === entry) {
							item.progress = progress;
							broadcast("media", { ...item });
						}
					},
				})
				.then((bytes) => {
					guard(epoch, signal);
					return {
						blob: new Blob([bytes], {
							type: item.metadata?.content_type || "application/octet-stream",
						}),
						art: item.metadata?.content_type?.startsWith("audio/")
							? audioArt(bytes)
							: null,
					};
				})
				.finally(() => {
					if (downloads.get(id) === entry) downloads.delete(id);
					if (epoch === identity.epoch) {
						item.progress = null;
						broadcast("media", { ...item });
					}
				});
			entry.promise.catch(() => {});
			downloads.set(id, entry);
		}
		const consumer = { clientId: client.id };
		entry.consumers.add(consumer);
		let rejectAbort;
		const interrupted = new Promise((_, reject) => {
			rejectAbort = reject;
		});
		const abort = () => {
			entry.consumers.delete(consumer);
			if (!entry.consumers.size) entry.controller.abort();
			rejectAbort(callerSignal.reason);
		};
		callerSignal.addEventListener("abort", abort, { once: true });
		try {
			callerSignal.throwIfAborted();
			const result = await Promise.race([entry.promise, interrupted]);
			guard(epoch, callerSignal);
			if (media.get(id)?.deleted || !clients.has(client.id)) throw canceled();
			return result;
		} finally {
			callerSignal.removeEventListener("abort", abort);
			entry.consumers.delete(consumer);
		}
	}
	function requestHelper(clientId, job, blob) {
		const client = clients.get(clientId);
		if (!client) return Promise.resolve(null);
		const helperId = crypto.randomUUID();
		return new Promise((resolve) => {
			const finish = (value) => {
				clearTimeout(timer);
				helpers.delete(helperId);
				resolve(value);
			};
			const timer = setTimeout(() => finish(null), 8000);
			helpers.set(helperId, { clientId, finish });
			send(client, {
				type: "helper",
				helperId,
				name: "videoThumbnail",
				payload: { id: job.id, blob },
			});
		});
	}
	async function prepareJob(job, source, signal) {
		const prepared = await prepareMedia(source, platform, signal);
		const preview =
			source.preview ??
			(prepared.blob.type.startsWith("video/") && !platform.videoThumbnail
				? await requestHelper(job.clientId, job, prepared.blob)
				: await thumbnail(prepared.blob, signal));
		signal.throwIfAborted();
		return { ...prepared, preview };
	}
	async function persistJob(job, source) {
		const epoch = identity.epoch;
		await repository.putJob(job, source);
		guard(epoch);
		jobs.set(job.id, job);
		publishUploads();
	}
	async function submit(
		client,
		sources,
		{ auto = true, context = false } = {},
	) {
		if (!context) credentials();
		const epoch = identity.epoch;
		const batchId = crypto.randomUUID();
		const accepted = [];
		const failures = [];
		for (const source of sources) {
			try {
				if (source.blob) checkFileSize(source.blob.size);
				if (source.bytes) checkFileSize(source.bytes.byteLength);
				guard(epoch);
				const job = {
					...(libraryId ? { libraryId } : {}),
					id: source.id || crypto.randomUUID(),
					batchId,
					clientId: client.id,
					name: source.name || "",
					tags: "",
					status: context ? "awaiting" : "queued",
					auto,
					context,
					progress: null,
					error: "",
					createdAt: Date.now(),
					order: nextJobOrder ? nextJobOrder() : ++nextOrder,
					generation: get(identity).identityGeneration,
					serverUrl: get(identity).serverUrl,
				};
				await enqueue(async () => {
					guard(epoch);
					await persistJob(job, source);
				});
				accepted.push(job.id);
				if (context) void capture(job).catch(() => {});
			} catch (error) {
				failures.push({ name: source.name || "upload", error: error.message });
			}
		}
		void pump();
		return { batchId, ids: accepted, failures };
	}
	async function capture(job) {
		const epoch = identity.epoch;
		const signal = identity.signal;
		try {
			const source = await repository.getSource(job.id);
			const prepared = await prepareJob(job, source, signal);
			await enqueue(async () => {
				guard(epoch, signal);
				const current = jobs.get(job.id);
				if (!current || current.status === "completed") return;
				await persistJob({ ...current, name: prepared.name }, prepared);
			});
			const current = jobs.get(job.id);
			if (
				current?.auto &&
				sessionState().unlocked &&
				current.status === "awaiting"
			)
				await retry([job.id]);
		} catch (error) {
			if (signal.aborted || !jobs.has(job.id)) return;
			await enqueue(async () => {
				const current = jobs.get(job.id);
				if (current?.status === "awaiting")
					await persistJob({
						...current,
						status: "failed",
						error: error.message,
					});
			});
			await platform.notify?.(error.message);
		}
	}
	async function retry(ids) {
		credentials();
		const epoch = identity.epoch;
		await enqueue(async () => {
			guard(epoch);
			for (const id of ids) {
				guard(epoch);
				const job = jobs.get(id);
				if (
					!job ||
					!["failed", "interrupted", "paused", "awaiting"].includes(job.status)
				)
					continue;
				await persistJob({
					...job,
					status: "queued",
					error: "",
					progress: null,
					generation: get(identity).identityGeneration,
					serverUrl: get(identity).serverUrl,
				});
			}
		});
		void pump();
		return true;
	}
	async function pump() {
		if (pumping || changingContext || disposed || !sessionState().unlocked)
			return;
		pumping = true;
		try {
			while (!disposed && sessionState().unlocked) {
				const job = [...jobs.values()].find(
					(job) =>
						job.status === "queued" &&
						job.serverUrl === sessionState().serverUrl,
				);
				if (!job) break;
				const epoch = identity.epoch;
				const signal = identity.signal;
				const captured = credentials();
				let release;
				let transferred = false;
				const attemptId = crypto.randomUUID();
				try {
					release = await uploadLane?.acquire(job.order, signal);
					guard(epoch, signal);
					await enqueue(async () => {
						guard(epoch, signal);
						await persistJob({ ...job, attemptId, status: "preparing" });
					});
					const source = await repository.getSource(job.id);
					traceEvent("upload.prepare", { libraryId, jobId: job.id, attemptId });
					const prepared = await prepareJob(job, source, signal);
					await enqueue(async () => {
						guard(epoch, signal);
						await persistJob(
							{ ...job, attemptId, name: prepared.name, status: "uploading" },
							prepared,
						);
					});
					const result = await upload({
						source: prepared,
						credentials: captured,
						platform,
						signal,
						tags: job.tags,
						onProgress: (progress) => {
							if (
								epoch === identity.epoch &&
								jobs.get(job.id)?.attemptId === attemptId &&
								jobs.get(job.id)?.status === "uploading"
							) {
								jobs.get(job.id).progress = progress;
								publishUploads();
							}
						},
					});
					transferred = true;
					traceEvent("upload.transferred", {
						libraryId,
						jobId: job.id,
						attemptId,
					});
					guard(epoch, signal);
					await enqueue(async () => {
						guard(epoch, signal);
						const completed = {
							...job,
							attemptId,
							name: prepared.name,
							status: "completed",
							completedAt: Date.now(),
							auto: false,
							progress: null,
							error: "",
							mediaId: result?.id,
						};
						await repository.finishJob(completed);
						jobs.set(job.id, completed);
						publishUploads();
					});
					mutationRevision++;
					await publishUpload(result, epoch, signal);
					traceEvent("upload.completed", {
						libraryId,
						jobId: job.id,
						attemptId,
					});
					if (job.context)
						void Promise.resolve(platform.notify?.("Uploaded.")).catch(
							() => {},
						);
				} catch (error) {
					traceEvent("upload.failed", {
						libraryId,
						jobId: job.id,
						attemptId,
						transferred,
						...errorDetails(error),
					});
					await enqueue(async () => {
						if (disposed || !jobs.has(job.id)) return;
						if (epoch !== identity.epoch) {
							// Never write old work after reset has cleared its database.
							Object.assign(jobs.get(job.id), {
								status: "interrupted",
								auto: false,
								progress: null,
								error: "Library changed. Try again.",
							});
							publishUploads();
							return;
						}
						const failed = {
							...jobs.get(job.id),
							status: signal.aborted || transferred ? "interrupted" : "failed",
							auto: false,
							progress: null,
							error: transferred
								? "Upload may already be saved on the server. Check before retrying."
								: signal.aborted
									? "Library changed. Try again."
									: error.message,
						};
						try {
							await persistJob(failed);
						} catch (failure) {
							if (epoch === identity.epoch && !disposed) {
								jobs.set(job.id, {
									...failed,
									error: `${failed.error} Could not save upload status: ${failure.message}`,
								});
								publishUploads();
							}
						}
					});
					if (job.context && !signal.aborted) {
						void Promise.resolve(platform.openUpload?.(job.id, "upload")).catch(
							() => {},
						);
						void Promise.resolve(platform.notify?.(error.message)).catch(
							() => {},
						);
					}
				} finally {
					release?.();
				}
			}
		} finally {
			pumping = false;
		}
	}
	async function dispatch(client, name, payload, signal) {
		await ready;
		if (!clients.has(client.id)) throw new Error("Connection ended.");
		if (name === "snapshot") {
			send(client, { type: "snapshot", value: snapshot(client) });
			return true;
		}
		if (name === "identity.backup") return identity.backup();
		if (name.startsWith("identity.")) {
			guard(payload.epoch);
			const action = name.slice(9);
			const args = {
				create: [payload],
				restore: [payload.file, payload.password],
				unlock: [payload.password],
				setServer: [payload.serverUrl],
				reset: [],
				discardCreation: [],
			}[action];
			if (!args) throw new Error("Unknown identity command.");
			const destructive = ["reset", "setServer"].includes(action);
			if (destructive) changingContext++;
			let result;
			try {
				result = await identity[action](...args);
			} finally {
				if (destructive) {
					await enqueue(async () => {
						const stored = await repository.jobs();
						for (const job of stored)
							if (["preparing", "uploading"].includes(job.status)) {
								job.status = "interrupted";
								job.auto = false;
								await repository.putJob(job);
							}
						jobs = new Map(stored.map((job) => [job.id, job]));
						publishUploads();
					});
					changingContext--;
					void pump();
				}
			}
			if (action === "unlock")
				for (const job of jobs.values())
					if (job.auto && job.status === "awaiting")
						void retry([job.id]).catch(() => {});
			return result;
		}
		if (payload.epoch !== identity.epoch) throw canceled();
		switch (name) {
			case "view.open": {
				const existing = views.get(payload.id);
				if (existing?.clientId === client.id) {
					publishView(existing);
					return existing.id;
				}
				const view = {
					id: payload.id,
					clientId: client.id,
					query: payload.query || "",
					ids: [],
					additions: new Set(),
					next: null,
					loading: false,
					status: "",
					empty: null,
					revision: 0,
				};
				if (views.has(view.id)) throw new Error("View already exists.");
				views.set(view.id, view);
				publishView(view);
				if (sessionState().unlocked)
					void search(view, view.query).catch(() => {});
				return view.id;
			}
			case "view.close": {
				const view = ownedView(client, payload.id);
				view.controller?.abort();
				views.delete(view.id);
				return true;
			}
			case "view.search":
				return search(ownedView(client, payload.id), payload.query);
			case "view.more": {
				const view = ownedView(client, payload.id);
				return search(view, view.query, true);
			}
			case "media.content":
				return content(client, payload.id, signal);
			case "media.retag":
				return mutateMedia(payload.id, async (item, options) => {
					if (!item.metadata || item.metadataUnavailable)
						throw new Error("No metadata to update.");
					if (payload.metaHash !== item.metaHash)
						throw new Error(
							"This file changed in another page. Latest tags loaded; review and try again.",
						);
					const metadata = { ...item.metadata, tags: uniqueTags(payload.tags) };
					const result = await http.updateMetadata({
						...options,
						metadata,
						thumb: item.thumb,
						prevMetaHash: item.metaHash,
					});
					guard(identity.epoch, options.signal);
					if (result.conflict) {
						if (result.item.metadata)
							Object.assign(item, result.item, { metadataUnavailable: false });
						else item.metadataUnavailable = true;
						item.message = result.item.metadata
							? "This file changed in another page. Latest tags loaded; review and try again."
							: "This file changed in another page, but its metadata could not be opened. Your draft is preserved.";
						item.error = true;
					} else
						Object.assign(item, {
							metadata,
							tokens: result.tokens,
							metaHash: result.metaHash,
							metadataUnavailable: false,
						});
					mutationRevision++;
					refreshViews();
					return !result.conflict;
				});
			case "media.remove":
				return mutateMedia(payload.id, async (item, options) => {
					await http.remove(options);
					options.signal.throwIfAborted();
					item.deleted = true;
					downloads.get(item.id)?.controller.abort();
					mutationRevision++;
					return true;
				});
			case "uploads.submit":
				return submit(client, payload.sources);
			case "uploads.retry":
				return retry(payload.ids);
			case "uploads.discard":
				return enqueue(async () => {
					for (const id of payload.ids) {
						const job = jobs.get(id);
						if (["preparing", "uploading"].includes(job?.status))
							throw new Error("Upload is busy.");
						await repository.removeJob(id);
						jobs.delete(id);
					}
					publishUploads();
					return true;
				});
			case "pending.get": {
				credentials();
				const epoch = identity.epoch;
				const source = await repository.getSource(payload.id);
				guard(epoch, signal);
				return source?.blob ? { blob: source.blob, name: source.name } : null;
			}
			case "pending.send":
				return enqueue(async () => {
					guard(payload.epoch);
					credentials();
					const job = jobs.get(payload.id);
					if (!job || job.status === "completed") return false;
					if (["queued", "preparing", "uploading"].includes(job.status))
						return true;
					await persistJob({
						...job,
						tags: payload.tags || "",
						status: "queued",
						auto: false,
						error: "",
						serverUrl: sessionState().serverUrl,
						generation: get(identity).identityGeneration,
					});
					queueMicrotask(() => void pump());
					return true;
				});
			case "pairing.send":
			case "pairing.receive": {
				if (get(pairing).active) throw new Error("Pairing is already active.");
				return name === "pairing.send"
					? pairing.send()
					: pairing.receive(
							payload.code,
							payload.password,
							payload.serverUrl || sessionState().serverUrl,
						);
			}
			case "pairing.approve":
			case "pairing.cancel":
			case "pairing.rejectVerification":
				pairing[name.slice(8)]();
				return true;
			default:
				throw new Error("Unknown service command.");
		}
	}
	function disconnect(id) {
		const client = clients.get(id);
		if (!client) return;
		clients.delete(id);
		for (const controller of client.requests.values()) controller.abort();
		for (const view of [...views.values()])
			if (view.clientId === id) {
				view.controller?.abort();
				views.delete(view.id);
			}
		for (const helper of helpers.values())
			if (helper.clientId === id) helper.finish(null);
	}
	return {
		ready,
		instanceId,
		async authorizeKey(publicKey, serverUrl, signal) {
			const captured = credentials();
			if (new URL(captured.serverUrl).origin !== new URL(serverUrl).origin)
				throw new Error("Authorizing library must use the same server.");
			const epoch = identity.epoch;
			const combined = AbortSignal.any([identity.signal, signal]);
			await http.registerAuthenticatedKey({
				...captured,
				publicKey,
				signal: combined,
			});
			guard(epoch, combined);
		},
		connect(deliver) {
			const client = {
				id: crypto.randomUUID(),
				send: deliver,
				sequence: 0,
				requests: new Map(),
			};
			clients.set(client.id, client);
			ready
				.then(() => send(client, { type: "snapshot", value: snapshot(client) }))
				.catch((error) =>
					send(client, { type: "fatal", error: error.message }),
				);
			return {
				id: client.id,
				async receive(message) {
					if (serviceTracing)
						traceMessage("client → owner", client.id, message);
					if (message.type === "detach") {
						disconnect(client.id);
						return;
					}
					if (message.type === "ping") {
						send(client, { type: "pong" });
						return;
					}
					if (message.type === "helperResult") {
						const helper = helpers.get(message.helperId);
						if (helper?.clientId === client.id) helper.finish(message.value);
						return;
					}
					if (message.type === "cancel") {
						client.requests.get(message.requestId)?.abort();
						return;
					}
					if (message.type !== "command" || message.instanceId !== instanceId)
						return;
					if (client.requests.has(message.requestId)) return;
					const controller = new AbortController();
					client.requests.set(message.requestId, controller);
					try {
						const value = await dispatch(
							client,
							message.name,
							message.payload || {},
							controller.signal,
						);
						send(client, {
							type: "reply",
							requestId: message.requestId,
							value,
						});
					} catch (error) {
						send(client, { type: "snapshot", value: snapshot(client) });
						send(client, {
							type: "reply",
							requestId: message.requestId,
							error: {
								message: error.message || "Operation failed.",
								name: error.name,
							},
						});
					} finally {
						client.requests.delete(message.requestId);
					}
				},
				disconnect: () => disconnect(client.id),
			};
		},
		async contextUpload(source, withTags) {
			await ready;
			const client = { id: "background" };
			const result = await submit(client, [source], {
				auto: !withTags,
				context: true,
			});
			const id = result.ids[0];
			if (!id) {
				await platform.notify?.(
					result.failures[0]?.error || "Nothing to upload.",
				);
				return;
			}
			if (withTags || !sessionState().unlocked)
				await platform.openUpload?.(id, withTags ? "upload" : "unlock");
		},
		dispose() {
			disposed = true;
			clearTimeout(completionTimer);
			for (const id of [...clients.keys()]) disconnect(id);
			pairing.dispose();
			identity.dispose();
			unsubscribeIdentity();
			unsubscribePairing();
			repository.close?.();
		},
	};
}

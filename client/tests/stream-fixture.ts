import type {
	ContentSource,
	ContentStreams,
} from "../src/lib/stores/content-streams.ts";
import { deferred } from "./helpers.ts";
export function streamFixture() {
	const previews: {
		source: ContentSource;
		signal?: AbortSignal;
		disposed: boolean;
	}[] = [];
	const downloads: ContentSource[] = [];
	const finish = deferred();
	const invalidated: string[] = [];
	const streams: ContentStreams = {
		async open(source, signal) {
			const lease = { source, signal, disposed: false };
			previews.push(lease);
			const dispose = () => {
				lease.disposed = true;
			};
			signal?.addEventListener("abort", dispose, { once: true });
			return {
				url: "/__content/preview",
				downloadUrl: "/__content/download",
				dispose,
			};
		},
		async download(source, start) {
			downloads.push(source);
			await start("/__content/download");
			await finish.promise;
		},
		invalidate: (id) => {
			invalidated.push(id);
		},
		dispose() {},
	};
	return { streams, previews, downloads, finish, invalidated };
}

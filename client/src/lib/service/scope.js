import { get, writable } from "svelte/store";

// Page selection is local; every command captures its library before awaiting.
export function createLibraryClient(
	client,
	initialId,
	onSelect = () => {},
	jobId,
) {
	const state = writable({
		session: {
			ready: false,
			configured: false,
			unlocked: false,
			serverUrl: "",
			epoch: 0,
		},
		uploads: [],
		media: {},
		views: {},
		pairing: { active: false },
	});
	let selected = initialId,
		selection = 0;
	const unsubscribe = client.subscribe((value) => {
		const entries = [...(value.catalog || []), ...(value.setups || [])];
		if (jobId) {
			const destination = Object.entries(value.libraries || {}).find(
				([, state]) => state.uploads.some((job) => job.id === jobId),
			)?.[0];
			if (destination && destination !== selected) {
				selected = destination;
				selection++;
				onSelect(selected);
			}
		}
		if (entries.length && !entries.some((row) => row.id === selected)) {
			selected = entries[0].id;
			selection++;
			onSelect(selected);
		}
		const catalog = (value.catalog || []).map((row) => ({
			...row,
			...value.libraries?.[row.id]?.session,
		}));
		const scoped = value.libraries?.[selected];
		if (scoped)
			state.set({
				...scoped,
				connected: value.connected,
				instanceId: `${value.instanceId}:${scoped.runtimeId}:${selected}:${selection}`,
				clientId: value.clientId,
				libraryId: selected,
				libraryName: entries.find((row) => row.id === selected)?.name,
				catalog,
			});
		else if (value.session) state.set(value); // Internal single-runtime test adapter.
	});
	return {
		ready: client.ready,
		subscribe: state.subscribe,
		id: () => selected,
		select(id) {
			if (
				![...get(client).catalog, ...(get(client).setups || [])].some(
					(row) => row.id === id,
				)
			)
				throw new Error("Library is no longer saved.");
			selected = id;
			selection++;
			onSelect(id);
			state.set({
				...get(client).libraries[id],
				connected: get(client).connected,
				instanceId: `${get(client).instanceId}:${get(client).libraries[id].runtimeId}:${id}:${selection}`,
				clientId: get(client).clientId,
				libraryId: id,
				libraryName: [
					...get(client).catalog,
					...(get(client).setups || []),
				].find((row) => row.id === id)?.name,
				catalog: get(client).catalog.map((row) => ({
					...row,
					...get(client).libraries[row.id]?.session,
				})),
			});
		},
		command(name, payload = {}, options) {
			const current = get(state);
			const libraryId = selected;
			return client.command(
				name,
				{
					...payload,
					...(libraryId ? { libraryId } : {}),
					epoch: payload.epoch ?? current.session.epoch,
				},
				options,
			);
		},
		rootCommand: client.command,
		dispose: unsubscribe,
	};
}

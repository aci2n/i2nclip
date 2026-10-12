export const eligibleAuthorizers = (catalog = []) =>
	catalog.filter(
		(row) => row.configured && row.unlocked && !row.busy && !row.pairingActive,
	);

export function normalizeAuthorizer(draft, catalog, preferredId) {
	const eligible = eligibleAuthorizers(catalog);
	const authorizerLibraryId = eligible.some(
		(row) => row.id === draft.authorizerLibraryId,
	)
		? draft.authorizerLibraryId
		: eligible.find((row) => row.id === preferredId)?.id ||
			eligible[0]?.id ||
			"";
	return {
		authorizerLibraryId,
		mode:
			draft.mode === "authorize" && !eligible.length ? "create" : draft.mode,
	};
}

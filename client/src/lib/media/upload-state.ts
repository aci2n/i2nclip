export interface UploadState {
	notices: { name: string; message: string }[];
	uploading: boolean;
	progress: {
		name: string;
		index: number;
		total: number;
		percent: number;
		phase: "preparing" | "uploading";
	} | null;
	failures: { name: string; error: string }[];
	completed: { id: string; name: string }[];
	status: string;
}

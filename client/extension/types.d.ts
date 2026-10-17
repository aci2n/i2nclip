export interface CaptureContext {
	label?: string;
	title?: string;
	url?: string;
}
export interface CaptureExtra {
	sourceUrl?: string;
	sourceTitle?: string;
}
export type BridgeRequest =
	| { type: "probe" }
	| { type: "file"; file: File; extra?: CaptureExtra };
export interface BridgeReply {
	ok: boolean;
	error?: string;
	unavailable?: boolean;
	needsUnlock?: boolean;
}
declare global {
	var i2nclipBridgeInstalled: boolean | undefined;
}

export interface CaptureTab {
	id?: number;
	windowId?: number;
	url?: string;
	title?: string;
	status?: string;
}
export interface HandoffBrowser {
	tabs: {
		query(options: { url: string }): Promise<CaptureTab[]>;
		create(options: { url: string; active: boolean }): Promise<CaptureTab>;
		get(id: number): Promise<CaptureTab>;
		sendMessage(
			id: number,
			message: {
				channel: string;
				appUrl: string;
				request: BridgeRequest;
				timeout: number;
			},
			options: { frameId: number },
		): Promise<BridgeReply | undefined>;
		update(id: number, options: { active: boolean }): Promise<unknown>;
	};
	windows: {
		update(id: number, options: { focused: boolean }): Promise<unknown>;
	};
	scripting: {
		executeScript(options: {
			target: { tabId: number };
			func: () => void;
		}): Promise<unknown>;
	};
}

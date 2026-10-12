/**
 * Wire contract shared by MessagePort and Firefox runtime.Port hosts.
 * Every server message carries instanceId, clientId and a per-connection sequence.
 * Passwords/source blobs are command payloads, never broadcast state.
 *
 * @typedef {{ready:boolean, configured:boolean, unlocked:boolean, serverUrl:string,
 * publicKey:string, pendingRegistration: null | {serverUrl:string, publicKey:string},
 * epoch:number, busy:boolean, error:string}} SessionSnapshot
 * @typedef {'awaiting'|'queued'|'preparing'|'uploading'|'completed'|'failed'|'paused'|'interrupted'} UploadStatus
 * @typedef {{id:string, batchId:string, name:string, tags:string|string[], status:UploadStatus,
 * progress:number|null, error:string, createdAt:number, order:number, auto:boolean, libraryId:string,
 * context:boolean, clientId:string, serverUrl:string, generation:string|null,
 * attemptId?:string}} UploadSnapshot
 * @typedef {{id:string, query:string, ids:string[], next:string|null, loading:boolean,
 * status:string, empty:null|'search'|'library'}} ViewSnapshot
 * @typedef {{session:SessionSnapshot, uploads:UploadSnapshot[], pairing:object,
 * media:Record<string, object>, views:Record<string, ViewSnapshot>,runtimeId:string}} LibraryState
 * @typedef {{catalog:Array<{id:string,name:string}>, libraries:Record<string,LibraryState>}} ServiceSnapshot
 * @typedef {'identity.create'|'identity.restore'|'identity.unlock'|'identity.setServer'|
 * 'identity.reset'|'identity.discardCreation'|'identity.backup'|'view.open'|'view.close'|
 * 'view.search'|'view.more'|'media.content'|'media.retag'|'media.remove'|'uploads.submit'|
 * 'uploads.retry'|'uploads.discard'|'pending.get'|'pending.send'|'pairing.send'|
 * 'pairing.receive'|'pairing.approve'|'pairing.rejectVerification'|'pairing.cancel'|'libraries.add'|'libraries.rename'|'libraries.forget'|'libraries.reset'|'snapshot'} CommandName
 * @typedef {{type:'command', instanceId:string, requestId:string, name:CommandName,
 * payload:object & {epoch:number,libraryId?:string,runtimeId?:string}}} CommandMessage
 * @typedef {{instanceId:string, clientId:string, sequence:number, type:string,
 * libraryId?:string,value?:any, topic?:string, requestId?:string, error?:any}} ServiceMessage
 * @typedef {{send:(message:object)=>void,
 * listen:(listener:(message:ServiceMessage)=>void)=>(()=>void), disconnect:()=>void,
 * onDisconnect?:(listener:()=>void)=>(()=>void)}} ServiceTransport
 */
export {};

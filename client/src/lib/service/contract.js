/**
 * Wire contract shared by MessagePort and Firefox runtime.Port hosts.
 * Every server message carries instanceId, clientId and a per-connection sequence.
 * Passwords/source blobs are command payloads, never broadcast state.
 *
 * @typedef {{ready:boolean, configured:boolean, unlocked:boolean, serverUrl:string,
 * publicKey:string,
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
 * @typedef {{vault:{ready:boolean,status:"uninitialized"|"locked"|"unlocked",epoch:number,busy:boolean,error:string},catalog:Array<{id:string,name:string}>, setup:null|({id:string}&LibraryState), libraries:Record<string,LibraryState>}} ServiceSnapshot
 * @typedef {'identity.create'|'identity.setServer'|
 * 'identity.reset'|'view.open'|'view.close'|
 * 'view.search'|'view.more'|'media.content'|'media.retag'|'media.remove'|'uploads.submit'|
 * 'uploads.retry'|'uploads.discard'|'pending.get'|'pending.send'|'pairing.send'|
 * 'pairing.receive'|'pairing.approve'|'pairing.rejectVerification'|'pairing.cancel'|'setup.open'|'setup.close'|'libraries.rename'|'libraries.forget'|'libraries.reset'|'vault.initialize'|'vault.unlock'|'vault.lock'|'vault.reset'|'vault.changePassword'|'vault.export'|'vault.previewRecovery'|'vault.importRecovery'|'vault.contextUpload'|'snapshot'} CommandName
 * @typedef {{type:'command', instanceId:string, requestId:string, name:CommandName,
 * payload:object & {epoch:number,libraryId?:string,runtimeId?:string,setupId?:string}}} CommandMessage
 * @typedef {{instanceId:string, clientId:string, sequence:number, type:string,
 * libraryId?:string,value?:any, topic?:string, requestId?:string, error?:any}} ServiceMessage
 * @typedef {{send:(message:object)=>void,
 * listen:(listener:(message:ServiceMessage)=>void)=>(()=>void), disconnect:()=>void,
 * onDisconnect?:(listener:()=>void)=>(()=>void)}} ServiceTransport
 */
export {};

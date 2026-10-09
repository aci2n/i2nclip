import { get, writable } from 'svelte/store';
import { list } from '../api.js';
import { sendUpload } from '../media.js';

export function createLibrary(session, platform, api = { list, sendUpload }) {
  const state = writable({ items: [], next: null, loading: false, status: '', uploadStatus: '', uploading: false, epoch: 0 });
  let credentials = null;
  let tags = '';
  let revision = 0;
  let request;
  let uploadRequest;
  let disposed = false;

  function invalidate() {
    revision++;
    request?.abort();
    uploadRequest?.abort();
    state.update((value) => ({ ...value, items: [], next: null, loading: false, status: '', uploadStatus: '', uploading: false, epoch: value.epoch + 1 }));
  }

  async function load(more = false) {
    if (!credentials || disposed || (more && (get(state).loading || !get(state).next))) return;
    if (!more) { revision++; request?.abort(); }
    const version = revision;
    const captured = credentials;
    const controller = new AbortController();
    request = controller;
    const after = more ? get(state).next : null;
    state.update((value) => ({ ...value, items: more ? value.items : [], next: more ? value.next : null, loading: true, status: 'Loading…', epoch: value.epoch + (more ? 0 : 1) }));
    try {
      const page = await api.list({ ...captured, tags, after, signal: controller.signal });
      if (disposed || version !== revision || controller.signal.aborted) return;
      state.update((value) => ({ ...value, items: more ? [...value.items, ...page.items] : page.items, next: page.next,
        status: !more && !page.items.length ? 'Nothing stored for those tags.' : '' }));
    } catch (error) {
      if (!disposed && version === revision && !controller.signal.aborted) state.update((value) => ({ ...value, status: error.message }));
    } finally {
      if (!disposed && version === revision) state.update((value) => ({ ...value, loading: false }));
    }
  }

  const unsubscribe = session.subscribe((value) => {
    const next = value.ready && value.wrappedKey && value.privateKey ? { serverUrl: value.serverUrl, privateKey: value.privateKey } : null;
    if (next?.serverUrl === credentials?.serverUrl && next?.privateKey === credentials?.privateKey) return;
    invalidate();
    credentials = next;
    if (credentials) load();
  });

  return {
    subscribe: state.subscribe,
    search(value = tags) { tags = value; return load(); },
    more: () => load(true),
    credentials: () => credentials,
    async upload(files) {
      if (!credentials || get(state).uploading) return;
      const captured = credentials;
      const controller = new AbortController();
      uploadRequest = controller;
      state.update((value) => ({ ...value, uploading: true }));
      try {
        for (let index = 0; index < files.length; index++) {
          controller.signal.throwIfAborted();
          const progress = (percent) => {
            if (!disposed && credentials === captured && !controller.signal.aborted) state.update((value) => ({ ...value, uploadStatus: `Uploading ${index + 1}/${files.length} (${percent}%)` }));
          };
          progress(0);
          await api.sendUpload({ blob: files[index], name: files[index].name }, captured, platform, '', progress, controller.signal);
        }
        if (credentials === captured && !controller.signal.aborted) { state.update((value) => ({ ...value, uploadStatus: '' })); await load(); }
      } catch (error) {
        if (!disposed && credentials === captured && !controller.signal.aborted) state.update((value) => ({ ...value, uploadStatus: error.message }));
      } finally {
        if (!disposed && credentials === captured && !controller.signal.aborted) state.update((value) => ({ ...value, uploading: false }));
      }
    },
    dispose() { disposed = true; invalidate(); unsubscribe(); },
  };
}

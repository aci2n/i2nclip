import { get, writable } from 'svelte/store';
import { splitTags } from '../crypto.js';
import { list } from '../api.js';
import { sendUpload } from '../media.js';

export function createLibrary(session, platform, api = { list, sendUpload }) {
  const state = writable({ items: [], next: null, loading: false, empty: null, status: '', uploadStatus: '', uploading: false, uploadProgress: null, uploadFailures: [], epoch: 0 });
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
    state.update((value) => ({ ...value, items: [], next: null, loading: false, empty: null, status: '', uploadStatus: '', uploading: false, uploadProgress: null, uploadFailures: [], epoch: value.epoch + 1 }));
  }

  async function load(more = false) {
    if (!credentials || disposed || (more && (get(state).loading || !get(state).next))) return;
    if (!more) { revision++; request?.abort(); }
    const version = revision;
    const captured = credentials;
    const controller = new AbortController();
    request = controller;
    const after = more ? get(state).next : null;
    state.update((value) => ({ ...value, items: more ? value.items : [], next: more ? value.next : null, loading: true, empty: null, status: 'Loading…', epoch: value.epoch + (more ? 0 : 1) }));
    try {
      const page = await api.list({ ...captured, tags, after, signal: controller.signal });
      if (disposed || version !== revision || controller.signal.aborted) return;
      state.update((value) => ({ ...value, items: more ? [...value.items, ...page.items] : page.items, next: page.next,
        empty: !more && !page.items.length ? (splitTags(tags).length ? 'search' : 'library') : null, status: '' }));
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

  async function upload(files) {
    if (disposed || !credentials || get(state).uploading || !files.length) return;
    const captured = credentials;
    const controller = new AbortController();
    uploadRequest = controller;
    const current = () => !disposed && credentials === captured && uploadRequest === controller && !controller.signal.aborted;
    let uploaded = 0;
    state.update((value) => ({ ...value, uploading: true, uploadStatus: '' }));
    try {
      for (let index = 0; index < files.length; index++) {
        controller.signal.throwIfAborted();
        const file = files[index];
        const progress = (percent) => {
          if (current()) state.update((value) => ({ ...value, uploadProgress: { name: file.name, index: index + 1, total: files.length, percent } }));
        };
        progress(0);
        try {
          await api.sendUpload({ blob: file, name: file.name }, captured, platform, '', progress, controller.signal);
          controller.signal.throwIfAborted();
          uploaded++;
          if (current()) state.update((value) => ({ ...value, uploadFailures: value.uploadFailures.filter((failure) => failure.file !== file) }));
        } catch (error) {
          controller.signal.throwIfAborted();
          if (current()) state.update((value) => ({ ...value, uploadFailures: [...value.uploadFailures.filter((failure) => failure.file !== file), { file, error: error.message }] }));
        }
      }
      if (current()) {
        state.update((value) => ({ ...value, uploadStatus: `${uploaded} file${uploaded === 1 ? '' : 's'} uploaded.`, uploadProgress: null }));
        if (uploaded) await load();
      }
    } catch (error) {
      if (current()) state.update((value) => ({ ...value, uploadStatus: error.message }));
    } finally {
      if (current()) {
        state.update((value) => ({ ...value, uploading: false, uploadProgress: null }));
        uploadRequest = null;
      }
    }
  }

  return {
    subscribe: state.subscribe,
    search(value = tags) { tags = value; return load(); },
    more: () => load(true),
    credentials: () => credentials,
    updateTags(id, metadata) {
      if (!disposed) state.update((value) => ({ ...value, items: value.items.map((item) => item.id === id ? { ...item, metadata } : item) }));
    },
    upload,
    retryUploads: () => upload(get(state).uploadFailures.map(({ file }) => file)),
    dispose() { disposed = true; invalidate(); unsubscribe(); },
  };
}

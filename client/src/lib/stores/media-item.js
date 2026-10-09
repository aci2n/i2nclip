import { get, writable } from 'svelte/store';
import { getContent, remove, updateMetadata } from '../api.js';
import { splitTags, tagTokens } from '../crypto.js';
import { audioArt } from '../audio-art.js';
import { sniffContentType } from '../metadata.js';
import { downloadName } from '../format.js';

export function createMediaItem(item, credentials, platform, api = { getContent, remove, updateMetadata }) {
  const urls = new Set();
  const controller = new AbortController();
  const signal = controller.signal;
  let disposed = false;
  let pending;
  let bytes;
  const makeUrl = (data, type) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    urls.add(url);
    return url;
  };
  const state = writable({ ...item, busy: false, deleted: false, shown: false, progress: null, message: '', url: '', preview: item.thumb?.length ? makeUrl(item.thumb, 'image/webp') : '' });
  const options = { ...credentials, id: item.id, signal };

  // This advisory check never replaces an action's result.
  if (item.metadata) tagTokens(credentials.privateKey, item.metadata.tags || []).then((expected) => {
    if (!disposed && get(state).metadata === item.metadata && !get(state).message
        && (expected.length !== (item.tokens || []).length || expected.some((token) => !item.tokens.includes(token)))) {
      state.update((value) => ({ ...value, message: 'Tags on the server do not match this file.' }));
    }
  }).catch(() => {});

  async function run(action) {
    if (disposed || get(state).busy || get(state).deleted) return null;
    state.update((value) => ({ ...value, busy: true, message: '' }));
    try { return await action(); }
    catch (error) {
      if (!disposed) state.update((value) => ({ ...value, message: error.message }));
      return null;
    } finally {
      if (!disposed) state.update((value) => ({ ...value, busy: false, progress: null }));
    }
  }

  async function content() {
    if (get(state).url) return get(state).url;
    pending ??= api.getContent({ ...options, onProgress: (progress) => {
      if (!disposed) state.update((value) => ({ ...value, progress }));
    } }).then((result) => {
      signal.throwIfAborted();
      bytes = result;
      const type = get(state).metadata?.content_type || 'application/octet-stream';
      const url = makeUrl(bytes, type);
      state.update((value) => ({ ...value, url }));
      return url;
    }).catch((error) => { pending = null; throw error; });
    return pending;
  }

  return {
    subscribe: state.subscribe,
    reveal: () => run(async () => {
      const url = await content();
      signal.throwIfAborted();
      const type = get(state).metadata?.content_type || '';
      const art = type.startsWith('audio/') ? audioArt(bytes) : null;
      state.update((value) => ({ ...value, shown: true, preview: art ? makeUrl(art, sniffContentType(art, '')) : value.preview }));
      return url;
    }),
    download: () => run(async () => {
      const url = await content();
      signal.throwIfAborted();
      const metadata = get(state).metadata;
      await platform.download(url, downloadName(metadata?.name || item.id, metadata?.content_type));
    }),
    retag: (tags) => run(async () => {
      const value = get(state);
      if (!value.metadata) throw new Error('No metadata to update.');
      const metadata = { ...value.metadata, tags: splitTags(tags) };
      const result = await api.updateMetadata({ ...options, metadata, thumb: item.thumb });
      signal.throwIfAborted();
      state.update((current) => ({ ...current, metadata, tokens: result.tokens, message: 'Updated.' }));
    }),
    remove: () => run(async () => {
      await api.remove(options);
      signal.throwIfAborted();
      bytes = null;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      state.update((value) => ({ ...value, deleted: true, url: '', preview: '' }));
      return true;
    }),
    dispose() {
      disposed = true;
      controller.abort();
      bytes = null;
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    },
  };
}

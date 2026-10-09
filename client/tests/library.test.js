import assert from 'node:assert/strict';
import test from 'node:test';
import { get, writable } from 'svelte/store';
import { createLibrary } from '../src/lib/stores/library.js';

const identity = { ready: true, wrappedKey: {}, serverUrl: 'https://clip.example', privateKey: 'first' };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t) {
  const session = writable(identity);
  const calls = [];
  const uploads = [];
  const library = createLibrary(session, {}, {
    list(options) { const job = deferred(); calls.push({ ...job, options }); return job.promise; },
    sendUpload(source, credentials, platform, tags, progress, signal) {
      const job = deferred(); uploads.push({ ...job, source, credentials, signal, progress }); return job.promise;
    },
  });
  t.after(library.dispose);
  return { session, calls, uploads, library };
}

test('a stale search cannot replace the latest results, even if cancellation is ignored', async (t) => {
  const { library, calls } = setup(t);
  const search = library.search('new');
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve({ items: [{ id: 'new' }], next: null });
  await search;
  calls[0].resolve({ items: [{ id: 'old' }], next: 'old-cursor' });
  await tick();
  assert.deepEqual(get(library).items, [{ id: 'new' }]);
  assert.equal(get(library).next, null);
});

test('pagination uses the submitted tags and allows only one request at a time', async (t) => {
  const { library, calls } = setup(t);
  const search = library.search('vacation');
  calls[1].resolve({ items: [{ id: 'first' }], next: 'cursor' });
  await search;
  const more = library.more();
  await library.more();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.tags, 'vacation');
  assert.equal(calls[2].options.after, 'cursor');
  calls[2].resolve({ items: [{ id: 'second' }], next: null });
  await more;
  assert.deepEqual(get(library).items.map((item) => item.id), ['first', 'second']);
});

test('changing identity clears results and invalidates pending requests', async (t) => {
  const { session, library, calls } = setup(t);
  session.set({ ...identity, privateKey: 'second' });
  assert.equal(calls[0].options.signal.aborted, true);
  calls[1].resolve({ items: [{ id: 'second-library' }], next: null });
  await tick();
  calls[0].resolve({ items: [{ id: 'first-library' }], next: null });
  await tick();
  assert.deepEqual(get(library).items, [{ id: 'second-library' }]);
  session.set({ ...identity, privateKey: '' });
  assert.deepEqual(get(library).items, []);
});

test('uploads are serialized and a library change cancels the remaining batch', async (t) => {
  const { session, library, calls, uploads } = setup(t);
  calls[0].resolve({ items: [], next: null });
  await tick();
  const upload = library.upload([{ name: 'one' }, { name: 'two' }]);
  await library.upload([{ name: 'duplicate' }]);
  assert.equal(uploads.length, 1);
  uploads[0].resolve();
  await tick();
  assert.equal(uploads.length, 2);
  session.set({ ...identity, privateKey: '' });
  assert.equal(uploads[1].signal.aborted, true);
  uploads[1].reject(new DOMException('cancelled', 'AbortError'));
  await upload;
  assert.equal(get(library).uploadStatus, '');
  assert.equal(get(library).uploading, false);
});

test('a failed file does not stop a batch and retry sends only failed files', async (t) => {
  const { library, calls, uploads } = setup(t);
  calls[0].resolve({ items: [], next: null });
  await tick();
  const first = { name: 'failed' }, second = { name: 'saved' };
  const batch = library.upload([first, second]);
  assert.deepEqual(get(library).uploadProgress, { name: 'failed', index: 1, total: 2, percent: 0 });
  uploads[0].reject(new Error('temporary'));
  await tick();
  assert.equal(uploads[1].source.blob, second);
  uploads[1].resolve();
  await tick();
  calls[1].resolve({ items: [{ id: 'saved' }], next: null });
  await batch;
  assert.deepEqual(get(library).uploadFailures, [{ file: first, error: 'temporary' }]);
  assert.equal(get(library).uploadStatus, '');
  uploads[0].progress(80);
  assert.equal(get(library).uploadProgress, null);
  const retry = library.retryUploads();
  uploads[1].progress(90);
  assert.equal(get(library).uploadProgress.name, 'failed');
  assert.equal(uploads[2].source.blob, first);
  uploads[2].resolve();
  await tick();
  calls[2].resolve({ items: [{ id: 'saved' }, { id: 'retried' }], next: null });
  await retry;
  assert.deepEqual(get(library).uploadFailures, []);
  assert.equal(uploads.length, 3);
});

test('server changes clear failed files and ignore late upload completion', async (t) => {
  const { session, library, calls, uploads } = setup(t);
  calls[0].resolve({ items: [], next: null });
  await tick();
  const batch = library.upload([{ name: 'old' }, { name: 'never-sent' }]);
  session.set({ ...identity, serverUrl: 'https://new.example' });
  calls[1].resolve({ items: [], next: null });
  uploads[0].resolve();
  await batch;
  assert.equal(uploads.length, 1);
  assert.equal(get(library).uploadProgress, null);
  assert.deepEqual(get(library).uploadFailures, []);
  assert.equal(get(library).uploadStatus, '');
  library.dispose();
  await library.upload([{ name: 'after-dispose' }]);
  assert.equal(uploads.length, 1);
});

import { get, writable } from 'svelte/store';
import { generatePrivateKey } from '../identity.js';
import { loadKey } from '../crypto.js';
import { registerKey } from '../api.js';
import { parseRecoveryFile, recoveryFile } from '../recovery.js';
import { unwrapPrivateKey, wrapPrivateKey } from '../vault.js';

export const DEFAULT_SERVER_URL = 'https://clip.i2n.duckdns.org';

export function createSession(platform) {
  const state = writable({ ready: false, serverUrl: DEFAULT_SERVER_URL, wrappedKey: null, privateKey: '', busy: false, error: '' });
  let revision = 0;
  let disposed = false;
  let busy = false;

  async function refresh() {
    const version = ++revision;
    try {
      const [local, session] = await Promise.all([
        platform.local.get(['serverUrl', 'wrappedKey', 'publicKey']), platform.session.get('privateKey'),
      ]);
      if (!disposed && version === revision) state.update((value) => ({
        ...value, ...local, ready: true, serverUrl: local.serverUrl || DEFAULT_SERVER_URL,
        wrappedKey: local.wrappedKey || null, privateKey: local.wrappedKey ? session.privateKey || '' : '',
      }));
    } catch (error) {
      if (!disposed && version === revision) state.update((value) => ({ ...value, ready: true, error: error.message }));
    }
  }
  const unsubscribe = platform.subscribe(refresh);
  const ready = refresh();

  async function mutate(action) {
    if (busy) return false;
    busy = true;
    state.update((value) => ({ ...value, busy: true, error: '' }));
    try {
      // One settings mutation across all open pages, including password derivation.
      const lock = globalThis.navigator?.locks;
      await (lock ? lock.request('i2nclip-session', action) : action());
      await refresh();
      return true;
    } catch (error) {
      state.update((value) => ({ ...value, error: error.message }));
      return false;
    } finally {
      busy = false;
      state.update((value) => ({ ...value, busy: false }));
    }
  }

  async function saveIdentity(serverUrl, privateKey, wrappedKey) {
    const loaded = await loadKey(privateKey);
    await platform.local.set({ serverUrl, wrappedKey, publicKey: loaded.registrationKey });
    await platform.session.set({ privateKey });
  }

  return {
    subscribe: state.subscribe,
    ready,
    refresh,
    create: ({ serverUrl, password, otc }) => mutate(async () => {
      if ((await platform.local.get('wrappedKey')).wrappedKey) throw new Error('A library is already configured.');
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (!otc.trim()) throw new Error('Enter an invitation code from the admin.');
      const created = await generatePrivateKey();
      const wrapped = await wrapPrivateKey(created.privateKey, password);
      try { await registerKey({ serverUrl, publicKey: created.publicKey, otc }); }
      catch (error) { throw new Error(`Registration failed: ${error.message}. Check your invitation code and try again.`); }
      await saveIdentity(serverUrl, created.privateKey, wrapped);
    }),
    restore: (file, password) => mutate(async () => {
      if ((await platform.local.get('wrappedKey')).wrappedKey) throw new Error('A library is already configured.');
      if (!file || file.size > 16_384) throw new Error('Invalid recovery file.');
      const recovered = parseRecoveryFile(await file.text());
      const privateKey = await unwrapPrivateKey(recovered.wrappedKey, password);
      await saveIdentity(recovered.serverUrl, privateKey, recovered.wrappedKey);
    }),
    unlock: (password) => mutate(async () => {
      const { wrappedKey } = await platform.local.get('wrappedKey');
      if (!wrappedKey) throw new Error('Create or restore your library in Settings.');
      const privateKey = await unwrapPrivateKey(wrappedKey, password);
      await loadKey(privateKey);
      await platform.session.set({ privateKey });
    }),
    setServer: (serverUrl) => mutate(() => platform.local.set({ serverUrl })),
    reset: () => mutate(async () => { await platform.session.clear(); await platform.local.clear(); }),
    backup: () => mutate(async () => {
      const file = recoveryFile(await platform.local.get(['serverUrl', 'wrappedKey', 'publicKey']));
      const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
      try { await platform.download(url, 'i2nclip-recovery.json'); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    }),
    credentials() {
      const { serverUrl, privateKey } = get(state);
      if (!privateKey) throw new Error('Unlock before uploading.');
      return { serverUrl, privateKey };
    },
    dispose() { disposed = true; revision++; unsubscribe(); },
  };
}

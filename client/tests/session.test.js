import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../src/lib/stores/session.js';

test('registration finishing after disposal cannot save an identity', async (t) => {
  let receive;
  const started = new Promise((resolve) => { receive = resolve; });
  let finish;
  let signal;
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    receive();
    return new Promise((resolve) => { finish = resolve; });
  });
  const storage = { get: async () => ({}), set: async () => { writes++; } };
  const session = createSession({ local: storage, session: storage, subscribe: () => () => {} });
  t.after(session.dispose);
  await session.ready;
  const create = session.create({ serverUrl: 'https://clip.example', password: 'password123', otc: 'code' });
  await started;
  session.dispose();
  assert.equal(signal.aborted, true);
  finish(new Response(null, { status: 204 }));
  assert.equal(await create, false);
  assert.equal(writes, 0);
  assert.equal(await session.setServer('https://other.example'), false);
});

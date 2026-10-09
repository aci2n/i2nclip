<script>
  let { session } = $props();
  let server = $state('');
  let serverInput;
  let password = $state('');
  let otc = $state('');
  let restorePassword = $state('');
  let recoveryFiles = $state();
  let status = $state('');
  const savedServer = $derived($session.serverUrl);
  $effect(() => { server = savedServer; });

  async function action(task, message) {
    if ($session.busy) return;
    status = '';
    if (await task()) status = message;
  }
  async function create(event) {
    event.preventDefault();
    if (!serverInput.reportValidity()) return;
    await action(() => session.create({ serverUrl: server.trim(), password, otc }), 'Library created. Download your recovery file before uploading.');
    if (!$session.error) { password = ''; otc = ''; }
  }
  async function restore(event) {
    event.preventDefault();
    await action(() => session.restore(recoveryFiles?.[0], restorePassword), 'Library restored and unlocked.');
    if (!$session.error) { restorePassword = ''; recoveryFiles = undefined; }
  }
</script>

<div id="settings" class="settings">
  <form id="server-settings" class="panel" onsubmit={(event) => { event.preventDefault(); action(() => session.setServer(server.trim()), 'Server URL updated.'); }}>
    <h2>Server</h2>
    <label for="server">Server URL</label>
    <div class="bar">
      <input id="server" bind:this={serverInput} type="url" required bind:value={server} disabled={$session.busy} />
      <button id="save-server" type="submit" disabled={$session.busy}>Update URL</button>
    </div>
  </form>
  <form id="create" class="panel" hidden={!!$session.wrappedKey} onsubmit={create}>
    <h2>Create your library</h2>
    <p>Files are encrypted in your browser before upload.</p>
    <label for="otc">Invitation code</label>
    <input id="otc" type="text" required autocomplete="off" spellcheck="false" bind:value={otc} disabled={$session.busy} />
    <label for="pass">Unlock password</label>
    <input id="pass" type="password" required minlength="8" autocomplete="new-password" bind:value={password} disabled={$session.busy} />
    <p>Use at least 8 characters. Your password is never stored or sent to the server.</p>
    <button id="create-library" type="submit" disabled={$session.busy}>Create library</button>
  </form>
  <section id="configured" class="panel" hidden={!$session.wrappedKey}>
    <h2>Your library</h2>
    <p>Keep a recovery file and remember your password. You need both to restore your library.</p>
    <button id="backup" disabled={$session.busy} onclick={() => action(session.backup, 'Recovery download started. Keep the file and your password somewhere safe.')}>Download recovery file</button>
  </section>
  <form id="restore-settings" class="panel" hidden={!!$session.wrappedKey} onsubmit={restore}>
    <h2>Restore your library</h2>
    <p>Choose your recovery file and enter its password.</p>
    <label for="file">Recovery file</label>
    <input id="file" type="file" required accept=".json,application/json" bind:files={recoveryFiles} disabled={$session.busy} />
    <label for="restore-pass">Recovery password</label>
    <input id="restore-pass" type="password" required autocomplete="current-password" bind:value={restorePassword} disabled={$session.busy} />
    <button id="restore" type="submit" disabled={$session.busy}>Restore library</button>
  </form>
  <section id="reset-settings" class="panel" hidden={!$session.wrappedKey}>
    <h2>Reset this browser</h2>
    <p>Keep a recovery file first. Uploads on the server stay saved.</p>
    <button id="reset" class="secondary" disabled={$session.busy} onclick={() => {
      if (confirm('Reset everything in this browser? Keep a recovery file first. Uploads on the server will stay saved.')) action(session.reset, 'Browser settings reset. Create a library or restore from a recovery file.');
    }}>Reset everything</button>
  </section>
</div>
<p id="status" role="status">{$session.error || status}</p>

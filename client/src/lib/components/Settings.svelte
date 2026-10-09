<script>
  let { session } = $props();
  let mode = $state('create');
  let server = $state('');
  let serverInput;
  let serverDetails;
  let password = $state('');
  let otc = $state('');
  let restorePassword = $state('');
  let recoveryFiles = $state();
  let feedback = $state({ scope: 'setup', text: '', error: false });
  const savedServer = $derived($session.serverUrl);
  const feedbackAt = $derived($session.wrappedKey && ['create', 'restore'].includes(feedback.scope)
    ? 'library' : feedback.scope === 'reset' && !$session.wrappedKey ? 'setup' : feedback.scope);
  $effect(() => { server = savedServer; });

  function navigateTabs(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    mode = event.key === 'Home' ? 'create' : event.key === 'End' ? 'restore' : mode === 'create' ? 'restore' : 'create';
    event.currentTarget.querySelector(`#${mode}-tab`).focus();
  }

  async function action(scope, task, message, pending = 'Working…') {
    if ($session.busy) return false;
    feedback = { scope, text: pending, error: false };
    const success = await task();
    feedback = { scope, text: success ? message : $session.error, error: !success };
    return success;
  }
  async function create(event) {
    event.preventDefault();
    if (!serverInput.checkValidity()) {
      serverDetails.open = true;
      serverInput.reportValidity();
      return;
    }
    if (await action('create', () => session.create({ serverUrl: server.trim(), password, otc }),
      'Library created. Download your recovery file before uploading.', 'Creating library…')) { password = ''; otc = ''; }
  }
  async function restore(event) {
    event.preventDefault();
    if (await action('restore', () => session.restore(recoveryFiles?.[0], restorePassword),
      'Library restored and unlocked.', 'Restoring library…')) { restorePassword = ''; recoveryFiles = undefined; }
  }
  async function reset() {
    if (!confirm('Reset everything in this browser? Keep a recovery file first. Uploads on the server will stay saved.')) return;
    if (await action('reset', session.reset, 'Browser settings reset. Create a library or restore from a recovery file.')) {
      mode = 'create'; password = ''; otc = ''; restorePassword = ''; recoveryFiles = undefined;
    }
  }
</script>

{#snippet notice(scope)}
  {#if feedbackAt === scope}
    <p id="status" class="feedback" class:error={feedback.error} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>
  {/if}
{/snippet}

<div id="settings" class="settings">
  {#if !$session.wrappedKey}
    <section class="panel">
      <h2>Your encrypted library</h2>
      <p>Files are encrypted in your browser before upload.</p>
      {@render notice('setup')}
      <div class="setup-tabs" role="tablist" tabindex="-1" aria-label="Library setup" onkeydown={navigateTabs}>
        <button id="create-tab" type="button" role="tab" aria-selected={mode === 'create'} tabindex={mode === 'create' ? 0 : -1} aria-controls="create-panel" disabled={$session.busy} onclick={() => { mode = 'create'; }}>Create</button>
        <button id="restore-tab" type="button" role="tab" aria-selected={mode === 'restore'} tabindex={mode === 'restore' ? 0 : -1} aria-controls="restore-panel" disabled={$session.busy} onclick={() => { mode = 'restore'; }}>Restore</button>
      </div>
      <div id="create-panel" role="tabpanel" aria-labelledby="create-tab" hidden={mode !== 'create'}>
      <form id="create" onsubmit={create}>
        <label for="otc">Invitation code</label>
        <input id="otc" type="text" required autocomplete="off" spellcheck="false" bind:value={otc} disabled={$session.busy} />
        <label for="pass">Unlock password</label>
        <input id="pass" type="password" required minlength="8" autocomplete="new-password" bind:value={password} disabled={$session.busy} />
        <p>Use at least 8 characters. Your password is never stored or sent to the server.</p>
        <button id="create-library" type="submit" disabled={$session.busy}>Create library</button>
        {@render notice('create')}
      </form>
      </div>
      <div id="restore-panel" role="tabpanel" aria-labelledby="restore-tab" hidden={mode !== 'restore'}>
      <form id="restore-settings" onsubmit={restore}>
        <p>Choose your recovery file and enter its password.</p>
        <label for="file">Recovery file</label>
        <input id="file" type="file" required accept=".json,application/json" bind:files={recoveryFiles} disabled={$session.busy} />
        <label for="restore-pass">Recovery password</label>
        <input id="restore-pass" type="password" required autocomplete="current-password" bind:value={restorePassword} disabled={$session.busy} />
        <button id="restore" type="submit" disabled={$session.busy}>Restore library</button>
        {@render notice('restore')}
      </form>
      </div>
    </section>
  {:else}
    <section id="configured" class="panel">
      <h2>Your library</h2>
      <p>Keep a recovery file and remember your password. You need both to restore your library.</p>
      <button id="backup" disabled={$session.busy} onclick={() => action('backup', session.backup, 'Recovery download started. Keep the file and your password somewhere safe.')}>Download recovery file</button>
      {@render notice('library')}
      {@render notice('backup')}
    </section>
    <details id="reset-settings" class="panel">
      <summary>Reset this browser</summary>
      <p>Keep a recovery file first. Uploads on the server stay saved.</p>
      <button id="reset" class="secondary danger" disabled={$session.busy} onclick={reset}>Reset everything</button>
      {@render notice('reset')}
    </details>
  {/if}
  <details id="server-details" class="panel" bind:this={serverDetails}>
    <summary>Server settings <span class="server-address">{savedServer}</span></summary>
    <form id="server-settings" onsubmit={(event) => { event.preventDefault(); action('server', () => session.setServer(server.trim()), 'Server URL updated.'); }}>
      <label for="server">Server URL</label>
      <div class="bar server-bar">
        <input id="server" bind:this={serverInput} type="url" required bind:value={server} disabled={$session.busy} />
        <button id="save-server" type="submit" disabled={$session.busy}>Update URL</button>
      </div>
      {@render notice('server')}
    </form>
  </details>
  {#if $session.error && !feedback.text}<p class="feedback error" role="alert">{$session.error}</p>{/if}
</div>

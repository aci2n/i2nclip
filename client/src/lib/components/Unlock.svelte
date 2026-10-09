<script>
  let { session, ondone = () => {}, id = 'unlock', statusId = 'unlock-status' } = $props();
  let password = $state('');
  async function submit(event) {
    event.preventDefault();
    if (await session.unlock(password)) { password = ''; await ondone(); }
  }
</script>

<form {id} onsubmit={submit} class="panel">
  <h2>Unlock your library</h2>
  <p>Your library stays unlocked for this browser session.</p>
  <label for="pass">Unlock password</label>
  <div class="bar">
    <input id="pass" type="password" required autocomplete="current-password" bind:value={password} disabled={$session.busy} />
    <button type="submit" disabled={$session.busy}>{$session.busy ? 'Unlocking…' : 'Unlock'}</button>
  </div>
  <p id={statusId} role="status">{$session.error}</p>
</form>

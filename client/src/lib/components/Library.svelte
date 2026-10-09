<script>
  import { onDestroy, untrack } from 'svelte';
  import { createLibrary } from '../stores/library.js';
  import Unlock from './Unlock.svelte';
  import MediaCard from './MediaCard.svelte';
  let { session, platform, settingsHref } = $props();
  const library = untrack(() => createLibrary(session, platform));
  let tags = $state('');
  let selected = $state(null);
  let dialog;
  const epoch = $derived($library.epoch);
  $effect(() => { epoch; selected = null; dialog?.close(); });
  function open(url, name) { selected = { url, name }; dialog.showModal(); }
  function close() { dialog.close(); selected = null; }
  onDestroy(library.dispose);
</script>

{#if !$session.wrappedKey}
  <section id="setup" class="panel empty"><h2>Your library starts here</h2><p><a href={settingsHref}>Create or restore your library</a> to start saving encrypted media.</p></section>
{:else if !$session.privateKey}
  <Unlock {session} />
{:else}
  <form id="find" class="bar toolbar" onsubmit={(event) => { event.preventDefault(); library.search(tags); }}>
    <input id="tags" type="search" placeholder="Search tags" aria-label="Tags, separated by commas" bind:value={tags} />
    <button type="submit">Search</button>
    <label class="file" class:disabled={$library.uploading}>Upload<input id="files" type="file" multiple disabled={$library.uploading} onchange={(event) => {
      const files = [...event.currentTarget.files]; event.currentTarget.value = ''; if (files.length) library.upload(files);
    }} /></label>
  </form>
{/if}
<p id="status" role="status">{[$library.status, $library.uploadStatus, (!$session.wrappedKey || $session.privateKey) ? $session.error : ''].filter(Boolean).join(' | ')}</p>
<div id="results">
  {#key $library.epoch}
    {#each $library.items as item (item.id)}
      <MediaCard {item} credentials={library.credentials()} {platform} onopen={open} onremove={close} />
    {/each}
  {/key}
</div>
{#if $library.next}<button id="more" disabled={$library.loading} onclick={library.more}>More</button>{/if}
<dialog id="full" bind:this={dialog} onclick={(event) => { if (event.target === dialog) close(); }} onclose={() => { selected = null; }}>
  {#if selected}<img src={selected.url} alt={selected.name} /><button class="close" aria-label="Close image" onclick={close}>×</button>{/if}
</dialog>

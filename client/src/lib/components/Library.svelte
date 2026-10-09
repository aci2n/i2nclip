<script>
  import { onDestroy, untrack } from 'svelte';
  import { createLibrary } from '../stores/library.js';
  import Unlock from './Unlock.svelte';
  import MediaCard from './MediaCard.svelte';
  import { uniqueTags } from '../tags.js';
  let { session, platform, settingsHref } = $props();
  const library = untrack(() => createLibrary(session, platform));
  let tags = $state('');
  let selected = $state(null);
  let dialog;
  let filesInput = $state();
  const epoch = $derived($library.epoch);
  const knownTags = $derived(uniqueTags($library.items.flatMap((item) => item.metadata?.tags || [])));
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
    <label class="file" class:disabled={$library.uploading}>Upload<input bind:this={filesInput} id="files" type="file" multiple disabled={$library.uploading} onchange={(event) => {
      const files = [...event.currentTarget.files]; event.currentTarget.value = ''; if (files.length) library.upload(files);
    }} /></label>
  </form>
{/if}
<p id="status" role="status">{[$library.status, $library.uploadStatus, (!$session.wrappedKey || $session.privateKey) ? $session.error : ''].filter(Boolean).join(' | ')}</p>
{#if $library.uploadProgress}
  <section class="upload-progress" aria-label="Upload progress">
    <p role="status">Uploading {$library.uploadProgress.index} of {$library.uploadProgress.total}: {$library.uploadProgress.name}</p>
    <progress max="100" value={$library.uploadProgress.percent} aria-label="Current file upload"></progress>
    <span>{$library.uploadProgress.percent}%</span>
  </section>
{/if}
{#if $library.uploadFailures.length}
  <section class="upload-failures" aria-label="Failed uploads">
    <h2>Failed uploads</h2>
    <ul>{#each $library.uploadFailures as failure}<li><strong>{failure.file.name}</strong>: {failure.error}</li>{/each}</ul>
    <button class="secondary" disabled={$library.uploading} onclick={library.retryUploads}>Retry failed files</button>
  </section>
{/if}
{#if $session.privateKey && $library.empty}
  <section id="empty-library" class="panel empty">
    {#if $library.empty === 'library'}
      <h2>Your library is empty</h2>
      <p>Upload a photo, video, or audio file to get started.</p>
      <button disabled={$library.uploading} onclick={() => filesInput.click()}>Upload files</button>
    {:else}
      <h2>No matching clips</h2>
      <p>Try different tags or clear your search to see all clips.</p>
      <button class="secondary" onclick={() => { tags = ''; library.search(''); }}>Clear search</button>
    {/if}
  </section>
{/if}
<div id="results">
  {#key $library.epoch}
    {#each $library.items as item (item.id)}
      <MediaCard {item} credentials={library.credentials()} {platform} onopen={open} onremove={close} suggestions={knownTags} onretag={(metadata) => library.updateTags(item.id, metadata)} />
    {/each}
  {/key}
</div>
{#if $library.next}<button id="more" disabled={$library.loading} onclick={library.more}>More</button>{/if}
<dialog id="full" bind:this={dialog} onclick={(event) => { if (event.target === dialog) close(); }} onclose={() => { selected = null; }}>
  {#if selected}<img src={selected.url} alt={selected.name} /><button class="close" aria-label="Close image" onclick={close}>×</button>{/if}
</dialog>

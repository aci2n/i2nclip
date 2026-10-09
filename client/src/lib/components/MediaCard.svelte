<script>
  import { onDestroy, untrack } from 'svelte';
  import { createMediaItem } from '../stores/media-item.js';
  import { fileSize, uploadedAt } from '../format.js';
  let { item, credentials, platform, onopen, onremove } = $props();
  const media = untrack(() => createMediaItem(item, credentials, platform));
  let tags = $state(untrack(() => item.metadata?.tags?.join(', ') || ''));
  const type = $derived($media.metadata?.content_type || '');
  const name = $derived($media.metadata?.name || item.id);
  const summary = $derived([type, $media.metadata?.image ? `${$media.metadata.image.width}×${$media.metadata.image.height}` : '', fileSize($media.metadata?.size), uploadedAt(item.createdAt)].filter(Boolean).join(' · '));
  async function reveal() {
    const url = await media.reveal();
    if (url && type.startsWith('image/')) onopen(url, name);
  }
  async function remove() {
    if (confirm(`Delete ${name}? This cannot be undone.`) && await media.remove()) onremove();
  }
  onDestroy(media.dispose);
</script>

<article class="card" class:busy={$media.busy} class:deleted={$media.deleted}>
  <div class="media">
    {#if type.startsWith('image/') && ($media.preview || $media.url)}
      <button class="image-button" aria-label={`Open ${name}`} onclick={reveal} disabled={$media.busy || $media.deleted}><img src={$media.shown ? $media.url : $media.preview} alt={name} /></button>
    {:else if type.startsWith('audio/') || type.startsWith('video/')}
      {#if $media.shown}
        {#if type.startsWith('audio/')}
          {#if $media.preview}<img src={$media.preview} alt={name} />{/if}
          <audio controls autoplay src={$media.url}></audio>
        {:else}
          <video controls autoplay src={$media.url}><track kind="captions" /></video>
        {/if}
      {:else}
        {#if $media.preview}<img src={$media.preview} alt={name} />{/if}
        <button class="play" data-act="play" aria-label={`Play ${name}`} onclick={reveal} disabled={$media.busy || $media.deleted}>▶</button>
      {/if}
    {:else if $media.preview}
      <img src={$media.preview} alt={name} />
    {/if}
    {#if $media.progress !== null}<span class="pct">{$media.progress}%</span>{/if}
  </div>
  <strong title={name}>{name}</strong>
  <p class="meta">{summary}</p>
  {#if $media.metadata}
    <form class="tags" onsubmit={(event) => { event.preventDefault(); media.retag(tags); }}>
      <div class="bar">
        <input aria-label={`Tags for ${name}`} placeholder="Tags, separated by commas" bind:value={tags} disabled={$media.busy || $media.deleted} />
        <button type="submit" class="secondary" disabled={$media.busy || $media.deleted}>Update</button>
      </div>
      <output>{$media.message}</output>
    </form>
  {:else}<output>{$media.message}</output>{/if}
  <div class="bar actions">
    {#if type.startsWith('image/') && !$media.preview && !$media.url}
      <button class="secondary" onclick={reveal} disabled={$media.busy || $media.deleted}>Open</button>
    {/if}
    <button class="secondary" data-act="download" onclick={media.download} disabled={$media.busy || $media.deleted}>Download</button>
    <button class="secondary" data-act="delete" onclick={remove} disabled={$media.busy || $media.deleted}>Delete</button>
  </div>
</article>

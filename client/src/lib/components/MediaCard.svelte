<script>
  import { onDestroy, untrack } from 'svelte';
  import { createMediaItem } from '../stores/media-item.js';
  import { fileSize, fileType, uploadedAt } from '../format.js';
  import TagInput from './TagInput.svelte';
  let { item, credentials, platform, onopen, onremove, suggestions = [], onretag = () => {} } = $props();
  const media = untrack(() => createMediaItem(item, credentials, platform));
  let tags = $state(untrack(() => item.metadata?.tags?.join(', ') || ''));
  const type = $derived($media.metadata?.content_type || '');
  const name = $derived($media.metadata?.name || item.id);
  const summary = $derived([fileType(type), fileSize($media.metadata?.size)].filter(Boolean).join(' · '));
  async function reveal() {
    const url = await media.reveal();
    if (url && type.startsWith('image/')) onopen(url, name);
  }
  async function remove() {
    if (confirm(`Delete ${name}? This cannot be undone.`) && await media.remove()) onremove();
  }
  async function saveTags(event) {
    event.preventDefault();
    const metadata = await media.retag(tags);
    if (metadata) { tags = metadata.tags.join(', '); onretag(metadata); }
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
          {#if $media.preview}<img src={$media.preview} alt={name} />{:else}<span class="file-type">{fileType(type)}</span>{/if}
          <audio controls autoplay src={$media.url}></audio>
        {:else}<video controls autoplay src={$media.url}><track kind="captions" /></video>{/if}
      {:else}
        {#if $media.preview}<img src={$media.preview} alt={name} />{:else}<span class="file-type">{fileType(type)}</span>{/if}
        <button class="play" data-act="play" aria-label={`Play ${name}`} onclick={reveal} disabled={$media.busy || $media.deleted}>▶</button>
      {/if}
    {:else if type.startsWith('image/') && !$media.deleted}
      <button class="image-button file-type" onclick={reveal} disabled={$media.busy}>Open image</button>
    {:else if $media.preview}
      <img src={$media.preview} alt={name} />
    {:else}<span class="file-type">{fileType(type)}</span>{/if}
    {#if $media.progress !== null}<span class="pct">{$media.progress}%</span>{/if}
  </div>
  <strong class="card-title" title={name}>{name}</strong>
  <p class="meta">{summary}</p>
  <div class="tag-list" aria-label={`Tags for ${name}`}>
    {#each ($media.metadata?.tags || []).slice(0, 3) as tag}<span class="tag">{tag}</span>{:else}<span class="muted">No tags</span>{/each}
    {#if ($media.metadata?.tags?.length || 0) > 3}<span class="muted">+{$media.metadata.tags.length - 3}</span>{/if}
  </div>
  {#if $media.metadata}
    <details class="tag-editor">
      <summary>Edit tags</summary>
      <form class="tags" onsubmit={saveTags}>
        <TagInput id={`tags-${item.id}`} bind:value={tags} {suggestions} label={`Edit tags for ${name}`} disabled={$media.busy || $media.deleted} />
        <button type="submit" class="secondary" disabled={$media.busy || $media.deleted}>Save tags</button>
      </form>
    </details>
  {/if}
  <details class="card-details">
    <summary>File details</summary>
    <dl>
      <dt>Filename</dt><dd>{name}</dd>
      <dt>Uploaded</dt><dd>{uploadedAt(item.createdAt)}</dd>
      {#if type}<dt>Type</dt><dd>{type}</dd>{/if}
      {#if $media.metadata?.image}<dt>Dimensions</dt><dd>{$media.metadata.image.width} × {$media.metadata.image.height}</dd>{/if}
    </dl>
  </details>
  <output class="feedback" class:error={$media.error}>{$media.message}</output>
  <div class="bar actions">
    <button class="secondary" data-act="download" onclick={media.download} disabled={$media.busy || $media.deleted}>Download</button>
    <button class="secondary danger" data-act="delete" onclick={remove} disabled={$media.busy || $media.deleted}>Delete</button>
  </div>
</article>

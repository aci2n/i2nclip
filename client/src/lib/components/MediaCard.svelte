<script>
  import { onDestroy, untrack } from 'svelte';
  import { createMediaItem } from '../stores/media-item.js';
  import { fileSize, fileType, uploadedAt } from '../format.js';
  import TagEditor from './TagEditor.svelte';
  let { item, credentials, platform, onopen, onremove, onretag = () => {} } = $props();
  const media = untrack(() => createMediaItem(item, credentials, platform));
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
  async function saveTags(tags) {
    const metadata = await media.retag(tags);
    if (metadata) onretag(metadata);
    return metadata;
  }
  onDestroy(media.dispose);
</script>

<article class="panel card" class:busy={$media.busy} class:deleted={$media.deleted}>
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
  {#if $media.metadata}
    <TagEditor tags={$media.metadata.tags || []} {name} disabled={$media.busy || $media.deleted} onsave={saveTags} />
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

<style>
  .card { padding: .75rem; display: flex; flex-direction: column; }
  .card-title { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; min-height: 2.8em; line-height: 1.4; margin-top: .75rem; }
  .card .meta { font-size: .85rem; margin: .5rem 0; }
  .card.deleted { opacity: .2; }
  .media { position: relative; aspect-ratio: 16 / 10; display: grid; place-items: center; overflow: hidden; border-radius: .3rem; background: var(--soft); }
  .media img, .media video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .media audio { position: absolute; bottom: .5rem; width: calc(100% - 1rem); }
  .image-button { border: 0; padding: 0; background: transparent; width: 100%; height: 100%; display: block; }
  .file-type { color: var(--accent); font-size: 1.1rem; letter-spacing: .08em; }
  .play { position: absolute; inset: 0; width: 100%; background: transparent; color: var(--accent); font-size: 2rem; }
  .media:has(img) .play { background: #0004; color: white; }
  .media:has(.play) .file-type { position: absolute; top: .5rem; left: .75rem; font-size: .8rem; }
  .pct { position: absolute; inset: 0; display: grid; place-items: center; background: #0006; color: white; }
  .card-details { margin: .5rem 0; color: var(--muted); font-size: .85rem; }
  dl { display: grid; gap: .25rem; margin: .75rem 0; font-size: .85rem; }
  dt { color: var(--muted); }
  dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
  .actions button { font-size: .85rem; padding: .3rem .5rem; }
  .actions { padding-top: .5rem; margin-top: auto; }
  output { display: block; }
</style>

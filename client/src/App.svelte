<script>
  import { onDestroy, untrack } from 'svelte';
  import { createSession } from './lib/stores/session.js';
  import Library from './lib/components/Library.svelte';
  import Settings from './lib/components/Settings.svelte';
  import Upload from './lib/components/Upload.svelte';
  import './app.css';
  let { platform, page = new URLSearchParams(location.search).get('page') || 'library' } = $props();
  const session = untrack(() => createSession(platform));
  const standalone = !document.body.dataset.page;
  const href = (name) => standalone ? `?page=${name}` : `${name === 'options' ? 'options' : 'library'}.html`;
  const params = new URLSearchParams(location.search);
  onDestroy(session.dispose);
</script>

<main class:compact={page === 'upload' || page === 'unlock'}>
  <header>
    <a class="brand" href={href('library')}>i2nclip</a>
    <nav aria-label="Main navigation">
      <a href={href('library')} aria-current={page === 'library' ? 'page' : undefined}>Library</a>
      <a href={href('options')} aria-current={page === 'options' ? 'page' : undefined}>Settings</a>
    </nav>
  </header>
  {#if !$session.ready}<p role="status">Loading…</p>
  {:else if page === 'options'}<Settings {session} />
  {:else if page === 'upload' || page === 'unlock'}<Upload {session} {platform} id={params.get('id')} auto={page === 'unlock' || params.has('auto')} settingsHref={href('options')} />
  {:else}<Library {session} {platform} settingsHref={href('options')} />{/if}
</main>

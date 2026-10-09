<script>
  import { onDestroy, onMount, untrack } from 'svelte';
  import { createSession } from './lib/stores/session.js';
  import { createLibrary } from './lib/stores/library.js';
  import Library from './lib/components/Library.svelte';
  import Settings from './lib/components/Settings.svelte';
  import Upload from './lib/components/Upload.svelte';
  import './app.css';
  let { platform, page: initialPage = new URLSearchParams(location.search).get('page') || 'library' } = $props();
  let page = $state(untrack(() => initialPage));
  const session = untrack(() => createSession(platform));
  let library = $state.raw(untrack(() => ['library', 'options'].includes(initialPage) ? createLibrary(session, platform) : null));
  const standalone = !document.body.dataset.page;
  const href = (name) => standalone ? `?page=${name}` : `${name === 'options' ? 'options' : 'library'}.html`;
  const params = new URLSearchParams(location.search);
  function navigate(event, name) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    library ??= createLibrary(session, platform);
    history.pushState({}, '', href(name));
    page = name;
  }
  onMount(() => {
    const restore = () => {
      page = standalone ? new URLSearchParams(location.search).get('page') || 'library'
        : location.pathname.endsWith('/options.html') ? 'options' : 'library';
    };
    addEventListener('popstate', restore);
    return () => removeEventListener('popstate', restore);
  });
  onDestroy(() => { library?.dispose(); session.dispose(); });
</script>

<main class:compact={page === 'upload' || page === 'unlock'}>
  <header>
    <a class="brand" href={href('library')} onclick={(event) => navigate(event, 'library')}>i2nclip</a>
    <nav aria-label="Main navigation">
      <a href={href('library')} aria-current={page === 'library' ? 'page' : undefined} onclick={(event) => navigate(event, 'library')}>Library</a>
      <a href={href('options')} aria-current={page === 'options' ? 'page' : undefined} onclick={(event) => navigate(event, 'options')}>Settings</a>
    </nav>
  </header>
  {#if !$session.ready}<p role="status">Loading…</p>
  {:else if page === 'options'}<Settings {session} />
  {:else if page === 'upload' || page === 'unlock'}<Upload {session} {platform} id={params.get('id')} auto={page === 'unlock' || params.has('auto')} settingsHref={href('options')} />
  {:else}<Library {session} {platform} {library} settingsHref={href('options')} onsettings={(event) => navigate(event, 'options')} />{/if}
</main>

<style>
  main { max-width: 76rem; padding: 1.5rem; margin: auto; }
  main.compact { max-width: 32rem; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 2rem; }
  .brand { font-size: 1.35rem; font-weight: 700; text-decoration: none; color: inherit; }
  nav { display: flex; gap: 1rem; }
  nav a { color: var(--muted); text-decoration: none; }
  nav a[aria-current] { color: var(--accent); font-weight: 600; }
  @media (max-width: 32rem) { main { padding: 1rem; } }
</style>

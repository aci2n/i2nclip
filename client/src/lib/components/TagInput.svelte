<script>
  import { completeTag, suggestedTags } from '../tags.js';
  let { value = $bindable(''), id, disabled = false, suggestions = [], label = 'Tags, separated by commas' } = $props();
  let input = $state();
  const matches = $derived(suggestedTags(value, suggestions));
</script>

<div class="tag-input">
  <label for={id}>Tags, separated by commas</label>
  <input bind:this={input} {id} bind:value {disabled} aria-label={label} autocomplete="off" />
  {#if matches.length}
    <div class="tag-suggestions" aria-label="Suggested tags">
      {#each matches as tag}
        <button type="button" class="secondary" {disabled} onclick={() => { value = completeTag(value, tag); input.focus(); }}>{tag}</button>
      {/each}
    </div>
  {/if}
</div>

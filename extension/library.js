import { audioArt } from "../client/audio-art.js";
import { getContent, list, remove, sniffContentType, splitTags, tagTokens, updateMetadata } from "../client/index.js";
import { bindUnlock, readLocal, sessionPrivateKey } from "./secrets.js";
import { sendUpload } from "./send-upload.js";

const results = document.querySelector("#results");
const find = document.querySelector("#find");
const more = document.querySelector("#more");
const status = document.querySelector("#status");
const full = document.querySelector("#full");
const statusScopes = new Map();

function setStatus(key, text) {
  if (text) statusScopes.set(key, text);
  else statusScopes.delete(key);
  status.textContent = [...statusScopes.values()].join(" | ");
}
let active = null;
let searchVersion = 0;
let nextCursor = null;
const items = new Map();

find.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
more.addEventListener("click", () => {
  if (more.disabled || !nextCursor) return;
  more.disabled = true;
  loadPage(nextCursor, true);
});
search();

browser.storage.onChanged.addListener((changes, area) => {
  if ((area === "session" && "privateKey" in changes)
      || (area === "local" && ("wrappedKey" in changes || "serverUrl" in changes))) {
    search();
  }
});

bindUnlock(document.querySelector("#unlock"), document.querySelector("#unlock-status"), async () => {
  document.querySelector("#unlock").hidden = true;
  find.requestSubmit();
});

document.querySelector("#files").addEventListener("change", (event) => {
  const files = [...event.target.files];
  event.target.value = "";
  if (files.length) uploadFiles(files);
});

full.addEventListener("click", (event) => {
  if (event.target === full) full.close();
});
full.addEventListener("close", () => full.replaceChildren());

results.addEventListener("click", async (event) => {
  const thumb = event.target.closest(".media img");
  if (thumb && active) {
    const card = thumb.closest(".card");
    const type = card.dataset.type;
    if (type.startsWith("image/") && card.dataset.shown) {
      showImage(card);
      return;
    }
    if (!card.dataset.shown && /^(image|video|audio)\//.test(type)) {
      await reveal(card);
      return;
    }
  }
  const button = event.target.closest("[data-act]");
  if (!button || !active) return;
  const card = button.closest(".card");
  if (button.dataset.act === "delete") {
    const name = card.querySelector("strong")?.textContent || "this clip";
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
    card.classList.add("busy");
    try {
      await remove({
        ...active,
        id: card.dataset.id,
      });
      card.classList.remove("busy");
      card.classList.add("deleted");
      card.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
    } catch (err) {
      card.classList.remove("busy");
      note(card, err.message);
    }
    return;
  }
  if (button.dataset.act === "play" || button.dataset.act === "download") {
    button.disabled = true;
    try {
      if (button.dataset.act === "play") await reveal(card);
      else await saveFile(await ensureContent(card), card.dataset.filename);
    } catch (err) {
      note(card, err.message);
    } finally {
      button.disabled = false;
    }
  }
});

results.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.classList.contains("tags") || !active) return;
  event.preventDefault();
  const card = form.closest(".card");
  const item = items.get(card.dataset.id);
  const metadata = item?.metadata;
  const output = form.querySelector("output");
  if (!metadata) {
    output.textContent = "No metadata to update.";
    return;
  }
  const tags = splitTags(form.tags.value);
  output.textContent = "Updating…";
  try {
    const next = { ...metadata, tags };
    await updateMetadata({
      ...active,
      id: card.dataset.id,
      metadata: next,
      thumb: item.thumb,
    });
    items.set(card.dataset.id, { ...item, metadata: next });
    output.textContent = "Updated.";
  } catch (err) {
    output.textContent = err.message;
  }
});

async function uploadFiles(files) {
  const privateKey = await sessionPrivateKey();
  if (!privateKey) {
    setStatus("upload", "Unlock before uploading.");
    return;
  }
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const place = `${i + 1}/${files.length}`;
      setStatus("upload", `Uploading ${place} (0%)`);
      await sendUpload(
        {
          bytes: await file.bytes(),
          blob: file,
          name: file.name,
          contentType: file.type,
        },
        privateKey,
        "",
        (pct) => setStatus("upload", `Uploading ${place} (${pct}%)`),
      );
    }
    setStatus("upload", "");
    find.requestSubmit();
  } catch (err) {
    setStatus("upload", err.message);
  }
}

async function search() {
  const version = ++searchVersion;
  active = null;
  items.clear();
  if (full.open) full.close();
  for (const card of results.querySelectorAll(".card")) releaseCard(card);
  results.textContent = "";
  setStatus("search", "");
  more.hidden = true;
  nextCursor = null;
  const settings = await readLocal();
  const privateKey = await sessionPrivateKey();
  if (version !== searchVersion) return;
  const setup = document.querySelector("#setup");
  const unlock = document.querySelector("#unlock");
  setup.hidden = true;
  unlock.hidden = true;
  if (!settings.wrappedKey && !privateKey) {
    setup.hidden = false;
    return;
  }
  if (!privateKey) {
    unlock.hidden = false;
    setStatus("search", "Unlock to search.");
    unlock.querySelector("input").focus();
    return;
  }
  unlock.hidden = true;
  active = { serverUrl: settings.serverUrl, privateKey };
  await loadPage(null, false);
}

async function loadPage(after, keep) {
  const library = active;
  more.disabled = true;
  setStatus("search", "Loading…");
  try {
    const page = await list({
      ...library,
      tags: document.querySelector("#tags").value,
      after,
    });
    if (active !== library) return;
    if (!keep && page.items.length === 0) {
      setStatus("search", "Nothing stored for those tags.");
      more.hidden = true;
      return;
    }
    setStatus("search", "");
    const stamp = document.querySelector("#card");
    for (const item of page.items) {
      items.set(item.id, item);
      results.append(renderCard(stamp, item));
    }
    nextCursor = page.next;
    more.hidden = !page.next;
  } catch (err) {
    if (active === library) setStatus("search", err.message);
  } finally {
    if (active === library) more.disabled = false;
  }
}

function renderCard(stamp, item) {
  const card = stamp.content.firstElementChild.cloneNode(true);
  card.dataset.id = item.id;
  const title = card.querySelector("strong");
  title.textContent = item.metadata?.name || item.id;
  title.title = title.textContent;
  const meta = card.querySelector("p");
  const pixels = item.metadata?.image
    ? `${item.metadata.image.width}×${item.metadata.image.height}`
    : "";
  const when = uploadedAt(item.createdAt);
  const summary = (type, bytes) =>
    [type, pixels, fileSize(bytes), when].filter(Boolean).join(" · ");
  const type = item.metadata?.content_type || "";
  card.dataset.type = type;
  card.dataset.filename = fileNameFor(item.metadata?.name || item.id, type);
  meta.textContent = summary(type, item.metadata?.size);
  const media = card.querySelector(".media");
  const tagsForm = card.querySelector(".tags");
  if (item.metadata) {
    tagsForm.tags.value = (item.metadata.tags || []).join(", ");
    noteTagMismatch(item, tagsForm.querySelector("output"));
  } else {
    tagsForm.hidden = true;
  }
  if (item.thumb?.length) {
    card.dataset.preview = URL.createObjectURL(new Blob([item.thumb], { type: "image/webp" }));
    media.append(image(card, card.dataset.preview));
  }
  if (type.startsWith("audio/") || type.startsWith("video/")) media.append(playButton());
  return card;
}

// A card owns its pending request and decrypted bytes. Failed requests can retry.
const content = new WeakMap();

function ensureContent(card) {
  if (card.dataset.url) return Promise.resolve(card.dataset.url);
  if (content.has(card)) return content.get(card).promise;
  showProgress(card, 0);
  const entry = {};
  entry.promise = getContent({
    ...active,
    id: card.dataset.id,
    onProgress: (pct) => { if (card.isConnected) showProgress(card, pct); },
  })
    .then((bytes) => {
      if (!card.isConnected) throw new Error("Library changed. Try again.");
      entry.bytes = bytes;
      const url = URL.createObjectURL(new Blob([bytes], { type: card.dataset.type || "application/octet-stream" }));
      card.dataset.url = url;
      return url;
    })
    .catch((err) => {
      content.delete(card);
      throw err;
    })
    .finally(() => card.querySelector(".pct")?.remove());
  content.set(card, entry);
  return entry.promise;
}

async function noteTagMismatch(item, output) {
  if (!item.metadata || !output) return;
  try {
    const expected = await tagTokens(active.privateKey, item.metadata.tags || []);
    if (!output.isConnected) return;
    const same = expected.length === (item.tokens || []).length
      && expected.every((token) => item.tokens.includes(token));
    if (!same) output.textContent = "Tags on the server do not match this file.";
  } catch {
    // A failed check is not a reason to hide the file.
  }
}

function showProgress(card, pct) {
  const media = card.querySelector(".media");
  let label = media.querySelector(".pct");
  if (!label) {
    label = document.createElement("span");
    label.className = "pct";
    media.append(label);
  }
  label.textContent = `${pct}%`;
}

function releaseCard(card) {
  content.delete(card);
  if (card.dataset.url) URL.revokeObjectURL(card.dataset.url);
  if (card.dataset.preview) URL.revokeObjectURL(card.dataset.preview);
}

async function reveal(card) {
  if (card.dataset.shown) return;
  try {
    const url = await ensureContent(card);
    const type = card.dataset.type;
    const media = card.querySelector(".media");
    media.querySelector(".play")?.remove();
    if (type.startsWith("audio/")) {
      const art = audioArt(content.get(card).bytes);
      if (art) cover(card, media, art);
      const audio = player(type, url);
      audio.autoplay = true;
      media.append(audio);
    } else {
      dropPreview(card);
      const el = type.startsWith("image/") ? image(card, url) : player(type, url);
      if (el.tagName !== "IMG") el.autoplay = true;
      media.replaceChildren(el);
      if (type.startsWith("image/")) showImage(card);
    }
    card.dataset.shown = "1";
  } catch (err) {
    note(card, err.message);
  }
}

function cover(card, media, art) {
  dropPreview(card);
  const artUrl = URL.createObjectURL(new Blob([art], { type: sniffContentType(art, "") }));
  card.dataset.preview = artUrl;
  const img = media.querySelector("img") ?? image(card, artUrl);
  img.src = artUrl;
  if (!img.parentElement) media.prepend(img);
}

function image(card, url) {
  const img = document.createElement("img");
  img.alt = card.querySelector("strong").textContent;
  img.src = url;
  return img;
}

function dropPreview(card) {
  if (!card.dataset.preview) return;
  URL.revokeObjectURL(card.dataset.preview);
  delete card.dataset.preview;
}

function note(card, text) {
  const output = card.querySelector("output");
  if (output) output.textContent = text;
}

function showImage(card) {
  full.replaceChildren(image(card, card.dataset.url));
  if (!full.open) full.showModal();
}

function playButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "play";
  button.dataset.act = "play";
  button.setAttribute("aria-label", "Play");
  button.textContent = "▶";
  return button;
}

function player(type, url) {
  const el = document.createElement(type.startsWith("video/") ? "video" : "audio");
  el.controls = true;
  el.src = url;
  return el;
}

function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uploadedAt(unixSeconds) {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function saveFile(url, filename) {
  return browser.downloads.download({ url, filename, saveAs: true });
}

function fileNameFor(name, type) {
  const base = String(name || "download").split(/[/\\]/).pop() || "download";
  if (base.includes(".")) return base;
  const ext = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
  }[type];
  return ext ? `${base}.${ext}` : base;
}

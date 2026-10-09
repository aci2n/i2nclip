import { fetchMedia } from './fetch-media.js';
import { notify } from './notify.js';

export const platform = {
  local: browser.storage.local,
  session: browser.storage.session,
  subscribe(listener) {
    const changed = (changes, area) => {
      if ((area === 'local' && ['serverUrl', 'wrappedKey'].some((key) => key in changes))
        || (area === 'session' && 'privateKey' in changes)) listener();
    };
    browser.storage.onChanged.addListener(changed);
    return () => browser.storage.onChanged.removeListener?.(changed);
  },
  download: (url, filename) => browser.downloads.download({ url, filename, saveAs: true }),
  fetchMedia,
  notify,
  close: () => window.close(),
};

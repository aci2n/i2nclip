// The picture is on someone else's site. A bare fetch() from the extension
// does not send that site's cookies or the page address, so public files
// succeed and anything behind a login comes back 401. Match what the <img>
// tag did: send cookies, and name the page as the referrer.
//
// If that still fails, ask the tab itself to fetch. The content-script fetch
// uses the page's cookie jar, which covers blob: URLs and some logins the
// background request cannot see.

export async function fetchMedia({ srcUrl, pageUrl, tabId }) {
  if (srcUrl.startsWith("blob:") && tabId != null) {
    const fromTab = await fetchInTab(tabId, srcUrl);
    if (fromTab) return fromTab;
  }
  const direct = await fetch(srcUrl, {
    credentials: "include",
    referrer: pageUrl || undefined,
  });
  if (direct.ok) return direct;
  if ((direct.status === 401 || direct.status === 403) && tabId != null) {
    const fromTab = await fetchInTab(tabId, srcUrl);
    if (fromTab) return fromTab;
  }
  throw new Error(`Could not fetch the file (${direct.status}).`);
}

async function fetchInTab(tabId, srcUrl) {
  try {
    const [injected] = await browser.scripting.executeScript({
      target: { tabId },
      func: async (url) => {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) return { status: response.status };
        return {
          status: response.status,
          type: response.headers.get("content-type") || "",
          bytes: await response.bytes(),
        };
      },
      args: [srcUrl],
    });
    const result = injected?.result;
    if (!result || result.status !== 200 || !result.bytes) return null;
    return new Response(result.bytes, {
      status: 200,
      headers: result.type ? { "content-type": result.type } : {},
    });
  } catch {
    return null;
  }
}

# Unlock caching in sessionStorage

This is an investigation, not an implementation specification or change to key
storage. Capture changes were committed before this review.

`sessionStorage` survives reloads in the same tab, but closing that tab ends its
page session. The extension now keeps an ordinary app tab open, so its unlocked
in-memory session already handles repeated captures. Session storage would only
add convenience across reloads; it is not implemented.

The current persistence layer holds a non-extractable AES-GCM `CryptoKey` derived
from the master password. It encrypts the complete identity/server record in
localStorage. The session owns the decrypted library private key in memory.
Lock clears both. A saved plaintext private key would resume library operations,
but would not restore the wrapping key needed to save identity changes. Web
Storage accepts strings; it cannot serialize a non-extractable `CryptoKey`.
Storing an exportable wrapping key or password would change the current rule
that only encrypted identity data is saved.

Recommendation: retain the current persistence policy for now. Keeping the
ordinary app tab unlocked already avoids capture prompts while it remains open.
If same-tab reload convenience is separately wanted, specify the key-storage
tradeoff and clearing behavior for Lock, Reset, Forget, password changes, and
identity/server replacement before implementing it. Avoid putting unlock keys
into the extension for unlock caching.

Sources: [sessionStorage lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage),
[CryptoKey extractability](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey/extractable).
Repository facts: `client/src/lib/persistence.js`,
`client/src/lib/protocol/password.js`, and `client/src/lib/stores/session.js`.

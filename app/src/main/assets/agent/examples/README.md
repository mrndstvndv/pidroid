# Examples

Pages built with the app, kept in the tree so they travel with a bundle.

## `branch-chip-demo.html`

A 1:1 rebuild of the branch-chip interaction in `www/chat.js`: tap a message and a chip
appears in its corner, tap the chip and the branch menu drops out of it, tap anywhere else and
both go away. Escape works too.

Self-contained — no network, no dependencies. Open it directly in a browser, or point an
`html` artifact at it:

```
artifact({ kind: "html", path: "examples/branch-chip-demo.html", height: 460 })
```
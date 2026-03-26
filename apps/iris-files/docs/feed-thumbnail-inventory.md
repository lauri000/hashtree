# Feed Thumbnail Inventory

Snapshot date: 2026-03-26

Source:
- Built local video app at `http://127.0.0.1:4181/`
- Local daemon at `http://127.0.0.1:21417`
- Full machine-readable inventory: [feed-thumbnail-inventory.json](/Users/sirius/src/hashtree/apps/iris-files/docs/feed-thumbnail-inventory.json)

Best current full-pass summary:
- 30 feed cards observed
- 28 cards loaded a thumbnail
- 2 cards stayed on the gray placeholder
- 0 cards had a broken image element
- 0 cards had an empty media box

Current loaded-thumbnail breakdown:
- 27 exact immutable `htree://nhash.../thumbnail.*` image files
- 1 other loaded image path

Current unresolved cards:
- `Seriously Smoothed Brown Noise (3 hrs)` at `#/npub1nnzp8076897aex6cp3qwpx2g4fgxjkqsy0aa5jf9cakcgunu9h6qskdrks/videos%2FSeriously%20Smoothed%20Brown%20Noise%20(3%20hrs)`
- `The_Maxis_Club_Show_CHAPTER_2_Christmas_Special_720P` at `#/npub1nnzp8076897aex6cp3qwpx2g4fgxjkqsy0aa5jf9cakcgunu9h6qskdrks/videos%2FThe_Maxis_Club_Show_CHAPTER_2_Christmas_Special_720P`

Notes:
- These two unresolved cards currently fail earlier than thumbnail fetch: direct daemon `api/resolve` calls for their `npub/tree` roots timed out, so they are not yet classified as “thumbnail genuinely missing”.
- The inventory JSON records each visible card’s title, href, resolved `imgSrc` if present, and DOM status from the audit pass.

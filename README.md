# OpenChamber project picker search

Visual evidence for openchamber/openchamber#3406 at source commit d9e74fd2fb81ca23c690280419db17e7d1d1c1a4.

These captures mount the real selector in a production Vite fixture with synthetic projects. The before capture uses the original selector. The fixture stubs an unused OpenCode SDK dependency; it does not exercise server integration.

| State | Evidence |
|---|---|
| Before | [Original picker](before.png) |
| After, light | [Searchable picker](after-light.png) |
| After, dark | [Dark theme](after-dark.png) |
| Narrow, 700x600 | [100 projects](after-narrow.png) |
| No matches | [Empty result](empty.png) |
| Search and keyboard interaction | [11-second recording](search.webm) |

The popup and trigger left edges both measure x=42 in the fixture. Filtering, no matches and clearing keep the input at x=78, y=319. The last of 100 rows remains reachable in the narrow viewport. The recording shows partial search, no matches, clearing, arrow navigation, Enter, reopening and Escape.

The real local application was also checked separately for search, focus return, cancellation, query reset and main-area containment. Native screen-reader and IME input and packaged Electron/VS Code execution were not exercised.

[Renderer measurements](performance.json) compare the original Select with the searchable picker on an Apple M4 Max, using a production fixture and 100/1000 synthetic rows. Opening measures DOM acknowledgement with positive geometry, not compositor presentation. Each timed search starts from a different verified query and measures acknowledgement of the exact expected result IDs. The separate two-rAF number is a frame opportunity proxy. Measurements preceded the final horizontal alignment prop; ranking and rendering logic are identical. At 1000 rows, opening median increased from 44.4 to 69.0 ms; search, no-match and clearing acknowledgement p95 were 30.0, 35.5 and 47.8 ms. These are synthetic observations, not a runtime performance guarantee.

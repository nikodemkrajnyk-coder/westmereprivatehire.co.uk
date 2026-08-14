# Changing how Westmere looks

Everything visual is a **token** in one place. Change a token, the whole system
follows. You should never need to open a back-end file to change the look — and
there is a test that fails if you do.

**The one file that matters:** `westmere-theme.css`, section 1 (`:root`).
It loads **last** on every page, so it wins.

---

## The dials

| You want to change | Edit these tokens | Where it lands |
|---|---|---|
| **Brand colour** | `--westmere-navy`, `--westmere-navy-deep`, `--westmere-navy-soft` | Everything — type, borders, buttons, icons |
| **Backgrounds / paper** | `--westmere-white` | Cards, panels, page canvas |
| **Secondary text** | `--westmere-muted` | Captions, labels, footers |
| **Hairlines / rules** | `--westmere-line`, `--westmere-line-strong` | Dividers, input underlines, card edges |
| **Frame shape (roundness)** | `--radius-sm/md/btn/lg/xl/2xl`, `--radius-pill`, `--radius-round` | **Every** corner in the system |
| **Border weight** | `--border-hair`, `--border-strong`, `--border-heavy` | Rules, selected frames, emphasised panels |
| **Type scale** | `--text-2xs` … `--text-3xl`, `--weight-*`, `--tracking-*` | All sizing and weight |
| **Typeface** | `--westmere-type` (`--serif`/`--sans` both point at it) | One face, everywhere |
| **Density / rhythm** | `--space-1` … `--space-7` | Padding, margins, gaps |
| **States** | `--westmere-danger`, `--westmere-success`, `--westmere-info`, `--westmere-scrim` | Errors, paid, en-route, modal backdrops |
| **Motion** | `--ease-ui`, `--ease-panel` | Hover/press, drawers and sheets |

### Buttons
`wm-buttons.css` is the button system. Its `--wmb-*` tokens **derive** from the
theme (`--wmb-ink: var(--westmere-navy, #102a43)`), so a palette change reaches
the buttons automatically. Edit `wm-buttons.css` only to change button
*structure* (padding, the two variants) — never to change colour.

### Why every token reference has a fallback
`var(--westmere-navy, #102a43)`. A `var()` that resolves to nothing is invalid
at computed-value time and the **whole declaration is dropped** — an unstyled
button. The fallback is the safety net if the theme ever fails to load. Keep
them; a test enforces it.

---

## The rules

1. **Never hardcode a design value in a stylesheet.** Colours and radii come
   from tokens. `design-tokens.test.js` fails on a stray literal in
   `westmere-theme.css`, `wm-buttons.css` or `styles.css`.
2. **Never change a colour in more than one place.** If you find yourself
   editing the same hex twice, one of them should be a token reference.
3. **Design work does not touch `server/`.** See the boundary below.
4. **Presentation changes must be pixel-verified.** See "Proving you changed
   nothing" below.

---

## The front/back boundary

**Logic files carry no design at all** — verified by test:

```
server/fare-engine.js   server/api.js        server/db.js
server/intake.js        server/stripe.js     server/payment-methods.js
server/reminder.js      server/dead-miles.js server/assistant-routes.js
server/google-calendar.js
```

`server/fare-engine.js` is additionally pinned by **content hash**. If a design
task changes it, the suite fails and tells you to revert. If you are making a
genuine fare change, update the pin deliberately.

### The one legitimate exception
Three server files **do** hold colour, because they render outside a browser:

| File | Why it cannot use tokens |
|---|---|
| `server/email.js` | Mail clients do not support CSS custom properties |
| `server/invoice-pdf.js` | pdfkit has no CSS at all |
| `server/public-api.js` | Serves standalone pages (pay / cancel screens) |

Each declares its palette in **one documented constant block** at the top
(`INK`, `ACCENT`, `BG_CARD`…). When you change the theme navy, change it there
too — a test asserts these still match the theme, so drift is caught.

---

## What is NOT tokenised yet

Stated plainly so nobody is surprised:

The three staff apps — `westmere-owner.html`, `westmere-admin.html`,
`westmere-rider.html` — hold roughly **1,400 inline `style="…"` attributes**,
most of them inside JavaScript template strings that build cards and panels.
Those are **not** token-driven. Re-skinning them today means editing those
strings, not the token layer.

The public site (`styles.css`), the theme and the button system **are** fully
tokenised — a designer can re-skin the customer-facing site from tokens alone.

Migrating the apps is a mechanical but large job (~1,400 edits) and every one is
a chance to shift a pixel. Do it in slices — one component at a time, with the
parity check below after each — rather than in one sweep.

---

## Proving you changed nothing

The refactor that created this file was verified **pixel-identical** across
home, services, contact, book, My Account, owner, admin, fleet, terms and pay.
Use the same method for any presentation-preserving change:

1. Start the server on a spare port, screenshot the pages, label them `before`.
2. Make the change.
3. Screenshot again as `after`, and diff with Pillow
   (`ImageChops.difference` → `getbbox()` is `None` means identical).

Harness: `…/scratchpad/parity-shots.js` from the refactor session; the diff is
about ten lines of Pillow. If a page differs, either fix it or say so before
deploying.

---

## Before you ship a design change

```
npm test            # the whole suite, including the token and logic guards
```

Then the parity check above. Both green → deploy.

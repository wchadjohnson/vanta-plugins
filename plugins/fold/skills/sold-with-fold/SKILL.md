---
name: sold-with-fold
description: Use when someone tells you a Fold piece sold on one marketplace, or chose Delist all in Fold, so its other marketplace copies — live listings and saved drafts — can be taken down with one consolidated approval.
---

# Sold with Fold

A piece that sold on one marketplace often still has live sibling listings on the others — a real
double-sell risk until someone takes them down by hand. Use this skill once a sale is confirmed to
get one consolidated approval covering every affected sibling, then remove the ones an adapter can
reach automatically (Depop and Vinted): **drafted copies are deleted on the marketplace at their
recorded draft URL; live listings are taken down.** The seller's **Delist all** in Fold opens the same
kind of delist attempts, and this skill finishes them the same way.

This skill only runs after a sale is confirmed, and its one destructive action (Delete) has no undo.

## Understand the request

- Trigger only when the seller names a specific sold piece and the marketplace it sold on. Never
  infer a sale from ambiguous language.
- "Sold" here means `mark_sold` has already run, or you are about to run it as the first step
  below — never skip straight to delisting siblings without it.
- A sibling still needs the seller's approval even if it looks obviously safe to remove. There is
  no per-listing quiet path.
- "Delist all", "take everything down", or finishing open delists: the seller already chose Delist
  all in Fold, which opened the attempts. Start at **Take down open copies** with
  `list_pending_delists`; no `mark_sold` is involved.
- Fold tells you each copy's `kind`: `'draft'` (a saved draft, deleted at its `draft_url`) or
  `'live'` (a public listing, taken down). Never guess the kind from a URL.

## Know the capability boundary

This skill needs a live browser surface for Depop and Vinted, but not a file upload — Delete is
pure navigation and clicking, so no file-input capability is required here.

- Can you run plugin code that drives the browser from inside one call — the Codex app's `js` tool
  with `cua`, or `mcp__claude-in-chrome__*` called from inside your own function body? -> run the
  delist phases `vintedDelist` / `depopDelist` (`workflows/delist-phases.mjs`) per **Take down
  open copies** below, with provider `codex-browser-client` or `claude-in-chrome` per **Choose a
  browser provider**.
- No live bridge, but you have a genuine Claude in Chrome tab (not an embedded/preview pane) with
  its tools loaded and callable? Run the same steps the delist phases perform, driven by
  your own direct `mcp__claude-in-chrome__*` tool calls instead of a code-execution bridge — see
  **Delist without a live code-execution bridge** below (Depop and Vinted each have their own
  manual sequence there). Run the deferred-tools lookup for Claude
  in Chrome before concluding it is unavailable; an available-but-not-yet-loaded extension will not
  appear in what you can already see.
- Neither of the above? You cannot safely drive Delete's confirmation dialog from here. Say so,
  report each affected sibling plainly (piece code, platform, description, link when known), and tell
  the seller they need to remove those listings themselves.

This plugin's local code lives at these paths, relative to this plugin's root — never search for
one of these by name, they are exactly here. Fold's own tools (`mark_sold`, `delist_sold_siblings`,
`list_pending_delists`, `report_delist`) come from the Fold MCP server, not a local file.

- `workflows/delist-phases.mjs` — `vintedDelist`, `depopDelist` and `summarizeDelist`, the phases
  this skill runs. **Removing copies means running these phases and nothing else**: they delete
  drafts at their recorded URL (draft-delete capabilities), take live copies down through
  `delistApprovedSiblings`, and name the `report_delist` call. Do not call a capability or the
  shared workflow yourself.
- `workflows/delist.mjs` — `delistApprovedSiblings` (live takedowns), `deleteDraftSiblings`
  (drafts), `delistReportCalls`; the phases call these.
- `adapters/{vinted,depop}/draft-delete-capability.mjs` — the draft-delete capabilities (one
  click site each; never Upload or Post), built by the phases through
  `create{Vinted,Depop}DraftDeleteCapabilityForProvider`.
- `adapters/{vinted,depop}/provider-capabilities.mjs` — the transport-selecting factories the
  phases call (`create{Vinted,Depop}DelistCapabilityForProvider` for live takedowns).
- `adapters/depop/delist-capability.mjs` — `createDepopDelistCapability`, the capability the
  factory above wraps. This is where the content gate and the bounded-inference fallback described
  in **Bounded AI control inference** below actually live.
- `adapters/shared/browser-driver.mjs` — the shared Layer C driver interface the capability reaches
  a browser through.

## Choose a browser provider

Select by host transport, never by browser brand.

- Codex desktop or Codex in-app Browser tab: provider `codex-browser-client` with that exact tab —
  `codexBrowser({ cua, browserId, tabId, onTabChange })` from `workflows/post-drafts.mjs`, built
  inside the same `js` call as the phase.
- Claude-in-Chrome raw MCP transport: provider `claude-in-chrome` with the host-injected `callTool`
  and selected `tabId`. Requires a live bridge: whatever runs this code must be able to call
  `mcp__claude-in-chrome__*` tools from inside itself, mid-function — a Bash- or Node-spawned
  process run through a generic code-execution tool is a separate OS process and cannot open
  `callTool` back into your own tool calls.
- Codex CLI and IDE have no qualified built-in browser provider. Return
  `browser_provider_unsupported`; do not improvise one.

## Consolidate one sale into one approval

1. Call `mark_sold` once with the verified identifier for the piece the seller named. When the
   seller names the piece by its code (`FLD-NNNN`, the same value as its Depop SKU) and the
   marketplace it sold on, pass `piece_code` + `platform` (the marketplace where it sold, e.g.
   `ebay`) — never guess a `listing_id`. Use `reference_token` when you have it from a sold email,
   or `listing_id` when a Fold tool already returned it. Treat
   `already_sold` as a successful no-op and continue to step 2 with its `cascaded_listings` if
   present; a fresh `sold` result carries them directly.
2. If there are no `cascaded_listings`, tell the seller the sale was recorded and there is nothing
   else to take down. Stop.
3. Build **one** chat message listing every cascaded sibling together — the piece code (`FLD-NNNN`,
   also its Depop SKU), platform, description, whether it is a **draft** (`kind: 'draft'`: it will
   be deleted on the marketplace) or **live** (`kind: 'live'`: it will be taken down), and its
   `external_url` (live) or `draft_url` (draft) as a clickable link when present. Never show a price: a price next to a sold piece reads as a sale price, and Fold
   records no sale amount on any listing. Most Depop siblings will not
   have one yet: `external_url` is only populated when a seller pastes a Reference URL into Fold or
   a platform's publish flow reports one back, so its absence here is normal, not a sign anything is
   wrong. Never split this into one message per sibling.
4. Wait for **one explicit approval** covering the whole set. A reply naming only some siblings
   approves only those; treat every unnamed sibling as not approved and say so back.
5. If nothing is approved, stop without calling `delist_sold_siblings`.

## Take down open copies

Depop and Vinted have qualified adapters. For every approved sibling on any other platform, skip
straight to **Report platforms with no adapter** below — never attempt one, never silently skip it.

1. **Open the attempts (after a sale).** Call Fold's `delist_sold_siblings` with the sold piece's own
   `listing_id` and `sibling_listing_ids` containing the approved **Depop and Vinted** sibling ids
   (no `resolution`):

   ```js
   { listing_id: 'sold-listing-id', sibling_listing_ids: ['approved-depop-id', 'approved-vinted-id'] }
   ```

   Output is `{ outcome, listing_id, sold_at, results, message }`; top-level `outcome` is
   `recorded`, `not_found` or `invalid_status`. Each result is `{ listing_id, sku, kind, draft_url,
   outcome }` with outcome `accepted` (attempt opened), `pending` (an earlier attempt is still
   open — finish it now), `resolved`, `already_resolved`, `not_found`, `not_attempted` or
   `blocked_by_open_submission`. If the top-level outcome is `not_found` or `invalid_status`,
   report it and do not touch a browser. Report `already_resolved` and `not_found` as they are. For
   `blocked_by_open_submission`, do not touch the browser: Fold has an unrelated unresolved
   submission for that listing, so the seller removes it themselves.

   For **Delist all** there is no sale and no `delist_sold_siblings` call: the seller's Delist all
   in Fold already opened the attempts.
2. **Read the open attempts.** Call `list_pending_delists` (no input) → `{ delists: [{ listing_id,
   platform, sku, title, kind, draft_url, external_url, sold_listing_id, opened_at }], count }` — every open
   attempt, from sales and from Delist all. Save it to a private file. After a sale, pass
   `listingIds` (the approved siblings whose attempt is open) so only those are acted on; for Delist
   all, act on every entry for the marketplace.
3. **Run the delist phase for each marketplace** (`depopDelist`, `vintedDelist`). Per copy, by
   `kind`:
   - `draft` → deleted at the exact `draft_url` Fold recorded, after proving the page is that draft
     (Vinted: the item id in the URL and the upload form present; Depop: the SKU field equals the
     copy's SKU). Never searched for on Active/Selling. Vinted's "Delete draft" deletes at once, no
     confirmation; Depop's "Delete" opens a "Delete draft" dialog whose "Delete draft" confirms. A
     Depop draft with no `draft_url` is found by its exact SKU in the drafts views; two drafts with
     that SKU stop it. A Vinted draft with no `draft_url` is left open — the seller removes it.
   - `live` → taken down by the existing path: Depop by SKU on Active/Selling (Manage listings →
     Delete → Confirm), Vinted at the copy's `external_url` from the pending entry (Delete → "Confirm and delete";
     needs `memberId`; a copy with no `external_url` is left open).
   Upload and Post are never pressed on this path, and nothing is pressed twice.
4. **Run the Fold call it names**: one `report_delist({ listing_ids, resolution: 'confirmed' })` for
   every copy proven gone (`deleted`, `already_deleted`, `not_found`) → `{ results, message }`.
   It is idempotent. Every other copy stays **open** in Fold — never report it confirmed. Close one
   as `abandoned` (`report_delist({ listing_ids, resolution: 'abandoned' })`) only when the seller
   says they will handle it themselves.
5. **Every rerun passes the previous run's state** (`priorStatePath: removed.state_path`): a copy
   whose delete any earlier call pressed is never pressed again, only re-read. While a phase's
   `next` is `'continue'` (it stopped to stay inside its time budget), call
   `list_pending_delists` again and rerun with `priorStatePath` and `listingIds:
   removed.report.not_attempted_listing_ids`. Stop on `'done'`.

**A posted draft is a live listing.** Posting consumes a draft, and its edit page then looks just
like a deleted one, so a gone draft is confirmed only after proving it is not live: Depop checks the
SKU on Active/Selling, Vinted checks that `/items/{id}` is not a live page (and that `/edit` does
not show a live listing's "Save" form). A drafted copy that turns out live is `went_live`: the
phase takes it down as a live listing in the same run when it can, and otherwise leaves it open.

The pending file must be exactly as the exec snippet makes it — `pending.json` in a `mktemp -d`
folder named `fold-pending-*` under the temp directory, written by `writePrivateJson` — or the
phase refuses it.

Never tell the seller a copy is removed before `report_delist` returned for it.

### Codex app (in-app Browser)

The same runtime rules as `sell-with-fold`'s **Post drafts → Codex app**: Fold's tools only from
`exec` (paste that skill's exec preamble — `callFold`, `writePrivateJson` — at the top of every
`exec` block), the browser only from `js`; every `js` block awaits its phase to the end with
`timeout_ms: 300000` (`DELIST_JS_TIMEOUT_MS`) and builds its browser options with
`codexBrowser({ cua, browserId, tabId, onTabChange })` inside that same call.

1. **`exec` — open attempts.**

   ```js
   const dir = (await sh(`umask 077; mktemp -d "\${TMPDIR:-/tmp}/fold-pending-XXXXXXXX"`)).output.trim()
   const pending = await callFold('list_pending_delists', {})
   await writePrivateJson(`${dir}/pending.json`, pending)
   text(`${dir}/pending.json`)
   ```

2. **`js` with `timeout_ms: 300000` — delete and take down.** Vinted:

   ```js
   var root = '<installed plugin root>'
   var post = await import(`${root}/workflows/post-drafts.mjs`)
   var del = await import(`${root}/workflows/delist-phases.mjs`)
   var browserId = '<browser id of the open Vinted tab>'
   var tabId = '<that tab id>'
   var onTabChange = (id) => { tabId = id }
   var removed = await del.vintedDelist({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     pendingPath: '<the pending.json path exec printed>',
     priorStatePath: <the previous delist call's removed.state_path on a rerun, else omit>,
     memberId: '<the number in https://www.vinted.com/member/{id}>',
     listingIds: <the approved sibling ids after a sale; omit for Delist all>,
   })
   removed
   ```

   Depop (the open Depop tab; no `memberId`):

   ```js
   var removed = await del.depopDelist({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     pendingPath: '<the pending.json path exec printed>',
     priorStatePath: <the previous delist call's removed.state_path on a rerun, else omit>,
     listingIds: <the approved sibling ids after a sale; omit for Delist all>,
   })
   removed
   ```

3. If `removed.next` is `'call_fold'`, **`exec` — run the Fold calls** at
   `removed.fold_calls_path` exactly as `sell-with-fold` does (each call once, in order, answers
   written to the job's `results_path`), then **`js`**:

   ```js
   var removedSummary = await del.summarizeDelist({ statePath: removed.state_path, resultsPath: removed.results_path })
   removedSummary
   ```

With Claude in Chrome and a live bridge, run the same phases with `browser: { provider:
'claude-in-chrome', callTool, tabId }`.

## Bounded AI control inference

Depop occasionally renames a control (an `aria-label` change, new wording) without changing what it
does — this is what `status: 'inference_required'` means. Resolve it with the same discipline every
bounded-inference decision in this plugin follows: real candidates only, confidence-gated, evidence
required, and a final exact-match re-check before anything is clicked.

1. Read the entry's `candidates` (the real controls Depop currently shows for this role) and
   `intent` (what the control must actually do — never Depop's current wording for it, and never
   your own paraphrase of it). Those candidates are the only choices; never add, invent, or adjust
   one.
2. Decide using only the candidate list and the intent. Do not browse elsewhere on the page or use
   outside knowledge of Depop's UI history to guess a name that "used to work."
3. If no offered candidate clearly matches the intent, or two plausibly do, do not choose — return
   no decision and report the ambiguity plainly instead. A forced pick here is exactly the guess
   this discipline exists to refuse.
4. Otherwise supply exactly:

   ```js
   {
     chosenName: 'Manage this item', // must be one of the real candidates, verbatim
     confidence: 'high', // high or medium; low is refused
     reason:
       "The row exposes exactly one button-role control, matching the intent of opening this " +
       "listing's own action menu.",
   }
   ```

   Pass it back as `decisions[listing_id].manage` / `.delete` / `.confirm` (matching whichever
   `control` the entry named) on your next delist call for that one sibling (`delistApprovedSiblings({ capability, siblings,
   decisions })` with just that sibling).
   The workflow re-verifies your choice against the live page before acting on it — an invented or
   stale name still refuses; it is never clicked on your say-so alone.
5. For a `confirm` inference specifically: this only ever fires after the dialog's own text has
   already been independently verified as a permanent-delete confirmation (see
   `adapters/depop/delist-capability.mjs`'s content gate). You are choosing which control performs
   that already-confirmed action, not judging whether the dialog itself means delete.
6. Whenever this fires at all, say so plainly in your final report to the seller: which control,
   what real name Depop is now using, and that this may be worth letting Fold know about, since it
   means Depop changed something this adapter had a fixed expectation for.

## Delist without a live code-execution bridge

Use this only when you cannot run the delist phases (see **Know the capability boundary**). Steps 1,
2 and 4 of **Take down open copies** are unchanged: you do step 3 by hand, branching on `kind`.

**`kind: 'draft'`** — delete at the exact `draft_url`; never search Active/Selling for it.

1. The URL must be exactly `https://www.vinted.com/items/{id}/edit` or
   `https://www.depop.com/sellinghub/drafts/edit/{uuid}/`. Anything else: stop, leave it open.
2. Open it. Vinted showing "Sorry, something went wrong" with no upload form, or Depop showing
   "There was a problem getting the draft details", means it is already deleted: report
   `already_deleted`, click nothing.
3. Vinted: the URL carries the copy's item id and the upload form is present. Click only
   `[data-testid="upload-form-delete-draft-button"]` "Delete draft" — by test id, never Upload or
   Save draft. **It deletes immediately, with no confirmation.**
   Depop: the SKU field reads exactly the copy's SKU. Click only `button[data-testid="buttonLink"]`
   "Delete" — never Post or Update draft (Post is also a submit button) — then, in the
   `role=dialog` titled "Delete draft", click the button whose text is exactly "Delete draft" (never
   Close or Cancel).
4. Never click a delete twice. Confirm it: the page left the edit URL and the edit URL now shows the
   deleted page from step 2 → `deleted`. Anything else → `unconfirmed`, left open.

**`kind: 'live'`** — Depop, by SKU on Active/Selling:

1. Navigate to `https://www.depop.com/sellinghub/selling/active/` — this exact URL, never derived
   or guessed.
2. Read the page's accessibility tree. Find the row whose SKU matches the copy's exact `sku` (never
   its `external_url`). Report `not_found` — nothing to do, not a failure — only when listing rows
   are present and none matches, or the page shows zero rows and Depop's own empty-state text
   "There's nothing here yet". With no rows and no empty-state text, wait briefly and re-read once;
   if still neither, report the page as unrecognized and leave it open.
3. Open that row's own Manage control. Never click Boost, Discount, Copy, Mark as sold, or Unboost
   — Delete only.
4. Click Delete inside the open menu, then read the confirmation dialog's own text first.
5. Only if that text says a permanent delete ("delete" plus "permanently"/"cannot be undone"),
   identify which real control in it performs the delete (never Cancel or a close control) using
   **Bounded AI control inference** discipline, click it, and wait for the navigation. Report
   `deleted` with the dialog text. If you cannot reach medium/high confidence, stop and report the
   observed dialog text — a wrong guess here has no undo.

**`kind: 'live'`** — Vinted, at its listing URL (`external_url`, `/items/{id}-{slug}`): click the
owner's Delete, check the dialog reads "Delete item", and click "Confirm and delete" — never Mark as
sold, Mark as reserved, Hide, Bump or Edit listing. Report `deleted` only once the seller's wardrobe
(`/member/{id}`) no longer lists the item.

Then step 4 of **Take down open copies**: `report_delist` with `resolution: 'confirmed'` for
`deleted`, `already_deleted` and `not_found`; everything else stays open.

## Report platforms with no adapter

For every approved sibling on a platform other than Depop and Vinted, tell the seller plainly that
no automated delist exists for that platform yet and they need to remove it themselves. State the
platform and listing (piece code, title, link when known) so they can find it quickly. Never mark these
as attempted, and never silently omit them from the report.

## Report the result

Say plainly what the report's `summary_text` says, then per copy: its platform, whether it was a
draft or live, and its outcome —

- `deleted` — a draft deleted on the marketplace (`kind: 'draft'`), or a live listing taken down
  (`kind: 'live'`).
- `already_deleted` — the draft was already gone and is not live; nothing was clicked.
- `went_live` — the "draft" had been posted; a live copy is never confirmed as a deleted draft. With
  `went_live: true` on a `deleted` entry it was taken down as a live listing in the same run;
  as its own outcome it stays open — tell the seller to take it down. `not_found` — the live
  listing (or a Depop draft looked up by SKU) was already gone.
- `mismatch` — the recorded URL was not a draft URL, or the page was not this copy (wrong item id or
  SKU, a missing or ambiguous control). Nothing was clicked; it stays open.
- `unconfirmed` — a delete was pressed once but could not be proven; it was **not** pressed again
  and stays open. Ask the seller to check the marketplace.
- `error` — failed before anything was pressed (`failure_code`, `message`); stays open.
- `inference_required` — a Depop control needs **Bounded AI control inference**; say so.
- `not_attempted` — left for the next delist call.

Also: `blocked_by_open_submission` (Fold has an unresolved submission; the seller removes it), any
copy closed as `abandoned` at the seller's word, platforms with no adapter, and siblings the seller
did not approve (left untouched). A copy counts as removed in Fold only once `report_delist`
returned for it (`fold_outcome`). Never expose signed photo URLs, full reference tokens, or Fold
internals beyond what Fold's tools returned.

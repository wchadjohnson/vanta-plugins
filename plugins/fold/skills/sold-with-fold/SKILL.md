---
name: sold-with-fold
description: Use when someone tells you a Fold piece sold on one marketplace, so its still-live sibling listings on other marketplaces can be taken down with one consolidated approval.
---

# Sold with Fold

A piece that sold on one marketplace often still has live sibling listings on the others — a real
double-sell risk until someone takes them down by hand. Use this skill once a sale is confirmed to
get one consolidated approval covering every affected sibling, then delist the ones an adapter can
reach automatically (Depop and Vinted).

This skill only runs after a sale is confirmed, and its one destructive action (Delete) has no undo.

## Understand the request

- Trigger only when the seller names a specific sold piece and the marketplace it sold on. Never
  infer a sale from ambiguous language.
- "Sold" here means `mark_sold` has already run, or you are about to run it as the first step
  below — never skip straight to delisting siblings without it.
- A sibling still needs the seller's approval even if it looks obviously safe to remove. There is
  no per-listing quiet path.

## Know the capability boundary

This skill needs a live browser surface for Depop and Vinted, but not a file upload — Delete is
pure navigation and clicking, so no file-input capability is required here.

- Can you call `mcp__claude-in-chrome__*` (or your host's exact bridge equivalent) directly from
  inside your own function body, mid-script? -> live bridge. Drive the shared workflow's
  `delistApprovedSiblings({ capability, siblings })` directly, using
  `createDepopDelistCapabilityForProvider()` / `createVintedDelistCapabilityForProvider()` with
  provider `claude-in-chrome` or `codex-browser-client` per **Choose a browser provider** below.
- No live bridge, but you have a genuine Claude in Chrome tab (not an embedded/preview pane) with
  its tools loaded and callable? Run the same steps `delistApprovedSiblings` performs, driven by
  your own direct `mcp__claude-in-chrome__*` tool calls instead of a code-execution bridge — see
  **Delist without a live code-execution bridge** below (Depop and Vinted each have their own
  manual sequence there). Run the deferred-tools lookup for Claude
  in Chrome before concluding it is unavailable; an available-but-not-yet-loaded extension will not
  appear in what you can already see.
- Neither of the above? You cannot safely drive Delete's confirmation dialog from here. Say so,
  report each affected sibling plainly (piece code, platform, description, link when known), and tell
  the seller they need to remove those listings themselves.

This plugin's local code lives at these paths, relative to this plugin's root — never search for
one of these by name, they are exactly here. Fold's own tools (`mark_sold`, `delist_sold_siblings`)
come from the Fold MCP server, not a local file.

- `workflows/delist.mjs` — `delistApprovedSiblings`, the shared workflow this skill drives, and
  `delistResolutionGroups`, the helper that maps browser results to Fold resolution groups.
- `adapters/vinted/provider-capabilities.mjs` — `createVintedDelistCapabilityForProvider`, the
  Vinted factory (see **Delist approved siblings on Vinted**).
- `adapters/depop/provider-capabilities.mjs` — `createDepopDelistCapabilityForProvider`, the
  transport-selecting factory to call. Never construct the capability below directly with it.
- `adapters/depop/delist-capability.mjs` — `createDepopDelistCapability`, the capability the
  factory above wraps. This is where the content gate and the bounded-inference fallback described
  in **Bounded AI control inference** below actually live.
- `adapters/shared/browser-driver.mjs` — the shared Layer C driver interface the capability reaches
  a browser through.

## Choose a browser provider

Select by host transport, never by browser brand.

- Codex desktop or Codex in-app Browser tab: `createDepopDelistCapabilityForProvider()` with
  provider `codex-browser-client` and that exact tab.
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
   also its Depop SKU), platform, description, and its `external_url` as a clickable link when
   present. Never show a price: a price next to a sold piece reads as a sale price, and Fold
   records no sale amount on any listing. Most Depop siblings will not
   have one yet: `external_url` is only populated when a seller pastes a Reference URL into Fold or
   a platform's publish flow reports one back, so its absence here is normal, not a sign anything is
   wrong. Never split this into one message per sibling.
4. Wait for **one explicit approval** covering the whole set. A reply naming only some siblings
   approves only those; treat every unnamed sibling as not approved and say so back.
5. If nothing is approved, stop without calling `delist_sold_siblings`.

## Delist approved siblings on Depop

Depop and Vinted have a qualified delist capability; Vinted's own steps are in **Delist approved
siblings on Vinted** below, and the Fold calls here (steps 1–3 and 6) cover both. For every
approved sibling on any other platform, skip straight to **Report platforms with no adapter** below
— never attempt one, never silently skip it without saying so.

1. Call Fold's `delist_sold_siblings` tool (vanta-fold#338) with the sold piece's own `listing_id`
   and `sibling_listing_ids` containing the approved **Depop and Vinted** sibling `listing_id`s.
   Approved siblings on any other platform go straight to **Report platforms with no adapter** below
   and are never passed to this tool. Input is:

   ```js
   {
     listing_id: 'sold-listing-id',
     sibling_listing_ids: ['approved-depop-sibling-id', 'approved-vinted-sibling-id'],
     resolution: 'confirmed', // or 'abandoned'; omit on this first call, set only in step 6
   }
   ```

   Output is `{ outcome, listing_id, sold_at, results, message }`, where top-level `outcome` is
   `recorded`, `not_found`, or `invalid_status`, and each result includes `listing_id`, optional
   `sku`, and `outcome`. Per-sibling outcomes are `accepted`, `pending`, `resolved`,
   `already_resolved`, `not_found`, `not_attempted`, or `blocked_by_open_submission`. Without
   `resolution`, Fold opens a new attempt as `accepted`, reports an existing open attempt as
   `pending`, reports a confirmed attempt as `already_resolved`, and opens a fresh attempt for a
   previously abandoned one. With `resolution`, Fold closes an open attempt as `resolved`, reports
   a never-attempted sibling as `not_attempted`, and reports an already closed sibling as
   `already_resolved`.
   `blocked_by_open_submission` means Fold has an unrelated unresolved submission for that listing,
   so no attempt was recorded. `sku` is Depop's SKU column value (for example `FLD-0015`) and may
   be absent on `not_found`.
2. If the top-level `outcome` is `not_found` or `invalid_status`, report that whole-request refusal
   plainly and do not touch a browser. This should not happen after step 1 of **Consolidate one sale
   into one approval** above, but the gate exists precisely because it can drift out of sync.
3. For the first call's per-sibling results: run the Depop delist sequence for `accepted` and
   `pending` (`pending` means an earlier run left the attempt open, so finish it now). Report
   `already_resolved` and `not_found` as-is, with no retry. For `blocked_by_open_submission`, do not
   touch the browser; tell the seller Fold has an unresolved submission for that listing and they
   should remove it on Depop themselves. `not_attempted` should never appear on this no-resolution
   call; if it does, report it as unexpected and do not act on it.
4. Build `siblings: [{ listing_id, sku }]` only from `accepted` and `pending` entries, using the
   entry's own `sku`. Never derive the SKU any other way, and never from `external_url`. If an
   `accepted` or `pending` entry lacks `sku`, do not delist it; close that attempt as `abandoned`
   in step 6 and report that Fold did not provide the Depop SKU needed to find the row.
5. With a live code-execution bridge, call the shared workflow's
   `delistApprovedSiblings({ capability, siblings })` once for the whole SKU-backed batch, where
   `capability` comes from `createDepopDelistCapabilityForProvider()` (see **Choose a browser
   provider**). Do not call the capability's own methods directly — the shared workflow is what
   sequences navigate -> find-row -> open-Manage -> Delete -> confirm and turns each outcome into
   `deleted`, `not_found`, `failed`, or `inference_required` without letting one sibling's failure
   abort the rest of the batch. A sibling the seller never posted is still a draft: when
   Active/Selling has no row for its SKU, the workflow searches the Incomplete and then the
   Ready-to-post drafts and deletes it there (tick that row's own checkbox, Delete, confirm "This
   draft listing will be permanently deleted."). Each `deleted` result says where in `surface`
   (`active`, `incomplete` or `readyToPost`); `not_found` means no surface carries the SKU. If any result has `status: 'inference_required'`, resolve it per
   **Bounded AI control inference** below, then call `delistApprovedSiblings` again for just that
   one sibling with your decision under `decisions[listing_id]` — never for the whole batch again,
   since other siblings may already be `deleted` or `not_found`. Do this before closing attempts;
   anything still unresolved at report time is closed as `abandoned`.
6. Close attempts with a second `delist_sold_siblings` call per non-empty resolution group, using
   the same sold `listing_id`, that group's `sibling_listing_ids`, and `resolution` set.
   `delistResolutionGroups(results)` maps `deleted` and `not_found` to `confirmed`, `failed` to
   `abandoned`, and `inference_required` to `unresolved`; resolve inference first as step 5 says,
   then close anything still unresolved at report time as `abandoned`. Also add any missing-SKU
   attempt from step 4 to the `abandoned` group. Skip a call for an empty group. Expect `resolved`
   back for each sibling, while `already_resolved` is also safe to report as already closed. Never
   tell the seller a sibling is delisted before Fold returns `resolved` or `already_resolved` for
   it. If the closing call returns anything else for a sibling, report that verbatim.

## Delist approved siblings on Vinted

Fold's sibling entry carries everything needed: its `listing_id`, `title` and `external_url` — the
`/items/{id}/edit` draft URL this plugin recorded, or the `/items/{id}-{slug}` page once the seller
published it. The adapter reads which it is from the page itself.

1. Include approved Vinted sibling ids in the same first `delist_sold_siblings` call as Depop's
   (step 1 above), and handle its per-sibling results the same way (steps 2–3).
2. Build `siblings: [{ listing_id, listing_url: external_url, title }]` from the `accepted` and
   `pending` Vinted entries, taking `external_url` and `title` from that sibling's own
   `cascaded_listings` entry. A sibling with no `external_url` still goes in: it comes back
   `failed` (`vinted_delist_url_missing`) and is closed as abandoned — tell the seller to remove it
   on Vinted themselves.
3. Build the capability with `createVintedDelistCapabilityForProvider({ provider, …transport,
   profile: createAuthenticatedVintedTargetProfile(), memberId })` — the same provider, tab wiring
   (including `openFreshTab` on Codex) and seller member id as the Vinted draft recipe in
   `sell-with-fold`. Then call `delistApprovedSiblings({ capability, siblings })` once for the
   Vinted batch. Results are `deleted` (with `kind: 'draft'` or `'published'`), `not_found` (already
   gone from the wardrobe), or `failed` with a `failure_code` and `reason`.
4. Close attempts exactly as step 6 above, with `delistResolutionGroups(results)`.

What it clicks, and only after proving the page is this sibling's: a published listing's Delete,
then "Confirm and delete" in Vinted's "Delete item" dialog; or a draft's "Delete draft" — which
deletes immediately, with no confirmation, so it is clicked only when the edit page's URL carries
the sibling's item id and its title equals Fold's listing title exactly. It never clicks Mark as
sold, Mark as reserved, Hide, Bump, Edit listing, Save draft or Upload. A deletion counts only once
the item is gone from the seller's wardrobe.

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
   `control` the entry named) on your next call to `delistApprovedSiblings` for that one sibling.
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

Use this instead of step 5 above when you have no way to run `delistApprovedSiblings` with a live
`callTool` bridge (see **Know the capability boundary**). Steps 1–4 and 6 above are unchanged.

For each accepted or pending sibling with a SKU from the tool result:

1. Navigate to `https://www.depop.com/sellinghub/selling/active/` — this exact URL, never derived
   or guessed. Posted listings are deleted here, through their Manage dropdown; a sibling not on this
   page is looked for in the drafts afterwards (step 7).
2. Read the page's accessibility tree. Find the row whose SKU matches this sibling's exact `sku`
   from the tool result (never its `external_url` — posting a draft changes the URL entirely, so
   a stored URL is not a reliable navigation target). Report `not_found` — nothing to do, not a
   failure — only when listing rows are present and none matches this exact SKU, or when the page
   shows zero rows and Depop's own empty-state text "There's nothing here yet" is visible. If
   there are no rows and no empty-state text, wait briefly and re-read once. If there is still
   neither, report the page as unrecognized, a failure for that sibling; never conclude
   nothing-to-do from an unconfirmed empty page, since that would make Fold record a delete that
   did not happen.
3. Open that row's own Manage control. Never click Boost, Discount, Copy, Mark as sold, or Unboost
   — Delete only.
4. Click Delete inside the open menu, then read the confirmation dialog's own text before doing
   anything else with it.
5. First check the dialog's own text explicitly says a permanent delete (contains "delete" and an
   explicit permanence/no-undo cue such as "permanently" or "cannot be undone"). If it does not,
   stop here without clicking anything — that dialog is not confirmed to be the one you think it
   is, whatever its role or position on screen. If it does, identify which real control in that
   dialog performs the delete (never Cancel or a close control) using the same discipline as
   **Bounded AI control inference** above — real observed candidates only, medium/high confidence,
   a concise reason — then click it and wait for the resulting navigation. Report `deleted` with
   the dialog text you observed, and if you had to reason about which control to click, say so per
   that section's seller-notification step. If you cannot reach medium/high confidence on which
   control performs the delete, stop here and report the observed dialog text as an open item
   rather than guessing — a wrong guess on this one step has no undo.
6. Never re-attempt a sibling this run already resolved as `deleted`, `not_found`, or
   `already_resolved`.
7. When Active/Selling has no row for the SKU, open
   `https://www.depop.com/sellinghub/drafts/incomplete/` and then
   `https://www.depop.com/sellinghub/drafts/readyToPost/` by URL (never their tab buttons). Find the
   one row whose SKU cell reads exactly this SKU (two such rows: stop, report ambiguity). Tick only
   that row's own checkbox (its id is the draft's uuid) — never "Select All" — and confirm exactly
   one box is ticked and the toolbar reads "1 selected". Click the toolbar Delete, read the "Are you
   sure?" dialog, and click Confirm only if it says "This draft listing will be permanently
   deleted."; then check the SKU is gone. Never click Edit or Ready-to-post's Post. Report `deleted`
   with the view it was in; only when neither view has the SKU is it `not_found`.

For each accepted or pending **Vinted** sibling (no bridge; same seller approval):

1. Open the URL Fold recorded for it (`external_url`): `/items/{id}/edit` for a draft this plugin
   made, `/items/{id}-{slug}` once the seller published it. With no URL, do not search for it — close
   it as `abandoned` and tell the seller to remove it on Vinted.
2. Draft (the page has a "Delete draft" button): check the page's URL carries that item id and its
   Title field reads exactly Fold's listing `title`. Only then click "Delete draft" — **it deletes
   immediately, with no confirmation**, so never click it on any other page. Published (the page
   shows the owner's Delete): click Delete, check the dialog reads "Delete item", and click
   "Confirm and delete" — never Mark as sold, Mark as reserved, Hide, Bump or Edit listing.
3. Report `deleted` only once the seller's wardrobe (`/member/{id}`) no longer lists the item;
   `not_found` when neither page offers it and the wardrobe does not list it.

After the manual sequence, the same closing call in step 6 applies: `deleted` and `not_found` close
as `confirmed`; stopped, `failed`, or unresolved items close as `abandoned`. Never tell the seller
a sibling is delisted before Fold returns `resolved` or `already_resolved` for it.

## Report platforms with no adapter

For every approved sibling on a platform other than Depop and Vinted, tell the seller plainly that
no automated delist exists for that platform yet and they need to remove it themselves. State the
platform and listing (piece code, title, link when known) so they can find it quickly. Never mark these
as attempted, and never silently omit them from the report.

## Report the result

State, per approved sibling: its platform, the outcome (deleted / not found / already resolved /
blocked by open submission / abandoned / no adapter available / failed), and — for a failure —
the safe `failure_code` and any `observed_dialog_text` the error carried. For
`blocked_by_open_submission`, say Fold has an unresolved submission for that listing and the seller
must remove it themselves on Depop. For `abandoned`, say the attempt was closed as abandoned, the
listing may still be live on Depop, and the seller should check or remove it themselves. If any
control needed **Bounded AI control inference** above, say so explicitly per the
seller-notification step there — this is not optional detail, it is the seller's only signal that
Depop changed something. State which siblings were not approved and were therefore left untouched.
Never expose signed photo URLs, full reference tokens, or Fold internals beyond what `mark_sold`
and `delist_sold_siblings` already returned.

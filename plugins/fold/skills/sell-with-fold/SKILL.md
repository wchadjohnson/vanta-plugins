---
name: sell-with-fold
description: Use when someone wants to copy greenlit Fold listings to a resale platform, mark a listing sold, or keep Fold in sync with resale activity.
---

# Sell with Fold

Use Fold as the source of truth for listings the user has greenlit. Help the user see what is ready,
copy all qualified greenlit listings to a supported resale platform as drafts, or sync a confirmed
sale back to Fold.

## Understand the request

- “Greenlit,” “approved,” and “ready” refer only to listings returned by the current
  `list_ready_listings` call. Never infer approval from prior conversation or other Fold data.
- “Copy,” “post,” or “list” means create and independently verify one private draft. It never means
  make the listing public.
- “Sold” means run the sold workflow only after one verified sale signal identifies one Fold
  listing.
- If several qualified resale-platform adapters are available and the user has not named a
  destination, ask which platform to use.

## Know the capability boundary

**Self-check before doing any work, not after a failed attempt.** Do this check even if your host has
already handed you a browser tool that looks usable (an embedded preview pane, for example) — an
available-but-not-yet-loaded Claude in Chrome will not appear anywhere in what you can already see,
so "I don't currently see it" is not evidence it is absent:

- Does your host defer tools — do names like `mcp__claude-in-chrome__*` show up in a deferred-tools
  list, callable only after an explicit lookup (for example a `ToolSearch`-style tool), rather than
  as tools you can call right away? If so, run that lookup for Claude in Chrome **before** concluding
  anything about your capability. Only treat Claude in Chrome as unavailable after that lookup
  genuinely finds nothing — never because it was merely absent from your initially-visible tool list.
- Once loaded (or if never deferred to begin with): can you call `mcp__claude-in-chrome__*` (or your
  host's exact bridge equivalent) directly from inside your own function body, mid-script? → live
  bridge. Use **Bulk listing greenlit listings as drafts** below, calling `importCsvBatch` directly.
- No live bridge, but Claude in Chrome tools are loaded and callable, giving you a genuine Claude in
  Chrome tab (not an embedded/preview browser pane — see below)? → Use **Bulk listing without a live
  code-execution bridge** below. Prefer this over an embedded/preview pane whenever both are
  available: only Claude in Chrome can deliver a file to a file input.
- Neither of the above, even after checking for deferred tools — only an embedded/preview pane, or no
  browser tool at all? → You cannot deliver a file to Depop's upload input from here. Say so before
  creating the CSV, and ask whether the user wants to switch you to Claude in Chrome or upload the CSV
  themselves once you hand it to them.

This plugin's local code lives at these paths, relative to this plugin's root — never search for one
of these by name, they are exactly here. Fold's own tools (`list_ready_listings`, `mark_sold`,
`mark_published`, `export_depop_csv`) come from the Fold MCP server, not a local file.

- `workflows/bulk-listing.mjs` — `exportDepopCsvBatch`, `summarizeBulkListingPlan`, `importCsvBatch`
- `workflows/lifecycle.mjs` — `saveAndVerifyDraft`
- `adapters/depop/provider-capabilities.mjs` — `createDepopBrowserCapabilityForProvider`,
  `createDepopBulkListingCapabilityForProvider`, the transport-selecting factories to call. Never
  construct either capability below directly with them.
- `adapters/depop/browser-capability.mjs` — `createDepopBrowserCapability`, the per-field
  create-form capability the provider factory above wraps
- `adapters/depop/bulk-listing-capability.mjs` — `createDepopBulkListingCapability`, the bulk-CSV
  capability the other provider factory above wraps
- `adapters/depop/profile.mjs` — `createDepopSimulatorTargetProfile`,
  `createAuthenticatedDepopTargetProfile`
- `adapters/shared/browser-driver.mjs` — the shared Layer C driver interface both capabilities reach
  a browser through
- `workflows/draft-batch.mjs` — `runDraftBatch` and `recordDraftResult`, the step-at-a-time,
  resumable batch for Vinted
- `workflows/photo-files.mjs` — `createPhotoFileResolver`, the ready-made `resolvePhotoFiles`
- `adapters/vinted/provider-capabilities.mjs` — `createVintedBrowserCapabilityForProvider`, the
  transport-selecting factory for Vinted drafts. Never construct the Vinted capability directly.
- `adapters/vinted/adapter.mjs` — `createVintedAdapter`
- `adapters/vinted/profile.mjs` — `createAuthenticatedVintedTargetProfile`

Two draft platforms are supported. Depop has two installed capabilities: the per-field one drives
the create form, the bulk one hands Depop's own bulk-listing page a CSV — see **Choose how listings
reach Depop** below for which one to use. Vinted has one: it drives the vinted.com sell form, one
listing at a time — see **Copy greenlit listings to Vinted drafts** below. The browser rules in this
section apply to every capability. Both use a host-provided browser service to adapt
one visible semantic browser tab; neither installs another browser service. Use the installed
capability instead of recreating its methods in the task. Select the driver by the host transport,
never by the browser's brand:

- For a Codex desktop or Codex in-app Browser tab already selected or claimed by the host, call the
  installed `createDepopBrowserCapabilityForProvider()` with provider `codex-browser-client` and
  that exact tab. Also inject `reacquireTab(tabId, url)` and `releaseTab(tabId, replacementTabId)`:
  create a fresh tab binding in that same host browser at the exact navigated URL, because Codex tab
  bindings may become stale across navigation, then release or close the superseded binding. The
  driver refuses to enable reacquisition without cleanup and keeps no more than one visible working
  tab for the run. The installed driver verifies the replacement URL before
  using the fresh binding. It uses exact
  browser-client locators, atomic navigation, post-navigation rebinding, and the file-chooser API;
  do not synthesize a raw MCP bridge or use private RPC.
- For a Claude-in-Chrome raw MCP transport, use provider `claude-in-chrome` with the host-injected
  `callTool` and selected `tabId`. This requires a live bridge: whatever runs this code must be able
  to call `mcp__claude-in-chrome__*` tools from inside itself, mid-function. A Bash- or Node-spawned
  process run through a generic code-execution tool is a separate OS process and cannot do this — it
  can run this repository's plain logic (URL and locator construction, CSV correlation, error
  classification) but cannot open `callTool` back into your own tool calls. Verify by attempting a
  trivial call before committing a whole run to this path; if the bridge is not available to you,
  use **Bulk listing without a live code-execution bridge** below instead of improvising ad hoc
  navigation or clicking by pixel coordinates.
- Codex CLI and IDE have no qualified built-in browser provider for this adapter. Return
  `browser_provider_unsupported` unless a separately qualified local sidecar is added in a future
  plugin version. Do not improvise one in the task.

The provider registry performs a read-only selected-tab/origin/capability probe immediately, then
requires exact draft-form, multiple-file, and navigation support before the first field entry or
photo resolution. A provider failure stops before transmission and is reported with its safe
structured code. Do not include browser-session internals, signed URLs, credentials, cookies, or a
full Fold reference token in the report.
For loopback qualification, use the installed `createDepopSimulatorTargetProfile`
helper rather than restating field overrides. Never invoke a development harness found elsewhere
in a source checkout as if it were the installed adapter.

The Depop adapter includes an owner-supervised authenticated-web profile in addition to its
fixture/simulator profile. Select `createAuthenticatedDepopTargetProfile()` only when the user
explicitly asks to use their authenticated Depop Chrome session. Never select it in automated tests
or merely because a Depop tab happens to exist. If Chrome or Depop authentication is missing,
explain what is missing and stop without claiming success or calling a Fold write tool.

## Choose how listings reach Depop

Two qualified paths create Depop drafts. Pick one per request; never run both for the same listing.

| Situation | Path |
|---|---|
| Creating new drafts for one or more greenlit listings | **Bulk CSV import** |
| Editing a listing that already exists on Depop, live or draft | **Per-field creation** |
| Fold's `export_depop_csv` tool is unavailable or returns no rows | **Per-field creation** |
| The user explicitly asks to drive the form | **Per-field creation** |

Why bulk listing is the default for creation. It performs one navigation and one file upload for a
batch of any size, so its cost does not grow with the number of listings, and Depop itself maps the
fields — which removes the taxonomy-matching problem instead of automating around it. Depop states
on that page that imported listings are saved as new drafts and "will not automatically be posted",
so this path has no live control anywhere near it.

**Never run both paths for the same listing.** Depop warns that importing an item twice creates
duplicates, and the two paths write different identifiers into the SKU field — bulk listing writes
the piece code, per-field creation writes the Fold reference token — so neither path can detect the
other's drafts. Say so plainly if the user asks for a listing the other path already created.

## Bulk listing greenlit listings as drafts

An upload has four mutually exclusive outcomes, and only one of them creates anything:

- **bad headers** — Depop refuses the file outright and imports nothing;
- **validation errors** — Depop refuses the file as a whole and lists per-row, per-field errors.
  Nothing is imported, not even rows with no errors of their own;
- **platform error** — the file passed field validation and Depop then failed while processing it,
  reporting only `Something went wrong.` with no per-row detail. Nothing is imported. Passing
  validation is **not** the same as the import beginning; only the accepted banner means that;
- **accepted** — Depop imports **asynchronously**, in the background, and emails the seller when the
  drafts are ready. On this path there is no per-listing signal on the page, so the only per-listing
  outcome is whether that listing's SKU has appeared as a draft yet, and the workflow polls for
  exactly that.

**Correlation identifier, because getting this wrong fails silently.** Each exported listing carries
both `sku` and `reference_token`. `sku` is the piece code (`FLD-####`) and is the value that reaches
Depop in the CSV; `reference_token` is the sold-email marker and is **not in the CSV at all**, so
searching Depop for one matches nothing. The workflow keys correlation on `sku` for you and does not
put `reference_token` in the batch — never substitute it, and never show a full `reference_token` in
your report. Fold's own tool descriptions say the same; follow them.

1. Call the shared workflow's `exportDepopCsvBatch({ fold, materializeCsv })`. It calls Fold's
   `export_depop_csv` tool through the host-provided Fold handle, shapes the response into a batch,
   derives the file's first data line from the template's own header block, and hands the bytes to
   your `materializeCsv` callback so you can write them somewhere the browser is allowed to read.
   Do not call the tool yourself and do not reshape its response by hand.
2. Handle its three outcomes before touching a browser:
    - `export_refused` — Fold declined. Show `reason` **verbatim**: it is written for the seller and
      tells them what to fix (an unrecognised saved shipping location, for example). Stop.
    - `export_empty` — nothing is greenlit, or everything greenlit is already awaiting confirmation.
      This is normal, not a failure. Pass `message` through and stop.
    - `export_ready` — continue.
3. Write the bytes **exactly as Fold produced them**. Do not add, strip, reorder or reformat
   anything, including the template preamble or its per-column instruction row — the marketplace
   needs all three header lines, and a file missing the instruction row makes it silently consume
   the first listing. Producing an acceptable file is Fold's job; a mismatch is a Fold bug to
   report, not something to patch here. One file per upload.
4. State the plan and then act. Call `summarizeBulkListingPlan(exportResult)` and tell the user
   its `text` — how many listings, which marketplace, and that they land as drafts and are never
   posted. **This is informational, not an approval step.** Do not ask for confirmation, do not wait
   for a reply, do not offer a yes/no. Greenlighting in Fold *is* the seller's approval, and asking
   again would double-gate a decision they already made. `is_approval_gate` is `false` and must stay
   so: a future change that turns this into a prompt reverses a product decision rather than
   tightening anything.
    - If `truncated` is true, say so plainly in the same breath. A truncated export must never be
      reported to the seller as the complete set.
5. Call the installed `createDepopBulkListingCapabilityForProvider()` with the same provider and
   host-selected tab rules as the per-field path, giving it a `resolveCsvFile` that returns the
   `csv_path` from step 1. Then call `importCsvBatch({ capability, batch })` once for the whole
   batch, with the batch from step 1 unmodified. Do not call the capability's methods yourself, and
   do not add a runtime-confirmation gate anywhere in this sequence.
6. If the result is `import_failed` with `bulk_listing_file_rejected`, Depop refused the whole file
   and created nothing; nothing was recorded in Fold. Report Depop's own message from
   `upload_confirmation.message`, treat it as a defect in the exported file, and do not retry the
   upload or edit the bytes yourself.
7. If the result is `import_rejected` with `bulk_listing_file_has_row_errors`, Depop validated the
   file and refused it as a whole. **Nothing was imported — not even the rows with no errors.**
   Report `platform_row_errors` per row and field with Depop's messages verbatim, and do not
   rewrite or normalize its field labels: `Brand` and `Field_name.picture_Hero_url` are both Depop's
   own wording, and the seller needs to see which field to fix. Rows with `status: 'rejected'` have
   fields to fix; rows with `status: 'rejected_with_file'` were fine but went down with the
   file. The user's next action is to fix the flagged rows and re-upload the whole file. If
   `platform_row_errors_unmapped` is true, say that some errors could not be attributed to a
   specific listing rather than guessing at which. If `row_errors_malformed` is true, say the error
   list could not be read and point the user at the page itself.
   Before re-uploading a corrected file, drop any row this run reported in `imported` — a
   re-upload of a row that already imported creates a duplicate draft, which Depop's own page warns
   about. Tell the user to glance at their drafts list too: the single check this run makes is one
   look, not a guarantee.
8. If the result is `import_failed` with `bulk_listing_platform_error`, Depop accepted the file's
    fields and then failed while processing it. Nothing was imported and there is no per-row detail
    to report. `retry_suggested` is `true` on this outcome and no other, so tell the user a retry is
    reasonable here — but **ask them; never re-upload on your own.** A generic error gives no way to
    know whether anything landed, and re-uploading duplicates whatever did. Have them check their
    drafts list first, and drop any row this run reported in `imported`.
9. Check `upload_confirmation.accepted`. `true` means Depop confirmed it accepted the file — which
   is not a promise that every row became a draft. `null` means the page showed no recognizable
   upload notice (`notice` is `missing` or `unrecognized`): report that as a likely Depop UI change
   worth flagging, then read the rest of the result normally, because per-row correlation is what
   establishes each outcome either way. Do not re-upload on a `null`.
10. The workflow reads all three draft views — Incomplete, Ready-to-post and Scheduled — by opening
   each one's own URL. A row that lands under Incomplete drafts is a **successful** import, not a
   failure — never report it as one. (Do not explain *why* a draft landed there: the
   missing-package-size explanation comes from Depop Import's documentation, which is a different
   Depop product and does not describe this path.)
11. For every entry in the result's `imported` array, call `mark_published` once with that entry's
   exact `listing_id` and its own `listing_url`. One URL per listing. Never reuse one URL across
   listings, and never send a drafts-hub or bulk-listing URL to Fold.
12. Report every entry in `unresolved` by its `status`, and describe each one accurately:
    - `pending_at_timeout` — no draft with that SKU has appeared. Depop may still be processing it,
      **or Depop may have silently rejected that row during processing** — an accepted file does not
      mean every row becomes a draft, and Depop shows no per-row error and no signal that processing
      has finished. You cannot tell those apart, so say exactly that: the listing has not appeared,
      it was not recorded, and it is unresolved rather than failed. Tell the user Depop emails them
      when an import finishes, and that the email or a look at their own drafts list is what settles
      it. Do not call `mark_published` for it, do not guess a URL, do not speculate about a cause
      from the listing's own data, and **do not re-upload the file** — a second upload creates
      duplicate drafts.
    - `ambiguous` — two imported drafts carry that SKU. Report it and let the user resolve it; never
      pick one.
    - `not_imported` — the file itself was rejected, so nothing was created.
13. Never target Post, Publish, List, Make live, Ready to post, or any equivalent. This capability
    clicks nothing at all — it reaches every draft view by URL and refuses every action it is asked
    to take, including Depop's own Post control on the Ready-to-post view. The user posts the drafts
    inside Depop.
14. Report the row count, each recorded listing, each unresolved row with its status and what it
    means, whether the export was truncated, and that Depop emails the seller when the import
    finishes. **Also report every entry in the export tool's own `blanked_cells`, if any are
    present** — each names a `listing_id`, `field`, and `column` where Fold held a value the seller
    typed but withheld it from the file because it did not match the marketplace's own accepted
    list for that field (for example, a brand or category spelled differently than the marketplace
    captured it). This is not a failure to fold into the row-outcome report above: the row still
    imports, just missing that one fact — so tell the user which listing, which field, and what
    value Fold could not send, so they can fix it themselves either in Fold or directly on the
    marketplace. Silently omitting this is how a seller ends up manually reconstructing a dropped
    field on the marketplace's own site without ever learning Fold already knew about the gap.

## Bulk listing without a live code-execution bridge (native browser tools)

Use this instead of steps 5, 10, and 13 above when you have no way to run `importCsvBatch` with a
live `callTool` bridge (see **Know the capability boundary**) — for example, a Bash/Node/Bun tool
that can execute this repository's files but cannot itself call your browser MCP tools mid-script.
Steps 1–4 (export the CSV, handle its three outcomes, write the bytes untouched, state the plan) and
6–9, 11–12, 14 above are unchanged — this section only replaces how the browser part happens.

**This fallback requires the Claude in Chrome browser extension as the browser surface** — the same
`claude-in-chrome` transport named in **Know the capability boundary** above, just driven by your own
direct tool calls instead of through a code-execution bridge. If your host can open more than one
kind of browser surface for a task — for example an embedded preview/in-app browser pane in addition
to a real Claude in Chrome tab — the embedded pane is a different, more restricted environment that
cannot set a file on a file input under any tool name or approach; this is not a per-call error to
retry past. Confirm you are addressing a genuine Claude in Chrome tab (tools in a
`mcp__claude-in-chrome__*`-style namespace, or your host's exact equivalent) before starting step 1.
If your host offers only an embedded/preview browser pane and no Claude in Chrome tab, you cannot
complete this fallback at all: stop before navigating and tell the user the CSV file path and that
their host's browser surface cannot upload files, so they either switch you to Claude in Chrome or
complete the upload themselves.

Write the CSV wherever your own file-write capability places files you can then reference by path
(the location a prior successful export already used) — a file-upload tool typically refuses a path
it does not recognize as belonging to the session, so an arbitrary filesystem path may be rejected
even if it exists.

Do not compute or guess the target URL. It is fixed: **`https://www.depop.com/sellinghub/bulklisting/`**.
Navigate there directly. Do not search Drafts, "How to list on web," or any other link to find it —
if that URL 404s or looks wrong, stop and report it rather than exploring for an alternative; Depop
moving this page is a real, reportable defect, not something to route around by guessing.

1. Navigate to `https://www.depop.com/sellinghub/bulklisting/`.
2. Read the page's accessibility tree (not a screenshot). Confirm exactly one button with the exact
   accessible name "Upload file" exists, and exactly one file-input-role element exists. Locate both;
   activate neither. Clicking the visible trigger opens an OS file dialog you cannot see or drive —
   the file input must be addressed directly by its own element reference instead.
3. Before touching the file input, confirm you are on a genuine Claude in Chrome tab (see above) and
   check your own available tools for the one built for this exact purpose — in the
   `mcp__claude-in-chrome__*` namespace this is `file_upload`, which sets a file on an element by its
   `tabId` and `ref` without opening an OS dialog; your host's equivalent will be named and documented
   the same way. **Never use a generic value-fill tool (for example one meant for typing into text
   fields), and never run script that assigns `.value` on an `input[type=file]`, to deliver the CSV.**
   Every browser refuses this at the platform level — it is not this page's bug, not a malformed-input
   case, and not something a different selector, ref, or retry fixes; seeing it means you are either
   on the wrong tool or the wrong browser surface (see above), not that this page needs another
   attempt. If you are confirmed on a real Claude in Chrome tab and it still has no file-upload tool of
   this kind, you have no capability to complete this step: stop immediately without attempting a
   generic tool against the file input, and tell the user the exact CSV file path and where the upload
   control is on the page, so they can complete the upload themselves. Do not treat this as a bug to
   report and retry — it is a capability boundary, and asking the user to do this one step is the
   correct outcome, not a fallback of last resort.

   If a file-specific tool does exist, deliver the CSV to that file-input element's reference. Do not
   click anything first. One file per upload; Depop's own input takes exactly one. Use the exact
   numeric `tabId` your own `tabs_context_mcp`/`read_page` call returned and the exact `ref` that call
   returned for the file input — never a placeholder, an example value, or a name you have not
   actually read back from a tool result.

   **If that call is rejected for a malformed input (bad ref or tabId), fix the one broken field and
   retry once.** If it still fails, stop here and report the tool name and its exact error text. Do
   not escalate to a different skill or automation system, OS-level keystroke or dialog simulation
   (for example `osascript`), or a direct HTTP call to Depop's own API. Each of those defeats the
   entire reason the visible trigger is never clicked: an OS file dialog neither of you can see or
   drive, or an unreviewed write straight to a real marketplace's API, are both worse outcomes than a
   stopped run with a clear error to report.
4. Read the page again. Look for a `role="alert"` element next to the file input. Its text is the
   only signal Depop gives:
   - substring-matches `"Upload successful! We're creating drafts from your file now"` → accepted;
   - a single short line like `"CSV headers don't match. Are you using the correct template?"` →
     bad-headers rejection, nothing imported;
   - a list of per-row, per-field messages → validation-errors rejection, nothing imported, not even
     clean rows;
   - a generic message with no per-row detail (Depop's own wording, not necessarily identical every
     time) → platform-error, nothing imported, retry is reasonable but only if the user says so;
   - no alert found at all → treat as accepted-but-unconfirmed (`notice: unrecognized`) and fall
     through to per-SKU polling below rather than guessing which outcome occurred.
   Match by substring against each observed string, never equality against the whole alert's
   concatenated text — the success alert has two text nodes concatenated together.
5. On accepted (or unconfirmed), poll for per-row outcomes by opening each of Depop's three draft
   views by its own URL — never by clicking a tab toggle, since a redirect could otherwise pass as
   coverage:
   - `https://www.depop.com/sellinghub/drafts/incomplete/`
   - `https://www.depop.com/sellinghub/drafts/readyToPost/`
   - `https://www.depop.com/sellinghub/drafts/scheduled/`
   For each exported listing's exact `sku` (the piece code, never `reference_token`), search the
   draft rows across all three views for that SKU, read that draft's own stable edit URL, and record
   the pairing. Poll on a bounded interval (Depop imports asynchronously and emails when finished) up
   to a reasonable timeout before reporting the remainder as `pending_at_timeout`, matching the
   outcome semantics in step 12 above. A row under Incomplete is a successful import, not a failure.

   The moment a SKU pairs to exactly one stable draft URL — a **confirmed** outcome — call
   `mark_published` once with that listing's exact `listing_id` and that URL as `listing_url`,
   right here during polling rather than waiting for a later step. Do this only for a confirmed
   pairing: never for a SKU still `pending_at_timeout`, never for `ambiguous` (two drafts share a
   SKU), and never for a row this run cannot otherwise recognize. If the `mark_published` call
   itself fails, report that to the seller but do not fail or retry the import over it — this is
   best-effort enrichment of Fold's `external_url`, not a required step, and every other outcome in
   this section is reported exactly as it would be without it.
6. Never target Post, Publish, List, Make live, Ready to post, or any equivalent — including Depop's
   own Post control that sits on the Ready-to-post view you just opened to read SKUs. Reading that
   view is not permission to act on it.

## Copy greenlit listings to Vinted drafts

Vinted (US) has no bulk or CSV import and no public listing API, so each ready Vinted listing gets
its own private draft, one per code call. Fold's `marketplace_fields` already carries Vinted's own
ids (category, brand, size, condition, colors, materials, package size, category-specific lists
such as skirt length); the adapter maps those ids onto the form and never infers one from the
title or description. Use `createAuthenticatedVintedTargetProfile()` only when the user asks to use
their logged-in vinted.com tab.

Greenlighting in Fold is the seller's approval. State the plan once — how many listings, each a
private Vinted draft, never posted — then act without a runtime confirmation.

### Host recipe (copy it; do not improvise the wiring)

Every module below is plain `.mjs` and loads with a dynamic `import()` from the installed plugin
root — the folder holding this skill's `skills/` directory. Keep the handles in your REPL's
persistent state between calls.

**Module cache.** Codex's `node_repl` keeps every imported module cached by its path for the life
of its kernel. After a plugin update, import from the newly installed version's folder (for Codex,
`~/.codex/plugins/cache/vanta/fold/<installed version>/`) — read the version from the installed
plugin, never hard-code an older one — or a stale copy keeps running. Reinstalling the same version
into the same folder does not reload anything: bump the version or restart the kernel.

**Step 0 — once per session, in the browser-capable JS REPL.** Pick the transport:

```js
const root = '<installed plugin root>'
const { createVintedBrowserCapabilityForProvider } = await import(`${root}/adapters/vinted/provider-capabilities.mjs`)
const { createAuthenticatedVintedTargetProfile } = await import(`${root}/adapters/vinted/profile.mjs`)
const { createVintedAdapter } = await import(`${root}/adapters/vinted/adapter.mjs`)
const { runDraftBatch, recordDraftResult, acceptExistingDraft } = await import(`${root}/workflows/draft-batch.mjs`)
const { createPhotoFileResolver } = await import(`${root}/workflows/photo-files.mjs`)
const fs = await import('node:fs/promises')

const profile = createAuthenticatedVintedTargetProfile()
// The seller's Vinted member id: the number in their wardrobe URL, https://www.vinted.com/member/{id}
// (where Save draft lands; also reachable from the avatar menu's profile link). Required: before
// each draft the adapter checks that wardrobe for an existing draft with the same title.
const memberId = '<seller member id>'
// Photos: the capability calls resolvePhotoFiles([{ sourceUrl, filename, order }]) and needs one
// ABSOLUTE local path per photo, same order, basename === filename. This resolver downloads Fold's
// signed URLs into a fresh folder for you. Use any absolute folder the browser can read.
const resolvePhotoFiles = createPhotoFileResolver({ directory: '/tmp/fold-vinted-photos' })
// One report file per run: a new run starts from a path that does not exist yet.
const reportPath = `/tmp/fold-vinted-report-${Date.now()}.json`
const persist = (report) => fs.writeFile(reportPath, JSON.stringify(report))
```

- **Codex desktop / Codex in-app Browser** (provider `codex-browser-client`). Bind a vinted.com
  tab, rebind that same tab id after navigation, and let each draft open in a fresh tab of the same
  browser (`openFreshTab`): a half-filled form left by a failed attempt makes Vinted refuse to
  navigate that tab (`net::ERR_ABORTED`), and the fresh tab leaves it behind, unsaved, to be closed:

  ```js
  const browserId = '<the selected browser id, e.g. "2" for the in-app browser>'
  let tab = await cua.getTab({ url: 'https://www.vinted.com/items/new' }, { browser: browserId })
  const browser = await createVintedBrowserCapabilityForProvider({
    provider: 'codex-browser-client',
    tab,
    profile,
    memberId,
    resolvePhotoFiles,
    reacquireTab: async (id) => (tab = await cua.getTab(id, { browser: browserId })),
    openFreshTab: async (url) => (tab = await cua.createBrowserTab(browserId, url, { visible: true })),
    releaseTab: async (id) => (await cua.getTab(id, { browser: browserId })).close(),
  })
  const adapter = createVintedAdapter({ browser, profile })
  ```

  Photos reach the page only through the file-chooser flow (`tab.playwright.waitForEvent
  ('filechooser')`, a click on the photo control, `chooser.setFiles([...absolute paths])`); the
  installed driver already does exactly that. Never look for `setInputFiles`.
- **Claude in Chrome with a live bridge** (provider `claude-in-chrome`): replace the capability
  options with `{ provider: 'claude-in-chrome', callTool, tabId, profile, resolvePhotoFiles }`, where
  `callTool(name, args)` forwards one `mcp__claude-in-chrome__*` call from inside the running code.
  Without such a bridge there is no qualified Vinted path: stop and tell the user rather than
  driving the form by hand.

**Step 1 — fetch the ready set through the Fold connector** (your Fold MCP tool, outside the
browser REPL if that is where it lives), and hand the result's structured content to the REPL:

```js
const readyListings = /* the list_ready_listings result: { listings, count } */
```

**Step 2 — one draft per call.** Each call does at most one form transaction, sized to fit a
host's per-call time limit:

```js
let report = await fs.readFile(reportPath, 'utf8').then(JSON.parse).catch(() => undefined)
report = await runDraftBatch({ adapter, readyListings, resumeFrom: report, persist })
report  // show: report.next, report.to_record, the last item
```

**Step 3 — record through the Fold connector.** For every `{ listing_id, listing_url }` in
`report.to_record`, call Fold's `mark_published` with exactly those two values, then fold the answer
back in and persist it:

```js
report = recordDraftResult(report, listing_id, markPublishedResult) // or the error it threw
await persist(report)
```

**Step 4 — repeat** Step 2 (and 3) while `report.next` is `'continue'` or `'confirm'`. Stop on
`'done'` or `'stop'`. `'record'` means Step 3 is still owed; nothing new is drafted until it is
done. `'confirm'` means a Save draft from an earlier call has not shown up in the wardrobe yet: the
next Step 2 call looks for it there (it never saves again) before drafting anything else. That
read-only look also runs while other items are still `'record'`ing or the run has `'stop'`ped, so
a pressed save is always resolved; it never creates a draft.

The workflow never calls Fold itself. The persisted report is what prevents duplicates: a listing
it has reached is never drafted again, and a call that dies mid-transaction (a timeout that resets
the REPL) leaves that listing `needs_manual_check` because Save draft may already have been pressed.
Resume only the report of the run in progress. A report from an earlier run or plugin version is
refused (`resumeFrom is not a fold-draft-batch/2 report`) — start a fresh run on a new report path
instead; never edit an old report to make it pass. Each call attempts at most one listing, even
when that listing fails fast, so a run of N listings takes N calls plus its recordings.

### Report

Report every entry in `report.items` by `outcome`:

- `recorded` — draft created, verified, and recorded in Fold.
- `rejected` — refused before any browser use; give the `reason`. A reason about a missing field
  projection means Fold could not supply Vinted's ids for that listing; nothing was guessed.
- `failed` — refused on the form before anything was saved; give `failure_code` (it names the
  field) and `reason` (it carries the underlying cause). The run continued.
- `blocked` with `vinted_phone_verification_required` — Vinted sent the account to phone
  verification. Tell the seller to add and verify a phone number on Vinted, then rerun. Never try to
  get past that page.
- `ambiguous` or `needs_manual_check` — a draft may exist. Tell the seller to check their Vinted
  drafts. Never retry it yourself.
- `draft_unrecorded` — the draft exists (`draft_url`) but Fold did not record it; it stays in
  `to_record`.
- `awaiting_save_confirmation` — Save draft was pressed but Vinted had not shown the draft within
  the call; the next call looks for it in the wardrobe. After three looks without it, it becomes
  `ambiguous`.
- `existing_draft` — a draft with this exact title is already in the seller's wardrobe
  (`candidates`), so nothing was created; the run continued. Typically an earlier run saved it but
  never recorded it. Show the seller the URL; once they confirm it is this listing, call
  `report = acceptExistingDraft(report, listing_id, url)` (loaded from `workflows/draft-batch.mjs`)
  and record it in Step 3 like any other draft. Never create a second draft for it.

When an item carries `authenticity_hint`, tell the seller: Vinted wants proof-of-authenticity
photos (logo, care label, sewn or embroidered logos) for that brand, or may hide the listing. The
adapter closes Vinted's authenticity dialog with its own Close button and never clicks "Add photos"
or "which proofs of authenticity are essential" — adding those photos is the seller's call.

Never target Vinted's **Upload** button — it publishes. The capability refuses it on every click
and presses only **Save draft**. The seller posts drafts inside Vinted.

## Show greenlit listings

1. Call `list_ready_listings` with no arguments.
2. Present only the returned listings as currently greenlit posting candidates.
3. If none are returned, say that nothing is ready; do not describe it as a connection failure.
4. Do not reveal signed photo URLs or full `reference_token` values in the response.

A listing is not safe to post when its `reference_token` is empty, it has no photos, or
`unavailable_photo_count` is not zero.

## Copy greenlit listings to Depop drafts, one form at a time

Use this path only when **Choose how listings reach Depop** selects per-field creation.

1. Call `list_ready_listings` exactly once immediately before planning the batch. That fresh result
   is the sole greenlit candidate set.
2. Select the internal adapter for the requested platform. For Depop, validate every returned
   candidate independently and preserve Fold ordering.
3. Reject before browser use any candidate with a missing exact `reference_token`, no available
   photos, nonzero `unavailable_photo_count`, a platform mismatch, or missing adapter-required
   neutral data. Never invent or derive structured values from title or description. The Depop
   adapter may translate only its finite explicit equivalents, such as `Small` to `S`; this maps a
   supplied fact and never fills one that Fold omitted.
4. Show a redacted batch plan with safe identifiers, counts, and rejection reasons. For every valid
   candidate, identify Depop as the destination, the listing id and title, which structured text
   fields will be transmitted, the garment-photo count, that the exact Fold reference token will be
   transferred to SKU without displaying it, and that the result is a private draft rather than a
   public post. Never reveal signed photo URLs or full reference tokens.
5. Complete the provider's read-only probe, then begin the requested private-draft run. Do not add a
   second runtime-confirmation gate for field entry, option selection, photo resolution, upload, or
   private-draft save. The user's request to run the workflow authorizes creation of private Depop
   drafts only; it does not authorize Post, Publish, List, Make live, or an equivalent public action.
6. Process valid candidates sequentially. Map the exact Fold `reference_token` to Depop SKU,
   preserve Fold-approved content and photo order, and save a draft only.
   Import and call the installed shared workflow's
   `saveAndVerifyDraft({ adapter, listing, resolveInference })` once for each candidate. Do not call
   `adapter.saveDraft()` directly and never pass a prepared draft as its sole argument; the shared
   helper preserves the required `{ listing, prepared }` integrity envelope.
   Implement `resolveInference(request)` as the bounded AI decision described below. It is called
   only when exact matching cannot settle one category, receives only safe approved content and
   live-enumerated options, and must return one structured decision or refuse.
   Resolve photos concurrently into isolated temporary files whose basenames exactly preserve each
   prepared Fold photo filename, then upload the ordered set once.
   Use the shipped visible-browser capability with its zero-delay production default; do not add
   extra pauses, repeated snapshots, or raw API-page navigation to the per-listing path.
   The authenticated profile creates one single-item draft, identifies the one newly created UUID
   draft URL, reopens it, writes the exact SKU, and updates that same draft. A Fold category whose
   audience cannot be read is left blank rather than guessed, and Size and Material are left unset
   with it because Depop keeps them locked until Category holds a value.
7. If the adapter returns `inference_required`, the shared helper calls `resolveInference` once.
   Nothing was written and no draft exists yet. Resolve it as described in **Bounded AI category
   inference** below. If you cannot choose, throw or refuse; the helper leaves the candidate
   rejected without retrying or creating a duplicate.
8. Never target Depop's Post, Publish, List, Make live, Ready to post, or equivalent live action.
   The user reviews and posts the resulting draft inside Depop as a separate action.
9. After each save, require an unambiguous draft result, stable per-draft URL, exact identity
   correlation, exact target taxonomy after bounded equivalent-value normalization, and
   persisted-field/photo-order verification. A toast, attempted save, generic
   drafts-hub URL, validation error, or ambiguous browser state is not success.
10. Only then call `mark_published` once with that listing's exact Fold `listing_id` and verified
    draft URL. Its historical name means the verified external draft was created and recorded.
11. Treat `published` and `already_published` as success and continue. Report every other Fold
    outcome as a refusal and stop the batch.
12. On any adapter failure or ambiguity, do not retry. Stop and report verified drafts, Fold
    outcomes, the failed listing, its safe `failure_code`, rejected candidates, and untouched
    remaining listings. Do not include underlying exception text when it could contain URLs or
    tokens.

For a dry run, stop after the redacted plan. Do not open Depop, save a draft, or call
`mark_published`.

## Bounded AI category inference

Depop's category picker is audience-scoped, and Fold text need not be byte-for-byte identical to a
Depop label. `Womens Sweatshirt / Hoodie` may enumerate plural **Sweatshirts** and **Hoodies**;
`Menswear > Jackets & Coats` may enumerate both **Jackets** and **Coats**. Exact single matches skip
AI. Semantic or multiple matches become a one-time adapter-issued request.

1. Read `request.candidates`. Those labels and groups came from the live picker. They are the only
   choices; never add, singularize, pluralize, trim, or case-fold one yourself.
2. Decide using **only** `request.listing.title`, `request.listing.description`, the source category,
   and the offered candidates. Do not use photos, outside knowledge, browsing, or brand lore.
3. Do not reinterpret the photos, do not use outside knowledge of the brand or garment, and do not
   invent or adjust a label. If confidence would be low, throw or return no decision so the helper
   stops before a write.
4. Otherwise return exactly:

   ```js
   {
     chosenLabel: 'Hoodies',
     confidence: 'high', // high or medium; low is refused
     reason: 'The approved title and description identify the item as a hoodie.',
     evidence: ['hoodie', 'zip-up hoodie'],
   }
   ```

   Each evidence string must be copied exactly from the approved title or description. The adapter
   rejects invented evidence, an unoffered label, a stale/wrong-listing request, a replay, or a
   caller-fabricated challenge. It then re-enumerates the chosen exact label before clicking.

Worked example. Candidates are **Sweatshirts** and **Hoodies**. The approved title reads "gray
hoodie" and the description says "zip-up hoodie". Returning **Hoodies** with those exact excerpts
is legitimate content-grounded inference. Had the approved content said only "gray pullover",
neither candidate would be sufficiently supported and the right move would be to stop.

State plainly in your final report which categories you chose and why, so the choice is reviewable.

## Sync a sold listing to Fold

Require exactly one verified resale-platform sale signal resolved to exactly one Fold listing. A
qualified notification adapter must provide the exact Fold `listing_id` or match the full exact
`reference_token`. Never match by title similarity.

If the match is missing or ambiguous, explain the problem and do not call `mark_sold`. Otherwise,
call `mark_sold` once with the verified identifier. Treat `already_sold` as a successful no-op. For
`sold`, its `cascaded_listings` are the piece's other listings: take them down with the
`sold-with-fold` skill's one consolidated approval, which deletes Depop and Vinted siblings and names
the rest for the seller to remove. There are no durable retries.

## Report the result

State how many greenlit listings were returned, which candidates were valid or rejected, which
drafts were independently verified, each Fold outcome, any failed listing, and untouched remaining
listings. Do not expose credentials, signed media URLs, or full reference tokens. Describe whether
the run used the simulator or the owner-supervised authenticated-web profile. Never describe a
saved draft as publicly live.

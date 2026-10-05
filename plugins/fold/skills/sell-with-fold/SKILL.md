---
name: sell-with-fold
description: Use when someone wants to copy greenlit Fold listings to a resale platform as drafts (the default), make drafts live only when they explicitly ask, mark a listing sold so its drafted copies are cleaned up and live copies taken down, or keep Fold in sync with resale activity.
---

# Sell with Fold

Use Fold as the source of truth for listings the user has greenlit. Help the user see what is ready,
copy all qualified greenlit listings to a supported resale platform as drafts, or sync a confirmed
sale back to Fold.

## First: are Fold's tools connected?

Before anything else, check that Fold's MCP tools are available to you (`mcp__fold__*` —
`list_ready_listings`, `export_depop_csv`, `report_csv_upload`, `mark_published`, `mark_sold`, and
for going live `list_drafted_listings`, `mark_live`; in a host that defers tools, look them up first). If they are not, tell the seller Fold needs them to sign
in — in ChatGPT: **Plugins → Fold → sign in** (or **Reconnect**); after a plugin update ChatGPT may
ask for this again — and **stop**. Never read the Fold web page, a Fold browser tab or a screenshot as
a substitute for `list_ready_listings`, and never infer greenlit, ready or published status from the
Fold UI. Only Fold's tools answer those questions.

## Understand the request

- “Greenlit,” “approved,” and “ready” refer only to listings returned by the current
  `list_ready_listings` call. Never infer approval from prior conversation or other Fold data.
- “Copy,” “post,” or “list” means create and independently verify one private draft. On its own it
  never means make the listing public.
- **Live only on explicit live wording.** Only a request that itself says the listings should be
  live — “post these live”, “make my Vinted drafts live”, “publish live”, “take them live” —
  authorizes going live, and only for the listings and marketplaces it names. Without that wording,
  never go live: drafts are the default, and an ambiguous request stays drafts (ask if unsure;
  never assume). Earlier conversation, greenlighting in Fold, or a draft run finishing is not live
  consent. See **Make drafts live** below.
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
  bridge. Use **Post drafts** below.
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
`mark_published`, `export_depop_csv`, `report_csv_upload`, `list_drafted_listings`, `mark_live`) come
from the Fold MCP server, not a local file.

- `workflows/post-drafts.mjs` — the draft-posting phases `depopPrepare`, `depopUpload`,
  `vintedDraft`, `summarizeResults`, and `codexBrowser`, plus the go-live phases `vintedGoLive` and
  `depopGoLive`. **Posting drafts to Depop (bulk) or Vinted means running these phases and nothing
  else** — see **Post drafts** below; **going live means running the go-live phases and nothing
  else** — see **Make drafts live**. Do not import or call `exportDepopCsvBatch`, `importCsvBatch`,
  `runDraftBatch`, `recordDraftResult`, a go-live capability or a provider factory yourself; the
  phases wire them in the right order.
- `workflows/draft-batch.mjs` — `acceptExistingDraft`, for a Vinted `existing_draft` the seller
  confirmed (see the outcomes below)
- `workflows/lifecycle.mjs` — `saveAndVerifyDraft`, for Depop per-field creation only
- `adapters/depop/provider-capabilities.mjs` — `createDepopBrowserCapabilityForProvider`, for Depop
  per-field creation only
- `adapters/depop/profile.mjs` — `createDepopSimulatorTargetProfile`,
  `createAuthenticatedDepopTargetProfile`

Two draft platforms are supported. Depop has two paths: the bulk one hands Depop's own bulk-listing
page a CSV (the default, through the Depop phases), the per-field one drives the create form — see
**Choose how listings reach Depop** below. Vinted has one: the vinted.com sell form, one listing per
`vintedDraft` call. Every path uses a host-provided browser service to adapt one visible
semantic browser tab; none installs another browser service. Select the transport by the host, never
by the browser's brand:

- **Codex desktop / Codex in-app Browser** — provider `codex-browser-client` with the exact tab the
  host bound, plus `reacquireTab(tabId, url)` (rebind the same tab id after navigation — Codex tab
  bindings go stale), `releaseTab(tabId, replacementTabId)` (close a superseded binding) and, for
  Vinted, `openFreshTab(url)` (a half-filled form left by a failed attempt makes Vinted refuse to
  navigate that tab). `codexBrowser({ cua, browserId, tabId })` builds exactly these options; call
  it inside the same `js` call as the phase that uses them. The installed driver verifies URLs, uses
  exact browser-client locators and the file-chooser API; do not synthesize a raw MCP bridge or use
  private RPC.
- **Claude in Chrome with a live bridge** — provider `claude-in-chrome` with `callTool` (forwards one
  `mcp__claude-in-chrome__*` call from inside the running code) and the selected `tabId`. A Bash- or
  Node-spawned process is a separate OS process and cannot do this; verify with a trivial call before
  committing a run to this path, and otherwise use **Bulk listing without a live code-execution
  bridge** below.
- Codex CLI and IDE have no qualified browser provider: return `browser_provider_unsupported`. Do
  not improvise one.

The provider performs a read-only tab/origin probe, then requires the exact surface before the first
write. A provider failure stops before anything is sent and is reported with its safe code. Never
include browser-session internals, signed URLs, credentials, cookies, or a full Fold reference token
in a report. For loopback qualification use `createDepopSimulatorTargetProfile`; never invoke a
development harness found elsewhere in a source checkout as if it were the installed adapter.

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

## Post drafts

**Consent.** A request to post, draft, list or copy greenlit listings while the marketplace tab is
open **is** the consent to use that logged-in tab and the seller's authenticated profile. Do not ask
"may I use your logged-in tab" or any other confirmation. Greenlighting in Fold is the seller's
approval of the listings. State the plan in one sentence — how many listings, which marketplace,
private drafts, never posted — then call. Still drafts only: never Post, Publish, Upload-live, Make
live or Ready to post; never retry a failed upload; never re-upload a pending row. The draft phases
never go live; only the go-live phases do, and only on explicit live wording (**Make drafts live**).

**First, clear old drafts.** Before drafting, call `list_pending_delists`. Entries with `kind:
'draft'` (a Redo or a Delist all the seller made in Fold; `sold_listing_id` is null) are old
marketplace drafts Fold is holding listings back for — a held listing is left out of
`list_ready_listings` and the CSV until its old draft is deleted. Delete them first with the
delist phase for that marketplace, `draftsOnly: true`, as in `sold-with-fold`'s **Take down open
copies** (pending file, phase, then its `report_delist` call). This is the seller's own Redo or
Delist intent, so no live wording is needed — and `draftsOnly` never takes anything live or down
beyond those drafts. Tell the seller in one line that the old drafts were cleared, then continue with
`list_ready_listings` / the export as below. For example, on Depop in the Codex app:

```js
var del = await import(`${root}/workflows/delist-phases.mjs`)
var cleared = await del.depopDelist({
  browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
  pendingPath: '<the pending.json path exec printed>',
  priorStatePath: <the previous delist call's cleared.state_path on a rerun, else omit>,
  listingIds: <omit: every draft-kind entry for this marketplace>,
  draftsOnly: true,
})
cleared
```

**Phases, never one long run.** Posting is a short sequence of phases from
`workflows/post-drafts.mjs`. Each browser phase does all of its browser work inside the one call that
runs it and returns a plain JSON result; Fold's tools are called **between** phases, by you, and their
answers are handed to the next phase through private temp files the phases name. No phase ever waits
for a Fold answer, so nothing is left running between calls.

- **Depop** (bulk): `depopPrepare` (proves the bulk page usable; no Fold call) → you call
  `export_depop_csv` and save its result to `prepared.export_path` → `depopUpload` (writes the CSV,
  uploads once, reads Depop's notice, correlates drafts by SKU, reconciles rows earlier runs
  delivered) → you run the `fold_calls` it names, in order (`report_csv_upload` exactly once, then
  one `mark_published` per correlated draft) → `summarizeResults` gives the final report.
- **Vinted**: you call `list_ready_listings` and save its result → `vintedDraft` (one draft per call,
  Vinted listings only) → you run its `fold_calls` (`mark_published`) → `summarizeResults`. While the
  `next` you end on is `'continue'` or `'confirm'`, run `vintedDraft` again with
  `resumeFrom: step.report_path` and the same `readyPath`. Stop on `'done'` or `'stop'`.

Run each `fold_calls` list exactly as written, once, in order. Never retry a Fold call, never skip
`report_csv_upload`, never run `depopUpload` twice for one `depopPrepare` (it refuses: an upload is
never repeated). If `prepared.next` is `'stop'`, do not export at all — report the reason.

### Codex app (in-app Browser)

In the Codex app Fold's tools and the browser live in **different runtimes**: Fold's MCP tools are
callable only from `exec` (`tools.mcp__fold__*`), the browser `cua` only from the `cua_repl` `js`
tool, and neither can call the other. Browser access is also bound to the `js` call that started the
work: a promise still running when its `js` call returns loses the browser for good ("node_repl exec
context not found"), even with a fresh tab handle. So alternate `js` and `exec` exactly as below.
Every `js` block awaits its phase to the end and builds its browser options with
`codexBrowser({ cua, browserId, tabId, onTabChange })` **inside that same call**; never reuse a tab
object or browser options from an earlier call, and never leave a promise running at the end of a
call.

**Module cache.** `cua_repl` keeps imported modules cached by path for the life of its kernel. Import
from the installed version's folder — `~/.codex/plugins/cache/vanta/fold/<installed version>/`, read
the version from the installed plugin, never hard-code an older one — or restart the kernel after an
update.

**Timeouts.** Run every `depopUpload` and `vintedDraft` `js` call with `timeout_ms: 300000`
(`DEPOP_UPLOAD_JS_TIMEOUT_MS`): a Depop upload waits up to two minutes for Depop to import and keeps
its own work, draft matching included, under 270 seconds; a Vinted step drafts one listing. The
other phases fit the default.

**Exec preamble.** Paste this at the top of every `exec` block below. It calls one Fold tool (a
thrown error becomes an `isError` result, never a retry) and writes JSON privately in 16 KiB chunks
through a `.part` file:

```js
const sh = (cmd) => tools.exec_command({ cmd, max_output_tokens: 20000 })
const quote = (value) => String(value).replaceAll("'", "'\\''")
async function callFold(name, args) {
  try {
    return await tools[`mcp__fold__${name}`](args)
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }
  }
}
async function writePrivateJson(file, value) {
  const chunks = JSON.stringify(value).match(/[\s\S]{1,16384}/g) ?? ['']
  const partial = `${file}.part`
  for (const [index, chunk] of chunks.entries()) {
    const redirect = index === 0 ? '>' : '>>'
    const prefix = index === 0 ? 'umask 077; ' : ''
    await sh(`${prefix}printf '%s' '${quote(chunk)}' ${redirect} '${quote(partial)}'`)
  }
  await sh(`mv '${quote(partial)}' '${quote(file)}'`)
}
```

**Run the Fold calls a phase named** (used by both marketplaces, only when the phase returned
`next: 'call_fold'`) — `exec`, after the preamble, with the phase's `fold_calls_path` pasted in:

```js
const job = JSON.parse((await sh(`cat '<fold_calls_path>'`)).output)
const results = []
for (const call of job.fold_calls) {
  results.push({ name: call.name, result: await callFold(call.name, call.args) })
}
await writePrivateJson(job.results_path, results)
text(results.map((entry) => `${entry.name}: ${entry.result?.isError === true ? 'error' : 'ok'}`))
```

#### Depop

1. **`js` — prepare.** Use `var` so the values survive between calls.

   ```js
   var root = '<installed plugin root>'
   var post = await import(`${root}/workflows/post-drafts.mjs`)
   var browserId = '<browser id of the open Depop tab>'
   var tabId = '<that tab id>'
   var onTabChange = (id) => { tabId = id }
   var prepared = await post.depopPrepare({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
   })
   prepared
   ```

   If `prepared.next` is `'stop'`, report `prepared.report.summary_text` and stop. Nothing was
   exported.

2. **`exec` — export.** After the preamble, with `prepared.export_path` pasted in:

   ```js
   const exported = await callFold('export_depop_csv', {})
   await writePrivateJson('<prepared.export_path>', exported)
   text(exported?.isError === true ? 'Fold refused the export' : 'export saved')
   ```

3. **`js` with `timeout_ms: 300000` — upload.** Run it even if Fold refused the export; it reports
   that without touching the page.

   ```js
   var uploaded = await post.depopUpload({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     statePath: prepared.state_path,
     exportPath: prepared.export_path,
   })
   uploaded
   ```

4. If `uploaded.next` is `'call_fold'`, **`exec` — run the Fold calls** with
   `uploaded.fold_calls_path` (block above).

5. **`js` — final report.**

   ```js
   var summary = uploaded.next === 'call_fold'
     ? await post.summarizeResults({ statePath: prepared.state_path, resultsPath: uploaded.results_path })
     : uploaded.report
   summary
   ```

#### Vinted

1. **`exec` — ready listings.** After the preamble:

   ```js
   const dir = (await sh(`umask 077; mktemp -d "\${TMPDIR:-/tmp}/fold-ready-XXXXXXXX"`)).output.trim()
   const ready = await callFold('list_ready_listings', {})
   await writePrivateJson(`${dir}/ready.json`, ready)
   text(`${dir}/ready.json`)
   ```

2. **`js` with `timeout_ms: 300000` — one draft.** The first time:

   ```js
   var root = '<installed plugin root>'
   var post = await import(`${root}/workflows/post-drafts.mjs`)
   var browserId = '<browser id of the open Vinted tab>'
   var tabId = '<that tab id>'
   var onTabChange = (id) => { tabId = id }
   var readyPath = '<the ready.json path exec printed>'
   var memberId = '<the number in https://www.vinted.com/member/{id}>'
   var step = await post.vintedDraft({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     readyPath,
     memberId,
   })
   step
   ```

   Every later step, in a new `js` call with `timeout_ms: 300000`:

   ```js
   step = await post.vintedDraft({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     readyPath,
     memberId,
     resumeFrom: step.report_path,
   })
   step
   ```

3. If `step.next` is `'call_fold'`, **`exec` — run the Fold calls** with `step.fold_calls_path`, then
   **`js`**:

   ```js
   var summary = await post.summarizeResults({ statePath: step.report_path, resultsPath: step.results_path })
   summary
   ```

   and continue with `summary.next`; otherwise continue with `step.next` (the report is
   `step.report`). While that is `'continue'` or `'confirm'`, go back to step 2 ("every later
   step"). Stop on `'done'` or `'stop'`.

If no runtime can write the temp files, stop and tell the user; do not fall back to hand-wiring the
workflow modules.

### Claude in Chrome with a live bridge

Run the same phases with `browser: { provider: 'claude-in-chrome', callTool: <your
mcp__claude-in-chrome__* bridge>, tabId }` (and `memberId` for Vinted), awaiting each phase to the
end. Call Fold's tools yourself between phases and save each raw result as JSON where the phase says:
the export to `prepared.export_path`, the ready listings to a private temp file you pass as
`readyPath`, and the results of a `fold_calls_path` job as `[{ name, result }]`, in order, to that
job's `results_path`.

### Report

`report` below is the final report: `summary` after `summarizeResults`, or the phase's own `report`
when it named no Fold calls. Say plainly what `report.summary_text` says, then each entry of
`report.listings` by `outcome`:

- `recorded` — draft created and recorded in Fold (`reconciled: true`: it came from an earlier
  run's upload and was matched by SKU now).
- `pending` (Depop) — no draft with that SKU has appeared. Depop may still be processing it, **or
  may have silently rejected that row** — nothing on the page tells those apart, so say exactly that:
  not appeared, not recorded, unresolved rather than failed. Depop emails the seller when an import
  finishes. Never re-upload to chase it. `pending` (Vinted) — still queued for a later call.
- `awaiting_confirmation` (Depop) — an earlier run delivered this row but its draft has not been
  found yet; Fold keeps it held and the next run looks again.
- `ambiguous` — two drafts carry the SKU, or a Vinted save could not be confirmed. The seller
  decides; never pick one or retry.
- `not_imported` (Depop) — nothing was created for it; give `failure_code`, `reason`, and any
  `platform_errors` verbatim (Depop's own field labels, e.g. `Brand`,
  `Field_name.picture_Hero_url`). A rejected file is a defect in the export, not something to patch.
  `bulk_listing_platform_error` is the only case where a retry is reasonable — ask the user, never
  retry yourself.
- `old_draft_pending_deletion` — the new draft exists (`listing_url`) but Fold did not record it:
  Fold holds the listing until its old draft from a Redo is deleted. Say "old draft still to
  delete", run the cleanup above (**First, clear old drafts**), then call `mark_published({
  listing_id, listing_url, visibility: 'draft' })` for it. Neither recorded nor failed; never
  re-draft it.
- `draft_unrecorded` — the draft exists (`listing_url`) but Fold did not record it; a later run with
  the same report records it, never re-drafts it.
- Vinted: `rejected` (refused before browser use — Fold could not supply Vinted's ids; nothing was
  guessed), `failed` (refused on the form before saving; `failure_code` names the field), `blocked`
  with `vinted_phone_verification_required` (the seller verifies a phone number on Vinted, then
  reruns; never try to get past that page), `needs_manual_check` (a call died mid-save; check the
  Vinted drafts), `awaiting_save_confirmation` (the next call looks for it in the wardrobe),
  `existing_draft` (a draft with this title is already in the wardrobe, `candidates`; once the seller
  confirms it is this listing, `acceptExistingDraft(report.draft_batch, listing_id, url)` from
  `workflows/draft-batch.mjs`, persist it to `report.report_path`, and the next call records it).
- `authenticity_hint` on a Vinted item: Vinted wants proof-of-authenticity photos for that brand or
  may hide the listing; adding them is the seller's call. `brand_id_fallback`: Vinted did not offer
  Fold's brand id, so the brand was chosen by name (`name_match`) or entered as a custom brand.

Also report, for Depop: `report.export.truncated` (a capped export is never the complete set),
every `report.export.blanked_cells` entry (a value Fold withheld because it did not match Depop's
list for that field — tell the seller which listing, field and value so they can fix it), and
`report.upload_report.outcome`. Fold leases what it exports for 30 minutes: a run that failed before
delivering the file has already released the hold (`report_csv_upload` with `uploaded: false`); a
delivered file keeps its rows held until a later run matches their drafts by SKU, which
`depopUpload` does automatically. `report.other_marketplace_listings` are ready listings for other marketplaces —
offer to post those separately; they are not failures. `report.fold_errors` lists Fold calls that
failed; they are never retried.

In the draft phases, never target Post, Publish, List, Make live, Ready to post or Vinted's
**Upload** (it publishes). The draft capabilities refuse every live control and press only Depop's
file upload or Vinted's Save draft. Without explicit live wording the seller posts drafts inside the
marketplace.

## Make drafts live

**Only on explicit live wording** (see **Understand the request**). Without it, never run a go-live
phase, and never press Post, Upload or any live control yourself — by hand, by script, or by
another tool. With it, the go-live phases are the only way: `vintedGoLive` and `depopGoLive` in
`workflows/post-drafts.mjs`. State the plan in one sentence — how many listings, which marketplace,
going live publicly — then call.

What a go-live phase does, per listing, inside one `js` call: it takes the exact `draft_url` Fold
recorded (`list_drafted_listings`), refuses it unless it is that marketplace's draft edit URL
(Vinted `https://www.vinted.com/items/{id}/edit`, Depop
`https://www.depop.com/sellinghub/drafts/edit/{uuid}/`), opens it, proves it is that listing's draft
(Vinted: the URL's item id with Save draft and Delete draft present; Depop: the SKU field equals the
listing's SKU), presses the one go-live control once (Vinted **Upload**; Depop **Post**, never
Delete or Update draft), confirms the page changed, verifies the public listing (Vinted
`/items/{id}-{slug}` with the owner's controls; Depop the SKU on Active/Selling and
`/products/{slug}/`), and names one `mark_live` call with the public URL. A press is never
repeated; a draft that is already live is recorded without pressing anything.

Two flows:

- **Draft, then live, in one run** ("post these live"): run **Post drafts** to the end as usual
  (the draft phases record each draft with `mark_published` and `visibility: 'draft'`). Collect the
  `listing_id`s whose final outcome is `recorded` — only those go live. Then call
  `list_drafted_listings`, and run the go-live phase for that marketplace with
  `listingIds` set to them → run its `fold_calls` (`mark_live`) → `summarizeResults`.
- **Live only, on existing drafts** ("make my Vinted drafts live"): call `list_drafted_listings`,
  then run the go-live phase for the named marketplace (no `listingIds`: every Fold-recorded draft
  there; or the ids of the listings the seller named) → `mark_live` calls → `summarizeResults`.

**Every rerun passes the previous run's state** as `priorStatePath: live.state_path`. A listing any
earlier call pressed is never pressed again — it only gets read-only proof that it is live, and if
that fails it stays `unconfirmed` and the seller checks it by hand. While the report's `next` is
`'continue'` (the phase stopped to stay inside its time budget), call `list_drafted_listings`
again and rerun with `priorStatePath` and `listingIds: live.report.not_attempted_listing_ids`.
Stop on `'done'`. Never rerun to "retry" an `unconfirmed` listing.

The drafted-listings file must be exactly as the exec snippet below makes it — `drafted.json` in a
`mktemp -d` folder named `fold-drafted-*` under the temp directory, written by
`writePrivateJson` — or the phase refuses it.

### Codex app (in-app Browser)

Same runtime rules as **Post drafts → Codex app**: the exec preamble above, every browser phase
awaited to the end inside one `js` call with `timeout_ms: 300000` (`GO_LIVE_JS_TIMEOUT_MS`), its
browser options built in that same call.

1. **`exec` — drafted listings.** After the preamble:

   ```js
   const dir = (await sh(`umask 077; mktemp -d "\${TMPDIR:-/tmp}/fold-drafted-XXXXXXXX"`)).output.trim()
   const drafted = await callFold('list_drafted_listings', {})
   await writePrivateJson(`${dir}/drafted.json`, drafted)
   text(`${dir}/drafted.json`)
   ```

2. **`js` with `timeout_ms: 300000` — go live.** For Vinted (Depop: `post.depopGoLive`, with the
   open Depop tab):

   ```js
   var root = '<installed plugin root>'
   var post = await import(`${root}/workflows/post-drafts.mjs`)
   var browserId = '<browser id of the open Vinted tab>'
   var tabId = '<that tab id>'
   var onTabChange = (id) => { tabId = id }
   var live = await post.vintedGoLive({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     draftedPath: '<the drafted.json path exec printed>',
     priorStatePath: <the previous go-live call's live.state_path on a rerun, else omit>,
     listingIds: <the recorded listing ids for "post these live", or omit for all drafts>,
   })
   live
   ```

   ```js
   var live = await post.depopGoLive({
     browser: await post.codexBrowser({ cua, browserId, tabId, onTabChange }),
     draftedPath: '<the drafted.json path exec printed>',
     priorStatePath: <the previous go-live call's live.state_path on a rerun, else omit>,
     listingIds: <the recorded listing ids for "post these live", or omit for all drafts>,
   })
   live
   ```

3. If `live.next` is `'call_fold'`, **`exec` — run the Fold calls** with `live.fold_calls_path`
   (block above), then **`js`**:

   ```js
   var liveSummary = await post.summarizeResults({ statePath: live.state_path, resultsPath: live.results_path })
   liveSummary
   ```

   Otherwise the report is `live.report`.

With Claude in Chrome and a live bridge, run the same phases with `browser: { provider:
'claude-in-chrome', callTool, tabId }`, saving `list_drafted_listings` to a private file you pass as
`draftedPath`. Without a live bridge there is no go-live path: say so and stop; never press a live
control by hand.

### Go-live report

Say plainly what `report.summary_text` says — it names every public link — then each entry of
`report.listings` by `outcome`:

- `live` — public on the marketplace at `public_url` (give the link). `recorded: true` once Fold
  recorded it (`fold_outcome` `live` or `already_live`); `reconciled: true` means it was already live
  and nothing was pressed; `located_by: 'sku'` means Depop's success page gave no link and the
  listing was found by SKU on Active/Selling.
- `live_unrecorded` — public on the marketplace, but Fold refused `mark_live` (`fold_outcome`,
  `reason`); give the link and the reason. Never retried.
- `incomplete` (Depop) — Depop's own validation blocked Post; nothing was posted. Name `fields` when
  present; the seller fills them in Depop, then asks again.
- `mismatch` — the recorded URL was not a draft URL, or the page was not this listing's draft (wrong
  item id, wrong SKU, a missing or ambiguous control). Nothing was pressed.
- `unconfirmed` — the control was pressed once but going live could not be proven (no page change,
  or the public page did not show it). It was **not** pressed again. Tell the seller to check the
  marketplace; a later go-live run records it without pressing if it is live.
- `error` — something failed before anything was pressed; give `failure_code` and `message`.
- `not_attempted` — left for the next go-live call (`next: 'continue'`).

`report.not_drafted_listing_ids` names requested listings Fold has no draft for (draft them first).

## Bulk listing without a live code-execution bridge (native browser tools)

Use this only when you cannot run the **Post drafts** phases against a live browser transport (see **Know the
capability boundary**) — for example, a Bash/Node/Bun tool that can execute this repository's files
but cannot itself call your browser MCP tools mid-script. You then do by hand, in this order, what
the phases do; the outcome meanings in **Post drafts → Report** are unchanged.

**Order matters: prove the page before exporting.** Fold leases the rows it exports for 30 minutes.
Exporting onto a page that then fails leaves listings held with nothing uploaded.

1. Open and inspect the bulk page (steps A–B below) **before** calling `export_depop_csv`.
2. Call `export_depop_csv`. A refusal (`isError`) is shown to the seller verbatim; an empty export is
   normal. Note `submission_id`. Write `csv` **byte for byte** to a `.csv` file — never add, strip
   or reorder anything, including the three template header lines.
3. If `awaiting_confirmation` has rows with `delivered: true`, an earlier upload was never matched:
   look for each one's `sku` in the draft views (step E) and `mark_published` the ones that match
   exactly one draft (with `visibility: 'draft'`). Leave `delivered: false` rows alone — another
   export holds them.
4. Deliver the file (step C) and read the alert (step D).
5. Call `report_csv_upload({ submission_id, uploaded, note })` **exactly once** (skip it if
   `submission_id` is null): `uploaded: false` with a short `note` if the file was never delivered
   (any failure after the export and before delivery) or Depop refused it (bad headers, row
   errors); `uploaded: true` once it was delivered and accepted — and also when delivered but the
   outcome is unknown (generic error, no alert), because a duplicate draft is worse than a held one.
6. Correlate and record (step E).

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

A. Navigate to `https://www.depop.com/sellinghub/bulklisting/`.
B. Read the page's accessibility tree (not a screenshot). The main panel hydrates slowly: if
   "Upload file" is not there yet, re-read a few times over about 20 seconds before concluding the
   page is broken. Confirm exactly one button
   with the exact accessible name "Upload file" exists, and exactly one file-input-role element exists. Locate both;
   activate neither. Clicking the visible trigger opens an OS file dialog you cannot see or drive —
   the file input must be addressed directly by its own element reference instead.
C. Before touching the file input, confirm you are on a genuine Claude in Chrome tab (see above) and
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
D. Read the page again. Look for a `role="alert"` element next to the file input. Its text is the
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
E. On accepted (or unconfirmed), poll for per-row outcomes by opening each of Depop's three draft
   views by its own URL — never by clicking a tab toggle, since a redirect could otherwise pass as
   coverage:
   - `https://www.depop.com/sellinghub/drafts/incomplete/`
   - `https://www.depop.com/sellinghub/drafts/readyToPost/`
   - `https://www.depop.com/sellinghub/drafts/scheduled/`
   For each exported listing's exact `sku` (the piece code, never `reference_token`), search the
   draft rows across all three views for that SKU, read that draft's own stable edit URL, and record
   the pairing. Poll on a bounded interval (Depop imports asynchronously and emails when finished) up
   to a reasonable timeout before reporting the remainder as `pending_at_timeout`, matching the
   outcome semantics in **Post drafts → Report**. Draft views can show `Loading…` for a few
   seconds; wait for it to clear before reading a view as empty. A row under Incomplete is a successful import, not a failure.

   The moment a SKU pairs to exactly one stable draft URL — a **confirmed** outcome — call
   `mark_published` once with that listing's exact `listing_id`, that URL as `listing_url` and
   `visibility: 'draft'`, right here during polling rather than waiting for a later step. Do this
   only for a confirmed pairing: never for a SKU still `pending_at_timeout`, never for `ambiguous` (two drafts share a
   SKU), and never for a row this run cannot otherwise recognize. If the `mark_published` call
   itself fails, report that to the seller but do not fail or retry the import over it — this is
   best-effort enrichment of Fold's `external_url`, not a required step, and every other outcome in
   this section is reported exactly as it would be without it.
F. Never target Post, Publish, List, Make live, Ready to post, or any equivalent — including Depop's
   own Post control that sits on the Ready-to-post view you just opened to read SKUs. Reading that
   view is not permission to act on it.

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
10. Only then call `mark_published` once with that listing's exact Fold `listing_id`, verified
    draft URL and `visibility: 'draft'`. Its historical name means the verified external draft was
    created and recorded.
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
`sold-with-fold` skill's one consolidated approval. Each carries `kind`: drafted copies (`'draft'`)
are deleted on Depop and Vinted at their recorded `draft_url`, live listings (`'live'`) are taken
down, and other platforms are named for the seller to remove. A seller's **Delist all** in Fold is
finished the same way, starting from `list_pending_delists`. Delists are never retried.

## Report the result

State how many greenlit listings were returned, which candidates were valid or rejected, which
drafts were independently verified, each Fold outcome, any failed listing, and untouched remaining
listings. Do not expose credentials, signed media URLs, or full reference tokens. Describe whether
the run used the simulator or the owner-supervised authenticated-web profile. Never describe a
saved draft as publicly live.

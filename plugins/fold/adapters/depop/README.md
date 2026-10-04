# Depop draft adapter

Internal Depop draft adapter for the installed `fold` plugin. It prepares one
Fold-approved listing, drives an injected semantic browser capability, saves a draft, and verifies
the persisted draft before the shared workflow may call Fold's lifecycle tool.

This adapter never imports Fold internals or the development Marketplace Simulator. The shared
workflow owns Fold MCP calls, batch ordering, and final reporting.

## Browser contract

`createDepopAdapter({ browser, profile })` expects the injected browser to provide:

- `navigate(url)`
- `inspectDraftSurface()` returning normalized `controls` and `fields`
- `fillField(locator, value)`
- `selectField(locator, value)`
- `uploadPhotos(locator, orderedPhotos)`
- `activate(locator)`
- `observeDraftSave()`
- `readDraft(identity)` returning normalized persisted draft state

`createDepopBrowserCapability({ tab, profile, resolvePhotoFiles, interactionDelayMs })` from
`browser-capability.mjs` supplies that contract for a host-owned visible browser tab. It uses exact
labels and roles, resolves ordered photos only at upload time, reads verification from the saved
draft page, and never navigates the visible tab to a raw JSON endpoint. The production default adds
no visual step delay; pass a nonzero `interactionDelayMs` only for a deliberately slowed demo.

## Three layers

The adapter is split so that changing automation tools never reaches the safety logic:

- **Layer A** is the capability contract above. `adapter.mjs` and the shared workflow depend on it
  and on nothing below it.
- **Layer B** is `browser-capability.mjs`. It implements Layer A and owns every determinism gate:
  exact label/role matching, live-action refusal, content fidelity, and draft identity correlation.
- **Layer C** is `../shared/browser-driver.mjs`, the minimal interface an automation tool must supply:
  `locate`, `fill`, `click`, `clickAndWaitForNavigation`, `selectOption`, `uploadFiles`, and
  `readText`.

A `tab` therefore provides `goto(url)`, `url()`, and a `driver` implementing Layer C. Every Layer C
query matches exactly; exactness is a determinism guarantee, not a per-call option, so a tool that
can only match approximately cannot back this adapter. Layer C exposes no operation that reaches a
control without Layer B first resolving it and checking the live-action gate, so no driver can open
a path around that check.

`../shared/browser-provider-registry.mjs` routes by the injected host transport rather than the
browser name; Depop's own factories live in `provider-capabilities.mjs`. It supports `codex-browser-client` and `claude-in-chrome`, performs a read-only selected-tab and
origin probe, and gates the first data-bearing operation on exact form controls, atomic navigation,
and an inspectable multiple-file input. Codex CLI, Codex IDE, and unqualified third-party harnesses
fail closed; they are not treated as Chrome transports merely because they may launch Chrome.

## Codex browser-client driver

`../shared/codex-browser-client-driver.mjs` implements Layer C against a host-selected or
host-claimed Codex tab. It maps exact queries to `getByLabel(..., { exact: true })`,
`getByRole(..., { name, exact: true })`, `getByTestId`, or an explicit CSS selector. It uses locator
actions for every mutation, `expectNavigation` for the atomic navigation action, and
`waitForEvent('filechooser')` plus `setFiles` for ordered photo delivery. Locator evaluation reads
semantic descriptors and multiple-file support only; it never mutates the page.

Codex tab bindings may become stale when their document navigates. The host therefore injects
`reacquireTab(tabId, url)`, which creates a fresh binding in the same browser at exactly the
navigated URL, plus `releaseTab(tabId, replacementTabId)`. The wrapper verifies the replacement,
releases the superseded binding, and only then adopts the new locator binding. It refuses
reacquisition without cleanup, and releases an invalid replacement before failing, so one run keeps
at most one visible working tab. It never chooses a URL, account, or browser itself.

Native selects may retain duplicate labels in hidden or disabled option families. Exact option
selection counts only eligible options; two visible/enabled matches still refuse. Before opening a
file chooser, Layer B also requires every resolved local basename to equal its prepared Fold photo
filename in order, preventing a known mismatch from becoming an external draft that can only fail
during persisted verification.

The driver does not open a browser, select or claim a tab, choose an account, decide authorization,
call private RPC, synthesize `javascript_tool`, or fall back to fuzzy natural-language matching.

## claude-in-chrome driver

`../shared/claude-in-chrome-driver.mjs` implements Layer C against the claude-in-chrome MCP tools.
`createClaudeInChromeTab({ callTool, tabId })` returns a ready `tab`; the host owns the browser and
supplies `callTool`, which forwards exactly one MCP call. The shim never opens a browser, picks a
tab, or decides that a target is authorized.

Element lookup runs through `javascript_tool`, not `find`. `find` resolves elements from a natural
language description, which is a fuzzy match by construction, and a fuzzy match that lands on a real
control is indistinguishable from a correct one once it reaches a Depop form. The shim's page script
does the exact matching itself and stamps each match with a fresh `data-vanta-ref` token, so every
later operation addresses exactly the element that was matched. Every value crossing into page
source is embedded with `JSON.stringify`, because listing text is seller-authored and must never be
able to close a string literal and become script.

### Photo upload: confirmed capability, unconfirmed against Depop

`file_upload` accepts an array of absolute paths and an element reference, and its own
documentation states that clicking a file control is the wrong approach because the native picker is
unreachable. That maps directly onto `uploadFiles(ref, paths)`. Two things about the photo step are
**not** confirmed, because confirming them requires the owner-supervised authenticated run that has
not happened:

1. `file_upload` needs an element reference minted by `find` or `read_page`. The shim pins the file
   input exactly in page script, stamps it, and uses `find` only to mint that reference — then reads
   the input's own `files` list afterwards and requires the exact prepared filenames in Fold order.
   A reference that resolved to some other element cannot pass as a successful upload. Whether
   `find` reliably mints a reference for a stamped hidden input on Depop's real form is unverified.
2. `file_upload` accepts only files the session already has access to, with a combined limit of
   10 MB. The host's `resolvePhotoFiles` must therefore materialize the prepared photo set inside a
   session-visible directory, not an arbitrary temporary path.

Fallback plan if either gap holds on the real form: read the prepared files in the host, pass their
bytes into the page as base64 through `javascript_tool`, rebuild them as `File` objects in a
`DataTransfer`, assign it to the pinned input, and dispatch `change`. That path needs no element
reference at all and keeps the same after-the-fact filename verification. It is deliberately not
built yet — building an unverified fallback against an unverified failure would add a second
unqualified path rather than remove one.

For an explicitly requested owner-supervised real run, use
`createAuthenticatedDepopTargetProfile()`. The current web flow opens `/products/create/`, invokes
only **Save as a draft**, resolves exactly one newly added UUID draft URL from the incomplete-drafts
table, reopens that draft, writes the exact Fold token to SKU, and invokes only **Update draft**.
It waits for each Depop form submission navigation to settle before opening another URL, preventing
the identity lookup from aborting an in-flight save.

For the loopback UI, create the matching profile with
`createDepopSimulatorTargetProfile({ origin })`; it contains the exact qualified field roles,
four-photo limit, and draft-route contract, so each task does not need to rebuild overrides.

The adapter locates controls by exact semantic role/name or label/role. It never uses screen
coordinates or a fuzzy match. It invokes only the exact configured `Add draft` and `Save draft`
actions. `Post`, `Publish`, `List`, `Make live`, and similar actions are never invoked; an ambiguous
save/live control fails closed.

## Research-derived mapping

- The exact Fold `reference_token` maps to Depop SKU without truncation or normalization.
- Depop's current single-item web form has no title input. Fold title, description, and hashtags
  are preserved as explicit segments in its Description field. Fold stores canonical hashtag values without presentation punctuation, so
  the adapter adds exactly one `#` prefix when formatting browser text; already-prefixed historical
  values remain compatible. Depop documents a maximum of five hashtags but no restricted character
  set, so relevant non-empty one-line Fold values are not rejected or rewritten.
- Price is formatted to two decimal places without changing its numeric value.
- Ordered Fold photos remain ordered and are never silently truncated.
- Category and other structured values are sent only when Fold supplies the seller fact. A finite
  Depop-owned alias map may translate an explicitly equivalent representation, such as Fold
  `Small` to Depop `S` or US `Gray` to Depop `Grey`; it never supplies a missing fact. There is no
  fallback category, brand, size, color, material, style, source, age, audience, or shipping value.
- Depop's category picker is audience-scoped: the same garment label appears under several audience
  headers (`MEN > COATS AND JACKETS` and `WOMEN > COATS AND JACKETS` both offer Jackets), so exact
  role-and-name matching alone cannot pick one. The authenticated profile reads the audience from a
  short literal allowlist of prefixes seen in real Fold categories, then requires exactly one option
  carrying that exact label under that exact audience group. Only `MEN` and `WOMEN` are recognized,
  because only those two groups have been observed live; an unrecognized or absent prefix leaves
  Category unset rather than guessing an audience.
- Fold's category is free-text model output — its prompt asks only for a "platform-appropriate
  category" and constrains neither vocabulary nor shape — so the prefix match is anchored to the
  beginning and limited to a literal allowlist, never inferred from listing content. Both
  `Menswear > Jackets` and separatorless `Womens Sweatshirts & Hoodies` retain an explicit
  audience. Compound values such as "Jackets & Coats" contribute each half as an additional exact
  candidate; a compound that resolves to two real Depop options is handed back as a choice rather
  than settled by taking whichever was searched first. See **Bounded AI category inference** below.
- Size and Material stay locked on Depop's form until Category holds a value, so when the category
  cannot be resolved they are omitted from the prepared draft rather than written to a disabled
  control. An unresolvable category therefore costs Category, Size, and Material together.
- Package size is read, never written. Depop auto-suggests one once Category is set and the adapter
  only confirms a suggestion arrived. Fold has no package-size data, and a wrong one costs the
  seller real money on a shipping label.
- Brand, size, and color are required. Depop refuses a "Ready to post" listing without them, so a
  candidate missing any of the three is rejected before browser use, exactly as a missing
  `reference_token` is. Fold returns `null` when the seller supplied no value; that is a real
  absence and is never filled in.
- Color must be one of the nineteen options confirmed live on 2026-08-23, and the control accepts at
  most two distinct selections. Size must belong to the set its category actually offers: three
  category families were researched (apparel for tops, bottoms, and outerwear; footwear; dresses).
  A category outside those families leaves size unvalidated rather than checked against a
  vocabulary that may not be its own.
- Target taxonomy values match exactly after the finite alias map is applied. Case-folding,
  nearest-match resolution, or mapping a non-equivalent value remains a guess about seller intent,
  and is refused. Canonical and normalized values therefore share the same exact browser-selection
  and persisted-verification gates.
- Quantity is always one. Fold's domain is one physical garment per listing, so the prepared draft
  carries the literal and never reads a quantity from Fold.
- Only evidence-backed condition mappings are accepted.

The authenticated web form observed on 2026-08-19 accepts up to eight JPEG/PNG photos, exposes a
stable UUID edit URL, embeds hashtags in Description, and exposes SKU after the first draft save.
Taxonomy details and account-dependent shipping remain qualified only for values observed in a
specific supervised run.

## Bounded AI category inference

When a Fold category has no byte-exact result but the picker offers semantic suggestions, or when it
resolves to more than one real Depop option under its own audience, the adapter does not choose and
does not give up. `saveDraft` returns `inference_required` carrying a bounded set of candidate labels
and groups enumerated from the live picker, having created no draft.

The shared workflow calls a host-supplied AI resolver with only the approved title, description,
source category, explicit audience, and those candidates. The resolver returns an exact label,
medium/high confidence, a concise reason, and one to three exact excerpts from approved content.
The adapter then resolves the one-time challenge or throws. Four properties make this safe:

- **The candidates are the adapter's, not the caller's.** They are read from the save result the
  adapter itself produced, and every one was enumerated from the live Depop picker. A term Fold
  supplied that Depop does not offer never appears as a candidate.
- **The answer is re-validated exactly.** It must equal one offered label exactly, under this
  listing's own audience, for this listing's own id. An invented label, a case variation, a trimmed
  variation, or an answer belonging to another listing is refused and the draft stays unresolved.
- **The rationale is bounded to approved evidence.** Low confidence is refused, and every evidence
  excerpt must occur byte-for-byte in the Fold-approved title or description. Photos, outside
  knowledge, signed URLs, and the full reference token never enter the inference request.
- **The challenge is authentic and single-use.** Adapter-instance object identity binds the actual
  pre-write result to its prepared draft. Fabricated, cloned, stale, or replayed challenges fail.
- **The write is gated independently.** Even after a choice is accepted, the browser re-enumerates
  the picker and requires exactly one option carrying that exact label under that exact audience
  group before it clicks. A choice that no longer matches the live form fails closed.

So AI chooses *which real option*, never *what text is written*. `prepareDraft`'s signature
covers the audience and terms but not the choice, so the caller's answer survives the retry while a
changed Fold category is still caught as content drift.

The authenticated capability keeps that pre-write challenge on the same untouched create form.
After one trusted decision it revalidates the exact offered option and continues with the cached
pre-save identity snapshot, instead of reopening Depop and repeating the transaction. Model wait is
reported separately from browser-driver timing. A listing mismatch or changed form URL discards the
continuation and starts a fresh pre-write path; an untrusted decision or second use fails closed.

The skill instructs the calling agent to decide only from the listing's own Fold-approved title and
description, never from the photos or outside knowledge, and to stop rather than guess when that
content does not clearly favour one candidate.

## Target safety

Simulator profiles accept loopback HTTP origins only. A real target must be exactly
`https://www.depop.com`, is created through `createAuthenticatedDepopTargetProfile()`, and must
remain disabled in automated tests. The profile is never inferred from an open tab.

An observed generic drafts-hub URL is never accepted as draft identity. Success requires a stable
per-draft URL or external identity, followed by persisted-state verification. Missing, changed,
ambiguous, or live state fails closed and is never automatically retried. Safe `failure_code`
values identify the exact failed gate without including photo URLs or the Fold reference token.
Authenticated browser failures preserve a safe stage-specific code such as
`browser_submit_initial_draft_failed` instead of collapsing every failure into one ambiguous gate.

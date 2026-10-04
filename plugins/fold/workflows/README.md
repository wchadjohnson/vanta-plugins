# Shared workflows

`lifecycle.mjs` is the dependency-injected reference implementation for lifecycle ordering. It
does not import Fold, Gmail, or browser code. The installed skill performs the same sequence with
host-provided tools, while tests inject fakes to prove that write calls cannot cross safety gates.
`publication.mjs` selects the requested internal adapter and hands it to that lifecycle; adapter
code never owns a Fold MCP call.

The shared workflow owns:

- calling `list_ready_listings` exactly once immediately before batch planning;
- preserving returned order while rejecting invalid candidates before browser invocation;
- treating creation of a private draft as the authorized operation once the user requests the run;
- exposing `saveAndVerifyDraft({ adapter, listing })` as the private-draft browser transaction
  so skill-driven runs cannot omit the listing half of the adapter's integrity envelope;
- processing drafts sequentially with no automatic retry;
- requiring unambiguous draft-save success, a stable URL, and adapter verification before each
  `mark_published` call;
- stopping on failure or ambiguity and reporting verified, failed, rejected, and untouched items;
- requiring exactly one email containing the exact Fold token before `mark_sold`; and
- treating `already_sold` as an idempotent no-op.

`draft-batch.mjs` is the batch for a marketplace with no bulk path (Vinted): one draft transaction
per host call, a per-listing outcome, and a persisted report that prevents duplicates. Like the
Depop bulk path it returns what to record (`to_record`) and leaves `mark_published` to the host's
Fold connector. `photo-files.mjs` is the ready-made photo resolver browser capabilities need.

`post-drafts.mjs` holds the phases the skill runs to post drafts: `depopPrepare`, `depopUpload`,
`vintedDraft` and `summarizeResults` (plus `codexBrowser`, which builds Codex provider options inside
the calling `js` call). They wire the provider capability, profile, adapter and the two workflows
above. No phase calls Fold or waits for a Fold answer, and each finishes its browser work inside the
one call that runs it — the Codex app loses browser access for any async work that outlives its
`js` call. Fold results reach a phase as files the agent writes from `exec`; a phase that needs
Fold calls returns them in order (`fold_calls`, also written to `fold_calls_path`) with a fresh
`results_path` for the answers, and `summarizeResults` folds those answers into the final
`fold-post-drafts/2` report. For Depop the page is proven usable before `export_depop_csv` (Fold
leases what it exports), `report_csv_upload` is named exactly once, the upload attempt is persisted
before delivery so it is never repeated, and rows an earlier run delivered are reconciled. It is the
only module here that writes files (state, the CSV and the Vinted report, in private OS temp
folders); `bulk-listing.mjs` stays I/O-free.

Adapters retain resale-platform selectors, form mappings, API assertions, and sender rules. The
Depop adapter is draft-only and must never target Post, Publish, List, Make live, or equivalent
controls. A later public-post action remains outside this workflow and requires its own explicit
user action in Depop. Durable retry and pending-delisting state remain out of scope.

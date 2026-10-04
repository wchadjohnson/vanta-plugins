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

Adapters retain resale-platform selectors, form mappings, API assertions, and sender rules. The
Depop adapter is draft-only and must never target Post, Publish, List, Make live, or equivalent
controls. A later public-post action remains outside this workflow and requires its own explicit
user action in Depop. Durable retry and pending-delisting state remain out of scope.

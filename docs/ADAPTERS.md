# Optional adapters

HandoffCheck's deterministic core works without any adapter. Adapters exchange small JSON files with sibling tools; they are **disabled by default**, use **local files only**, and never open a network connection. Nothing here is a runtime dependency of any other product.

| Direction | Style | Command |
| --- | --- | --- |
| Export | RunProof-style receipt | `handoffcheck adapter export-receipt` |
| Import | ProofGate-style acceptance | `handoffcheck adapter import-acceptance` |

## Enabling

Adapters stay off unless you opt in on each invocation with `--enable-adapters` or set `HANDOFFCHECK_ADAPTERS=1` in the environment. Without that, both commands exit 2 with the JSON error code `CONNECTOR_DISCONNECTED`; no file is read or written.

Adapter state (the dedupe ledger) lives in `<store>/adapters/ledger.json`, created owner-only (directory 0700, file 0600) and replaced atomically.

## Envelope (schema version 1)

```json
{
  "schema_version": 1,
  "event_id": "handoffcheck-cf357c739d2a0d43594b01fa7aa32169",
  "source": "handoffcheck",
  "resource_id": "<run id>",
  "event_type": "receipt.exported",
  "occurred_at": "2026-01-01T00:00:00Z",
  "revision": 3,
  "evidence_ref": "sha256:<64 hex>",
  "correlation_id": "<optional id this event answers>"
}
```

| Field | Rule |
| --- | --- |
| `schema_version` | Integer `1`. Any other integer is rejected with `UNSUPPORTED_VERSION`; a non-integer with `SCHEMA_INVALID`. |
| `event_id` | 1-128 characters from `A-Z a-z 0-9 . _ : @ -`, starting alphanumeric. Globally unique per event; consumers deduplicate on it. |
| `source` | Lower-case tool name (`handoffcheck`, `proofgate`, ...). |
| `resource_id` | The run id this event is about. |
| `event_type` | Lower-case name matching `^[a-z][a-z0-9_.]{0,63}$`. Exports use `receipt.exported`; imports accept `acceptance.accepted`, `acceptance.rejected`, `acceptance.unknown`, `acceptance.partial`, `acceptance.stale`. |
| `occurred_at` | UTC timestamp ending in `Z`. |
| `revision` | Non-negative integer that only grows per `source` + `resource_id`. |
| `evidence_ref` | `sha256:<64 hex>` or `file:<relative path>`. URLs, absolute paths, `..` segments and backslashes are rejected with `POLICY_REJECTED`. At most 512 characters. It is data: it is never fetched over a network and never executed. |
| `correlation_id` | Optional. An acceptance uses it to name the receipt `event_id` it answers. |

The envelope schema is closed (`schemas/adapter-envelope.schema.json`): unknown fields are rejected with `SCHEMA_INVALID`. A file holds at most 1,000 envelopes.

## Receipt export

```text
handoffcheck adapter export-receipt --run <id> --out receipts/ --enable-adapters [--output evidence/]
```

Writes two files into `--out` (created owner-only):

- `<sha256>.json`: the redacted JSON report (content-addressed by its own hash).
- `receipt-<run>-r<revision>.envelope.json`: the envelope whose `evidence_ref` is `sha256:<that hash>`.

The `event_id` is derived from `source`, `resource_id`, `event_type`, `revision` and a random per-store nonce, so exporting the same revision twice from the same store produces the same envelope (consumers dedupe it) and a changed run produces a new revision. The receipt always carries the run's effective verdict; for an imported run that is `UNKNOWN`, and the bundle's own claimed verdict is removed from the exported report. Redaction runs before anything is written; planted secrets never appear in exported files. The export works with no network connectivity.

## Acceptance import

```text
handoffcheck adapter import-acceptance --file acceptance.json --enable-adapters [--output evidence/]
```

`acceptance.json` holds one envelope or an array of envelopes (delivery is at least once). Evidence is verified against the digest stored in the local ledger at export time (see below); no sender-supplied file is read.

Each envelope gets exactly one disposition:

| Status | Meaning |
| --- | --- |
| `applied` | Newer revision of its stream; the acceptance record for the run was updated. |
| `duplicate` | Same `event_id` and same bytes as before; nothing changes. |
| `stale` | `revision` is not newer than the applied revision of the same `source` + `resource_id`. Recorded as seen, state unchanged. An old event never rewinds state. |
| `rejected` | Malformed, unsupported version, unsafe `evidence_ref`, or the same `event_id` with different bytes (`CONFLICT`). |

Ordering and revision are preserved: only a strictly newer revision of a stream can change state.

### Uncertainty never becomes acceptance

A sender's `acceptance.accepted` is honoured only when **all** of these hold. Otherwise it is downgraded and the reason is recorded:

1. a receipt for the run was exported on this installation, and `correlation_id` equals the `event_id` of the newest exported receipt (otherwise `unknown` if none was exported, `stale` if it names another receipt);
2. `evidence_ref` is a `sha256:` pin equal to the digest of the report this installation exported for that receipt, which the ledger stores at export time. A `file:` reference is not hash-pinned, so it never verifies anything (`unknown`); a different digest is `unknown`. The importer does not read or trust files supplied by the sender;
3. the run has not changed since the receipt was exported (otherwise `stale`: export a new receipt); and
4. **the run's own current verdict, read from the evidence store, is accepting** (`INDEPENDENT_PASS`). An accepted claim on a `FAIL`, `ASSISTED`, `REHEARSAL`, `UNKNOWN` or imported run is never recorded as accepted (`unknown`, with the run's verdict in the reason), whatever the sender says. If the run cannot be read the claim is `unknown`.

Receipt event ids mix a random per-store nonce (kept in the ledger), so a third party cannot compute the `correlation_id` of a receipt it has not seen. `rejected`, `unknown`, `partial` and `stale` claims are kept as reported. Only `accepted` is a pass, and an imported acceptance is shown in the report as a notice: it never changes the drill verdict, exit code or cleanup status.

Ledger lookups use null-prototype maps, so ids such as `constructor` or `toString` are ordinary keys.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Receipt written, or every envelope was `applied`/`duplicate`/`stale` |
| 1 | At least one envelope was `rejected` |
| 2 | Adapters disabled, unreadable input, harness failure |

Errors use the shape `{"error":{"code","message","request_id"}}` in `--json` mode, with the domain error codes: `CONNECTOR_DISCONNECTED` (adapters disabled), `SCHEMA_INVALID`, `UNSUPPORTED_VERSION`, `PAYLOAD_TOO_LARGE`, `CONFLICT`, `POLICY_REJECTED`, `BAD_REQUEST`, `INTERNAL`.

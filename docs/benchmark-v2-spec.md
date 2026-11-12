# Benchmark v2 specification

## Purpose

Benchmark v2 separates financial correctness from capacity testing while using
one versioned data model and generator. The benchmark is synthetic; it does not
copy ERPNext business records or measure ERPNext response times.

## Lanes

### Financial accuracy

The accuracy lane exercises application lifecycle rules and exact accounting
relationships. It covers invoice calculations, taxes and discounts, payments,
receipt allocations, journals, cancellations, reversals, stock valuation,
control-account parties and financial reports.

Detailed golden checks use a deterministic fixture. Aggregate reconciliation
also runs against the stress fixture, so financial accuracy is not limited to a
toy database.

### Stress

The stress lane measures authenticated HTTP capacity and resource behavior. Its
pre-traffic targets are approximate:

| Record | Target | Allowed range |
| --- | ---: | ---: |
| Sales invoice headers | 1,000,000 | 980,000–1,020,000 |
| Invoice-item rows | 10,000,000 | 9,900,000–10,100,000 |
| Average items per invoice | 10 | 9.8–10.2 |
| GL rows | 7,500,000 | 7,350,000–7,650,000 |
| Stock-ledger rows | 11,900,000 | 11,662,000–12,138,000 |

Every generated invoice has at least three items. Invoice lengths use a
deterministic negative-binomial distribution so individual invoices vary and
long invoices are represented. The aggregate target is approximately ten items
per invoice; all invoices are not assigned exactly ten items.

GL and stock-ledger targets must be reached through valid voucher lifecycles.
Detached, duplicated or padding rows do not satisfy the benchmark.

The stress workload runs distinct authenticated users at 1, 10, 25 and 50
concurrent users. Each stage includes warmup, sustained mixed work and a shared-
stock burst. The workload covers browsing, searches, details, invoice drafts and
submissions, receipts, journals, purchases, orders, transfers, reports and CSV,
Excel and PDF exports.

## Source profile

The current source snapshot is used for aggregate distributions and relationships:

| Record | Current ERPNext source |
| --- | ---: |
| Sales invoices | 237,826 |
| Sales invoice items | 2,218,068 |
| GL entries | 1,925,598 |
| Stock ledger entries | 2,850,064 |

The source has about 9.33 invoice items per invoice. The benchmark target exceeds
that source volume to provide several years of capacity headroom.

## Generation rules

- Profiles are versioned and deterministic from a recorded seed.
- The same profile and seed produce the same logical fixture.
- Invoice length is selected from a versioned distribution, not from a fixed
  formula and not by assigning every invoice ten lines.
- Dates, status, customer, item, warehouse, ownership, payment and cancellation
  data are correlated.
- Seeding is resumable through durable checkpoints.
- Existing run directories, images, containers and results are never overwritten.
- Benchmark containers receive no application `.env`, ERPNext connection or
  unrelated credentials.

## Acceptance gates

Before traffic, both lanes must pass:

- Exact invoice, journal, payment and stock source-line totals.
- Balanced GL entries and valid control-account parties.
- Invoice, receipt and cancellation reconciliation.
- Stock ledger, stock balance, valuation and inventory-GL reconciliation.
- No duplicate, orphan or future-dated benchmark documents.
- Target row ranges, minimum invoice length, average invoice length and realistic
  length variation.
- Deterministic regeneration from the same profile and seed.

The accuracy lane must additionally pass exact financial golden values. The
stress lane must:

- Complete all four concurrency stages without unexpected errors.
- Show only documented bounded backpressure under overload.
- Avoid crashes, OOM kills, duplicate postings and either pre- or post-run ledger
  corruption.
- Record latency, throughput, queue waits, database size and resource use.

Production latency SLOs are selected from the measured calibration rather than
being inferred from dataset size.

## Storage and execution

A pilot must measure database, index and WAL growth and project the full fixture
with backup space and a reserve. Full generation is refused if the projected
footprint does not fit. The current host is small, so full seeding is expected to
run detached for several hours and must be monitored without blocking on an AI
session.

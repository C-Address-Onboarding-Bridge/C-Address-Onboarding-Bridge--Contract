# ADR-004: Atomic batch processing

## Status

Accepted

## Context

Batch funding can either process targets independently and allow partial success, or treat the full batch as one atomic operation. Partial success can increase throughput for imperfect inputs, but it complicates reconciliation for wallets, exchanges, and support teams.

## Decision

Batch funding is treated as an atomic operation. The caller submits aligned target and amount arrays. If validation or transfer execution fails, the batch should fail as a whole instead of silently funding only part of the request.

## Consequences

Atomic behavior gives integrators a clear success or failure result and simplifies accounting. Callers should pre-validate batch size, target addresses, amounts, and asset support before submission. A future partial-processing mode should be a separate method or versioned behavior with explicit result reporting.

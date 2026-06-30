# ADR-005: Error Handling — Panic vs. Result Pattern

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Soroban contracts can signal errors in two ways:

1. **Panic** (`panic!` / `.unwrap()` / `.expect()`): aborts execution immediately; the host produces a generic `WasmVm` error code. Callers cannot distinguish error types.
2. **`#[contracterror]` enum + `Result<T, E>`**: returns a typed integer error code that Soroban encodes in the transaction's `sc_error` field. Clients can match on the integer code.

## Decision

Use **`Result<T, BridgeError>`** for every fallible public function:

- `BridgeError` is annotated with `#[contracterror]`, mapping each variant to a stable integer (1–36+).
- Internal helpers (e.g. `check_initialized`, `calculate_fee`) also return `Result` and are propagated with `?`.
- The only place `panic` is acceptable is in truly unrecoverable invariant violations (e.g. storage deserialization of a known-good type) that indicate a contract bug, not a user error.
- `safe_math` module wraps `checked_add/sub/mul/div` returning `Err(BridgeError::Overflow)` instead of panicking.

Error codes are **stable** — existing codes must never be reassigned. New errors are appended at the end of the enum.

## Consequences

**Positive:**
- Clients (SDK, indexers) can distinguish and handle specific errors programmatically.
- Typed errors make the ABI self-documenting.
- `?` propagation keeps function bodies clean.
- Overflow is handled gracefully rather than aborting with a confusing panic.

**Negative:**
- Every new failure mode requires adding an enum variant and updating documentation.
- Integer error codes are stable, so removing a variant would leave a gap. Convention: deprecated variants are kept in the enum but their comments note they are unused.

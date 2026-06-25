# ADR-005: Error handling model

## Status

Accepted

## Context

Soroban contracts can signal failures through contract errors or panics. The bridge needs failures that are understandable to SDKs and integrators, especially for validation errors such as invalid fees, unauthorized callers, and mismatched batch inputs.

## Decision

The contract should prefer explicit validation and stable error cases for expected failures. Panics should be reserved for impossible states or defensive checks that indicate a programming error. SDKs should surface transaction results without hiding the underlying failure status.

## Consequences

Explicit errors make integration testing and user-facing diagnostics more reliable. The contract API must keep error semantics stable across compatible releases. When new validation cases are added, documentation and SDK examples should explain the likely cause and recovery path.

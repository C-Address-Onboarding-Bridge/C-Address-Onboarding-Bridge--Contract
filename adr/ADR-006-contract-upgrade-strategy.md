# ADR-006: Contract upgrade strategy

## Status

Accepted

## Context

The bridge handles asset routing and fee collection, so upgrade strategy affects user trust and operational risk. Fully mutable contracts can be convenient, while immutable deployments are easier to reason about but require migration when behavior changes.

## Decision

The initial strategy is versioned deployment with documented migration. Backward-compatible documentation, SDK changes, and release notes should accompany each version. Breaking contract changes should be deployed as a new contract version with an explicit migration plan rather than being hidden behind an opaque upgrade.

## Consequences

Versioned deployment keeps the operational model transparent and makes audits easier. Integrators need to track contract IDs per environment. Future proxy or upgrade mechanisms should be introduced only with clear admin controls, migration documentation, and security review.

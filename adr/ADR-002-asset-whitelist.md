# ADR-002: Asset Whitelist vs. Open Asset Model

**Status:** Accepted  
**Date:** 2024-01-15

## Context

The bridge contract can either accept any SEP-41 token (open model) or restrict transfers to an admin-approved list of tokens (whitelist model).

An open model is maximally permissive but exposes the contract to:
- Scam / rug-pull tokens being routed through the bridge.
- Fee accounting becoming complex across unbounded token sets.
- Regulatory exposure if prohibited tokens are facilitated.

## Decision

Use an **asset whitelist** model:

- Admin adds tokens via `add_asset(asset: Address)`, stored in `DataKey::Whitelist` as a `Map<Address, bool>`.
- `check_asset_whitelisted` is called in every transfer entry-point; reverts with `AssetNotWhitelisted` if the token is absent.
- Admin removes tokens via `remove_asset(asset: Address)`.
- `query_whitelisted_assets` returns the full list as `Vec<Address>`.
- The swap entry-point (`fund_c_address_with_swap`) whitelists only the **output** asset — the source asset is unrestricted since it never arrives at the target.

## Consequences

**Positive:**
- Prevents routing of unsupported or malicious tokens.
- Keeps fee accounting bounded to known assets.
- Simplifies auditing — operators know exactly which tokens the contract handles.

**Negative:**
- Requires admin action to add new tokens, introducing operational overhead.
- A bug in `add_asset` / `remove_asset` could block legitimate tokens.
- Whitelist is on-chain; growing it increases ledger storage costs (mitigated by Soroban's per-entry TTL).

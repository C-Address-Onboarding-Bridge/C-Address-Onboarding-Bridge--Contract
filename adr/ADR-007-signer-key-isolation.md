# ADR-007: Per-Signer Key Isolation for the Relayer

**Status:** Accepted (partial — see "Remaining follow-up")
**Date:** 2026-09-28

## Context

`RelayerServiceConfig.nodes` previously held every relayer's private key,
loaded from one `RELAYER_PRIVATE_KEYS` env var into one process, and
`handleEvent` signed with all of them in that same process. The on-chain
contract enforces an M-of-N signature threshold specifically so that no
single compromised party can authorize a payout. But if one process holds
every key, compromising that process yields every key — the M-of-N threshold
degrades to 1-of-1 in practice, even though it looks like M-of-N on paper.

## Decision

Split key custody from the relayer process:

- `RelayerNodeConfig` is now a union: `{ signerUrl: string }` or
  `{ privateKey: string }`.
- For `signerUrl` nodes, the main relayer process never receives that key's
  material. It POSTs the payload hash to `${signerUrl}/sign` and receives
  back `{ pubkey, signature }`. See `requestRemoteSignature` and
  `signWithNode` in `relayer/index.ts`.
- `relayer/signer-service.ts` is a small, independent HTTP service that holds
  exactly **one** relayer's key (from its own `SIGNER_PRIVATE_KEY` env var)
  and exposes only `POST /sign`. Each signing operator runs their own
  instance, on infrastructure they control, and gives the main relayer their
  service's URL (`RELAYER_SIGNER_URLS`, comma-separated, in the same order as
  the on-chain relayer registration).
- `{ privateKey }` nodes remain supported for local development only. The
  `RelayerService` constructor logs a loud warning whenever more than one
  in-process key is configured, since that's exactly the setup this ADR
  exists to move away from.

### Trust model

| Component | Holds | Compromise blast radius |
|---|---|---|
| Main relayer process | Submitter's Stellar secret key, event-listener state, no relayer signing keys (in the `signerUrl` configuration) | Can watch chains and *request* signatures, but cannot forge one alone; still needs `threshold` independent signer services to cooperate |
| Each signer service | Exactly one relayer's Ed25519 seed | Yields at most 1 of N signatures — matches the threshold's intended guarantee |

This is deliberately analogous to `ADR-003`'s role separation: splitting one
powerful actor into narrowly-scoped ones so a single compromise doesn't grant
everything.

## Remaining follow-up (explicitly out of scope for this change)

This PR gets the signing key out of the relayer's process and gives each
operator an independently deployable service, but it does **not** deliver
full production-grade isolation. Left for later work:

- **Transport security.** `signer-service.ts` speaks plain HTTP with no
  authentication. It must be placed behind mTLS or a private network
  (VPN/allow-listed security group) before being exposed to anything other
  than a trusted operator's own infrastructure.
- **Signer-side threshold-request validation.** The signer currently signs
  whatever payload hash it's asked to sign. A production signer should
  independently re-derive the payload hash from the raw event (chain id, tx
  hash, target, asset, amount) and refuse to sign hashes it can't recompute
  and verify are for a known, whitelisted asset/target — so a compromised
  relayer process can't get a signer to blindly sign an attacker-chosen hash.
- **True process/host isolation enforcement.** Nothing today prevents an
  operator from running all N signer services on one host — this ADR gives
  the *mechanism* for isolation, not a guarantee that operators use it.
  Operational runbooks / deployment docs for actually distributing signer
  services across independent operators are a follow-up.
- **Secret management integration.** `SIGNER_PRIVATE_KEY` is a plain env var
  today; integrating with a secrets manager / HSM per operator is future
  work.
- **Submitter-side signature collection protocol.** The relayer currently
  calls each signer synchronously and in parallel; a more robust design
  (per the original issue's suggestion) would have the *submitter* collect
  signatures via a shared queue so signers don't need to be reachable
  synchronously from every relayer replica.

## Consequences

**Positive:**
- Compromising the main relayer process no longer yields any relayer
  signing key when signers are run via `signerUrl`.
- Each signer's blast radius is exactly its own key, matching what the
  on-chain threshold is meant to guarantee.
- `privateKey` nodes still work, so this is an additive, non-breaking change.

**Negative:**
- More moving parts to operate (N signer services instead of one process).
- The relayer now depends on network reachability to every configured
  signer at event time; a signer being down blocks that node's signature
  (already true for `threshold` today, now also true for availability of
  each remote signer).
- The trust model is meaningfully improved but not complete — see
  "Remaining follow-up" above.

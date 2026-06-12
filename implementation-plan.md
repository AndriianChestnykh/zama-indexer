# Confidential Indexer — Implementation Plan

How I implement the ERC-7984 confidential indexer described in `indexer-spec.md` and
`original-letter.md`, grounded in what already exists in this repo.

## Scope & architecture

One TypeScript Node project. A **single Ponder process** does both jobs: it indexes the
chain (poll → decode → indexing function → decrypt → Postgres) and serves the read API
(Hono). Storage is Postgres (`docker-compose.yml`, `make db-up`). Decryption uses the Zama
high-level SDK (`@zama-fhe/sdk@3.0.1`), wired in exactly as `populate/src/sdk.ts` does it.

```
Anvil / forge-fhevm (cleartext fhEVM, chainId 31337)
        │  logs
        ▼
Ponder  ──poll──▶ decode ──▶ indexing fn ──▶ decrypt (Zama SDK) ──▶ Postgres
        │                                                              │
        └────────────────────── Hono read API ◀───────────────────────┘
                                       │
                                wallet partner (cleartext view)
```

### Key decision: don't hand-roll the sync workers

`indexer-spec.md` frames three background workers — *historical sync*, *real-time sync*,
*decryption*. **Ponder already unifies the first two.** One process backfills from
`startBlock` and then live-polls (`pollingInterval`, see `ponder.config.ts`) through the
*same* indexing functions, and tracks the last-synced block itself. So I do not write
separate historical/realtime workers — that would be re-implementing Ponder.

The genuinely custom work is **decryption**, and I fold it *into the indexing functions*
rather than running a detached worker, because Ponder 0.16 is the sole writer of its
`onchainTable`s (external mutation mid-sync is unsupported). The brief's tricky requirement
— *ACL grants that arrive later must backfill cleartext* — fits this model cleanly: the ACL
grant is itself an indexed event, so its handler does the backfill.

This is the first place I push back on the brief's structure; the rest of the worker
*logic* (classification, handle updates, balance staleness) is preserved, just relocated.

## Events indexed

Confirmed against `indexer/abis/ConfidentialUsdAbi.ts`:

| Event | Args | Role |
|---|---|---|
| `ConfidentialTransfer` | `from` (indexed), `to` (indexed), `amount` euint64 handle (indexed) | **shield** (`from == 0x0`), **internal transfer** (both set), **unshield-leg** (`to == 0x0`) |
| `UnwrapRequested` | `receiver`, `unwrapRequestId`, `amount` handle | opens an unshield |
| `UnwrapFinalized` | `receiver`, `unwrapRequestId`, `encryptedAmount` handle, **`cleartextAmount` uint64** | closes an unshield — cleartext for free |
| `DelegatedForUserDecryption` (ACL) | delegator, delegate, contract, expiry | grant → triggers backfill |
| `AmountDisclosed` | `encryptedAmount` handle, `amount` uint64 | second free-cleartext source |
| `OperatorSet`, `AmountDiscloseRequested` | — | recorded for completeness |

`amount` is an indexed `bytes32` handle, decode-able directly from the log topic.

## Database schema (`ponder.schema.ts`, replacing the placeholder)

Mapping `indexer-spec.md`'s tables onto Ponder `onchainTable`s:

- **`fheHandle`** — `handle` (bytes32) PK, `contract`, `cleartext` (bigint, nullable),
  `status` (`pending | decrypted | unauthorized | disclosed`), `lastTriedBlock`. The
  **single source of truth for every handle's cleartext** — both transfer-amount handles
  *and* balance handles live here (the spec's "amount handles table linked to transactions
  *and* balances"). Cleartext is stored in exactly one place so the ACL-grant backfill
  (`unauthorized → decrypted`) patches one row and every reader sees it; nothing caches a
  second copy. (Named `fheHandle` rather than `amountHandle` precisely because it also holds
  balance handles.)
- **`transaction`** — `id` (`txHash-logIndex`, or `unwrapRequestId` for unshields), `type`
  (`shield | transfer | unshield`), `from`, `to`, `amountHandle` (→ `fheHandle`), `state`
  for unshields (`requested | finalized`), `unwrapRequestId`, `blockNumber`, `txHash`,
  `logIndex`, `timestamp`.
- **`balance`** — `address` PK, `handle` (→ `fheHandle`, the current on-chain balance
  handle), `blockNumber`, `updatedAt`. **No `cleartext` column** — the value is read through
  the `fheHandle` link, same as `transaction`. The API reports a balance as encrypted/unknown
  when the linked handle's `status` is not `decrypted | disclosed`.
- **Raw event tables** — `confidentialTransfer`, `unwrapRequested`, `unwrapFinalized`,
  `aclGrant` — append-only audit rows keyed `txHash-logIndex` (the spec's per-event tables).

## Indexing-function logic (`src/index.ts`) — event → state mapping

- **`ConfidentialTransfer`**: insert raw row; upsert the transfer amount into `fheHandle`; classify by
  zero-address into shield / transfer / unshield-leg; insert or patch `transaction`; mark
  `from`/`to` balances stale (handle refresh, below); **attempt decrypt**.
- **`UnwrapRequested`**: upsert the unshield `transaction` to `state = requested`, keyed by
  `unwrapRequestId`; record handle; attempt decrypt. This is the **in-between state** (spec
  Note3): balance is already debited in ERC-7984 but mUSD not yet delivered — represented by
  `state = requested` and surfaced at the API layer.
- **`UnwrapFinalized`**: patch the unshield `transaction` to `state = finalized`; write
  `cleartextAmount` straight into the `fheHandle` row (`status = disclosed`) — no SDK
  call needed.
- **`DelegatedForUserDecryption`**: record the grant; **backfill** — query `fheHandle`
  rows with `status in (pending, unauthorized)` now reachable by the delegator and
  re-decrypt.
- **`AmountDisclosed`**: fill cleartext from the event.

## Decryption module (`src/decryptor.ts`) — the custom core

- Build one holder-signed `ZamaSDK` at startup from `HOLDER_PRIVATE_KEY` (mirroring
  `populate/src/sdk.ts`: `RelayerCleartext` + `hardhatCleartextConfig` + `EthersSigner`,
  with persistent storage so the EIP-712 keypair/signature is generated once and cached).
- `decrypt(handle) → bigint | UNAUTHORIZED`: call
  `sdk.userDecrypt({ handles, contractAddress, signedContractAddresses, privateKey,
  publicKey, signature })`.
- **Eligibility is discovered, not assumed.** A `DecryptionFailedError` (a confirmed SDK
  export) means "holder not entitled" → set `status = unauthorized` — **not dropped**,
  satisfying the brief's "events the holder is not entitled to decrypt must not be silently
  dropped." Success → `status = decrypted`. The holder is entitled when a party to the
  transfer (`from`/`to`/`receiver == HOLDER_ADDRESS`) or via ACL delegation; I lean on the
  SDK's own authorization check rather than re-deriving ACL state client-side, and treat
  `unauthorized` as a retry-on-grant state.
- **Throttling**: bounded concurrency + retry/backoff around `userDecrypt`. On the local
  cleartext stack this reads plaintext from the FHEVMExecutor (fast), but the code path is
  written as if the relayer is remote and rate-limited — this is the piece I flag as
  least-confident under partner load (see Reflection).

## Balances

On any event touching an address, read the on-chain balance handle (`confidentialBalanceOf`
via `context.client.readContract`) at the event block. If the handle changed (stale), upsert
it into `fheHandle`, repoint `balance.handle`, and attempt decrypt (cleartext lands in the
`fheHandle` row, or stays `null`/`unauthorized`). Drop the old handle from `fheHandle` only
if unreferenced by **either** `transaction` or `balance` (a balance handle is frequently not
referenced by any transaction, so the GC check must cover both).

## Read API (`src/api/index.ts`, Hono)

- `GET /v1/addresses/:address/balance` →
  `{ address, balance: string|null, encrypted: bool, handle, blockNumber }`
  (`null` + `encrypted: true` when not decryptable).
- `GET /v1/addresses/:address/transactions?limit&cursor` → cursor-paginated list; each item
  `{ type, direction, from, to, amount: string|null, amountStatus, state?, txHash,
  blockNumber, timestamp }`. Unshields carry `state: "pending_finalization" | "finalized"`
  to make the in-between state explicit (spec Note3). Undecryptable amounts are
  `amount: null` + `amountStatus: "unauthorized"` — never dropped.
- `GET /v1/health` →
  `{ status, indexedBlock, chainTipBlock, blocksBehind, pendingDecryptions }`
  (the brief's "how healthy / how far behind"). Ponder's `/ready`, `/status`, `/metrics`
  stay available.
- Error taxonomy: `400` bad address, `404` unknown address, `503` while still backfilling;
  consistent `{ error: { code, message } }` body.

## Tests (light, per brief)

- **Happy path**: emit a holder-party `ConfidentialTransfer` → assert the API returns the
  correct cleartext amount and updated balance (event in → cleartext out).
- **One negative**: a transfer the holder is *not* party to and has *no* ACL grant for →
  assert it appears in history with `amount: null` / `amountStatus: "unauthorized"` and is
  **not** silently dropped; then emit the grant and assert backfill fills the cleartext.
  Chosen because "not silently dropped + later backfill" is the brief's sharpest requirement
  and this spec's riskiest seam.

## Reflection & SDK feedback (to be expanded in DECISIONS.md)

- **Least-confident piece**: inline `userDecrypt` inside indexing functions under partner
  load — it blocks indexing and is non-deterministic against a remote relayer. How I'd prove
  it: replay the event stream with induced relayer latency / 429s and watch `blocksBehind`
  grow. Likely next step: a decryption queue decoupled from the indexing critical path.
- **Cut / next 4 hours**: Sepolia (`RelayerNode`) path, richer pagination, per-grant
  authorization caching, metrics on decryption failure rates.
- **SDK feedback seeds** (observed while wiring): eligibility is only knowable by catching
  `DecryptionFailedError` rather than an `isAllowed(handle)` probe; the EIP-712
  keypair/signature ceremony is heavyweight for one-shot handle decryption; naming/doc gaps
  around choosing the cleartext vs node relayer.

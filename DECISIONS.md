# DECISIONS.md

## What I composed vs. wrote

- **Ponder** was chosen as the indexing library because it has event handlers, schema, build-in Postgres support, pagination, historical and realtime blockchain data polling.
- **Hono** web server. It is embedded into Ponder and conveniently exposes web APIs.
- **ERC7984ERC20Wrapper** was chosen as the confidential token implementation (seed the brief pushbacks below)

I wrote myself:
- Database schema and indexer: hand written myself in `indexer-impl-task.md` (no LLM help). Used as an LLM input to create `implmentation-plan.md`
- `Decryptor`: It centralizes the handles and ACL delegations processing logic and add caching layer to avoid re-processing the same events.
- `logic.ts`:  pure, side-effect-free helpers
- `populate script`: It is a TypeScript that I use to populate confidential token with some test data including confidential transactions.
- `grant script`: It is a TypeScript that I use to grant a ACL access from users to indexer holder. Useful for testing the backfill flow and demo.

## What I cut

- There is no retry scheduler for `pending` handles — they are only re-tried on the next `DelegatedForUserDecryption` event;
- Rate-limiting and authentication on the read API were cut. 
- Throttling on the Zama deryption API calls was cut.
- The `populate`, `grant` scenarious and Quick Start guide only tests the local fhEVM stack; there is no Sepolia support yet (though Sepolia is not mandatory in the brief but just an option)

## Where I'd push back on the brief

I used confidential token based on `ERC7984ERC20Wrapper` rather than `ERC7984` the former is a confidential layer on top of existing tokens, has shield and unshield transactions and may be more valuable for some integrators.

## Weakest point under partner load

- The lookup in `GET /v1/addresses/:address/transactions` has one extra `SELECT` per row per page (N+1) — would be the first thing to break under load; Loading 10K transactions and would probably prove it to be a bottleneck. I would fix it with some `JOIN` lookup in a plain SQL query or some baching via ORM.

## What I'd do first with four more hours

- Replace the N+1 handle lookup with a single JOIN in the transactions query.

- I would think about some cache strategy for the decryptor. In the current implementation if the process runs for a long time it may accumulate a lot of handles, which may lead to essential memory expansion. So some cache eviction policy would be nice.

- Index holder decryption rights can expire and be revoked. Need to think how to handle edge cases to provide the best API DX

- Implement some eviction strategy for chached handles. The current implementation may lead to unlimited memory expansion for tokens with big history.

- (may not fit 4 hours though, but at least start) Performance, stability, scalability: Test and think thoroughly through ACL:DelegatedForUserDecryption and ACL:RevokedDelegationForUserDecryption events handling. It is a potential bottleneck or unstable execution path.
A user can grant access to a holder for a token with essential history. Actually many users with massive token history can grant, revoke in parallel and those may have many edge cases apart from the bottlnecks.
There may be a reason to onboard some fault-tolerant scheduling and queue mechanism, decryptors horisontal scaling, etc. to process decryption handles at scale. Throttling on the Zama decryption API calls is another thing to consider not to hit Zama decryption API rate limits.

Note: there are moto do like rate-limiting, authentication, multi-token support, etc, but it will be out of 4 hours scope.

## AI assistance

I used Claude Code throughout: architecture design, scaffolding Ponder config and schema, writing the Decryptor class, and debugging the `balanceClient` issue, check the codebase alignment with the intital task description.

Errors introduced: 
- Identified during the `grant` script tests: it initially generated the balance refresh logic reading the balance handle at the **event's pinned block** (`context.client.readContract`) rather than the latest block, which caused the stored handle to be stale on the forge-fhevm stack (the executor assigns a new handle each time `confidentialBalanceOf` is called, so the historical read returns a handle that no longer maps to any live ACL entry and can never be decrypted). I caught this when querying the balance endpoint always returned `encrypted: true` even for the holder, then traced it to the handle mismatch and switched to a dedicated `balanceClient` that always reads at latest.
- The Claude Code introduced denormalisation to the DB schema: the cleartext was duplicated in `balance` or `transactions` tables along with the `fhe_handle` table
- Subtle thing: Claude used `dotenv` package instead of using Node.Js native API to read environment variables (yet to fix)

## Out-of-time / not completed

- No happy-path and negative path tests at the moment.
- No SDK feedback at the moment.

## Indexer and db requirements

Database should have
- ConfidentialTransfer events table
- UnwrapRequested events table
- UnwrapFinalized events table
- ACL grants table: tracking ACL grants for the indexer holder
- Transactions table: transfers of 3 types - shield, internal confidental transfer, unshield
  - Note: it is not for blockchain transactions, but for transfer of tokens between users and between ERC7984Wrapper and ERC20 contract
  - Note2: unwrapping and finalized state are at least two possible states for the unshield transaction
  - Note3: in between unwrapping and finalized state address balance is already reduced in the ERC7984 but not yet transferred to the ERC20. Should be depicted if not on the table but on the API level
- Balances table
- Amount handles table (linked to transactions and balances tables)


Historical events sync task:

Run mode: once when the indexer is started. Non-blocking for the web-server to be up and running for user requests or for other background tasks.
Purpose: syncs events and token state data between the db and the blockchain. The data comes with confidential hadles in place of amounts.
Logic notes:
- checks the last block up to which the db is in sync with the token state in blockchain
- reads and saves to db all the events (described above) that are missing since last sync. Updates the handles table as well.
- updates the transactions table: 
  - ConfidentialTransfer without "from" field is actually a shield transaction
  - ConfidentialTransfer with "from" and "to" fields is an internal confidential transfer
  - Unshield transaction gets updated from UnwrapRequested (also ConfidentialTransfer without "to" is fired in the same blockchain tx) and UnwrapFinalized events (unwrapping and finalized state)
- For each address identify if its balance handle is stale (or the record is missing for this address at all) and update it in the Balances table if so (drop old handle if not referenced by transactions table)


Real-time events sync task:

Run mode: starts when the indexer is started, runs all the time
Purpose: updates transactions and balances tables with real time events
Logic notes
- subscribe to real-time token ConfidentialTransfer, UnwrapRequested, UnwrapFinalized events (or new events polling as alternative)
- infer the transactions, balances and handle update logic from the historical events sync worker


Decryption task:

Run mode: starts when the indexer is started, runs all the time
Purpose:
- get ACL grant events relevant to the indexer holder
- identifies all the handles that can be decrypted when indexer is part of a transfer or granted decryption via ACL
- decrypts the handles


Endpoints:
Note: figure out the shape of the endpoints
Endpoints:
- Addresses balances:
- Address transactions:



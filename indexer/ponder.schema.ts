// Database schema for the indexer.
//
// Item 2 is scaffold-only, so this is a deliberate placeholder: a single tiny table that lets
// Ponder build and migrate PGLite. The real balance + transaction tables (with decrypted amounts,
// ACL-delegated reads, pagination support) come in items 3 & 4.
import { onchainTable } from "ponder";

// TODO(item 3/4): replace with real `balance` and `transaction` tables.
export const indexerMeta = onchainTable("indexer_meta", (t) => ({
  id: t.text().primaryKey(),
  value: t.text().notNull(),
}));

// Minimal ABI for the fhEVM ACL contract — only the delegation events the indexer cares about.
//
// The full ACL contract lives in forge-fhevm (contracts/lib/forge-fhevm/.../ACL.sol). We index it
// purely to learn when a partner delegates *user-decryption rights* to the indexer holder, so we can
// backfill cleartext for handles we previously could not decrypt. Signatures (and the matching
// topic0 hashes) are taken from ACLEvents.sol and cross-checked against the Zama SDK's AclTopics.
export const AclAbi = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    inputs: [
      { name: "delegator", type: "address", indexed: true, internalType: "address" },
      { name: "delegate", type: "address", indexed: true, internalType: "address" },
      { name: "contractAddress", type: "address", indexed: false, internalType: "address" },
      { name: "delegationCounter", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "oldExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "newExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RevokedDelegationForUserDecryption",
    inputs: [
      { name: "delegator", type: "address", indexed: true, internalType: "address" },
      { name: "delegate", type: "address", indexed: true, internalType: "address" },
      { name: "contractAddress", type: "address", indexed: false, internalType: "address" },
      { name: "delegationCounter", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "oldExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
] as const;

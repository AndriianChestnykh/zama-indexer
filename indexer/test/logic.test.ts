// Light tests for the seams that decide correctness of the cleartext-where-available view.
//
// HAPPY PATH: a decrypted amount comes out of the API as the correct cleartext string — i.e. an
// event whose handle we are entitled to decrypt produces cleartext on the way out.
//
// NEGATIVE (chosen deliberately): an amount we are NOT entitled to decrypt must still appear, with
// `amount: null` and a status saying why — never silently dropped. This is the brief's sharpest
// requirement ("events the holder is not entitled to decrypt must not be silently dropped") and the
// riskiest seam in the design, so it gets the dedicated negative test.
import { describe, expect, it } from "vitest";
import { amountField, classifyTransfer, direction, eventId, unshieldApiState } from "../src/logic";

const ZERO = "0x0000000000000000000000000000000000000000";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

describe("classifyTransfer", () => {
  it("treats a mint (from == 0x0) as a shield", () => {
    expect(classifyTransfer(ZERO, ALICE)).toBe("shield");
  });
  it("treats a burn (to == 0x0) as an unshield", () => {
    expect(classifyTransfer(ALICE, ZERO)).toBe("unshield");
  });
  it("treats both-sides-set as an internal transfer", () => {
    expect(classifyTransfer(ALICE, HOLDER)).toBe("transfer");
  });
});

describe("amountField — happy path", () => {
  it("surfaces a decrypted handle as the cleartext decimal string", () => {
    expect(amountField({ cleartext: 5_000_000n, status: "decrypted" })).toEqual({
      amount: "5000000",
      amountStatus: "decrypted",
    });
  });
  it("surfaces a publicly disclosed unshield amount even without holder rights", () => {
    expect(amountField({ cleartext: 10_000_000n, status: "disclosed" })).toEqual({
      amount: "10000000",
      amountStatus: "disclosed",
    });
  });
});

describe("amountField — negative: unauthorized is reported, not dropped", () => {
  it("returns null amount with the unauthorized status (row is still present)", () => {
    const out = amountField({ cleartext: null, status: "unauthorized" });
    expect(out.amount).toBeNull();
    expect(out.amountStatus).toBe("unauthorized");
  });
  it("never leaks a stale cleartext if status is not decrypted/disclosed", () => {
    // Even if a cleartext somehow lingers, a non-final status must not expose it.
    expect(amountField({ cleartext: 999n, status: "pending" }).amount).toBeNull();
  });
  it("treats a missing handle row as pending, not an error", () => {
    expect(amountField(undefined)).toEqual({ amount: null, amountStatus: "pending" });
  });
});

describe("unshieldApiState", () => {
  it("maps the in-between debited state to pending_finalization", () => {
    expect(unshieldApiState("requested")).toBe("pending_finalization");
  });
  it("maps the closed state to finalized", () => {
    expect(unshieldApiState("finalized")).toBe("finalized");
  });
});

describe("direction", () => {
  it("is 'in' for the recipient and 'out' for the sender", () => {
    expect(direction(HOLDER, ALICE, HOLDER)).toBe("in");
    expect(direction(ALICE, ALICE, HOLDER)).toBe("out");
  });
});

describe("eventId", () => {
  it("is stable per (txHash, logIndex)", () => {
    expect(eventId("0xabc", 3)).toBe("0xabc-3");
  });
});

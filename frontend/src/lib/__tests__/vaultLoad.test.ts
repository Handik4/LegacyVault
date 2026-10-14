import { describe, expect, it } from "vitest";
import {
  applyVault,
  failCycle,
  finishCycle,
  initialVaultsState,
  loadByIds,
  partialMessage,
  type VaultsState,
} from "../vaultLoad";
import type { VaultView } from "../types";

const vault = (id: number): VaultView => ({
  id,
  owner: "0xowner",
  commitment: "a".repeat(64),
  principal: 10n ** 18n,
  state: 0,
  stateName: "ACTIVE",
  createdAt: 0,
  lastHeartbeat: 0,
  threshold: 90 * 86400,
  claimableAt: 0,
  executor: "",
  claimant: "",
  claimBond: 0n,
  claimStartedAt: 0,
  vetoUntil: 0,
  certEpoch: 0,
  certHash: "",
  verifyAttempts: 0,
  requiredBond: 0n,
  heirs: [],
});

const defer = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("partial vault read failure must stay visible", () => {
  it("Vault 1 fails, Vault 2 succeeds later -> partial state remains, naming vault 1", async () => {
    const d1 = defer<VaultView>();
    const d2 = defer<VaultView>();
    let state: VaultsState = initialVaultsState;
    const cycle = loadByIds(
      [1, 2],
      (id) => (id === 1 ? d1.promise : d2.promise),
      (v) => {
        state = applyVault(state, v);
      },
    );

    d1.reject(new Error("RPC: Can't reconnect until invalid transaction is rolled back"));
    await Promise.resolve();
    // vault 1 has failed; nothing has arrived yet
    expect(state.vaults).toBeNull();

    d2.resolve(vault(2)); // the later, successful read
    const result = await cycle;
    // The arrival itself must not have declared the view healthy.
    expect(state.status).toBe("loading");
    expect(state.vaults?.map((v) => v.id)).toEqual([2]);

    state = finishCycle(state, result);
    expect(state.status).toBe("partial"); // NOT "ready"
    expect(state.failedIds).toEqual([1]);
    expect(state.expected).toBe(2);
    expect(state.vaults?.map((v) => v.id)).toEqual([2]); // vault 2 is still rendered
    expect(partialMessage(state)).toBe(
      "Warning: 1 of 2 vaults failed to load from RPC. Critical heartbeat or veto actions may be hidden.",
    );
  });

  it("a successful read ordered BEFORE the failure cannot mask it either", async () => {
    let state: VaultsState = initialVaultsState;
    const result = await loadByIds(
      [1, 2, 3],
      async (id) => {
        if (id === 2) throw new Error("timeout");
        return vault(id);
      },
      (v) => {
        state = applyVault(state, v);
      },
    );
    state = finishCycle(state, result);
    expect(state.status).toBe("partial");
    expect(state.failedIds).toEqual([2]);
    expect(state.vaults?.map((v) => v.id)).toEqual([1, 3]);
  });

  it("applyVault never touches status, failedIds or error", () => {
    const failing: VaultsState = { status: "partial", vaults: [], failedIds: [1], expected: 2, error: null };
    const after = applyVault(failing, vault(2));
    expect(after.status).toBe("partial");
    expect(after.failedIds).toEqual([1]);
    const syncing: VaultsState = { status: "syncing", vaults: null, failedIds: [], expected: 0, error: "boom" };
    const after2 = applyVault(syncing, vault(7));
    expect(after2.status).toBe("syncing");
    expect(after2.error).toBe("boom");
  });

  it("only becomes ready when 100% of indexed ids resolved", async () => {
    let state: VaultsState = initialVaultsState;
    const result = await loadByIds([1, 2], async (id) => vault(id), (v) => {
      state = applyVault(state, v);
    });
    state = finishCycle(state, result);
    expect(state.status).toBe("ready");
    expect(state.failedIds).toEqual([]);
  });

  it("every read failing is partial with zero vaults, never an empty 'ready'", async () => {
    let state: VaultsState = initialVaultsState;
    const result = await loadByIds([1, 2], async () => {
      throw new Error("down");
    }, (v) => {
      state = applyVault(state, v);
    });
    state = finishCycle(state, result);
    expect(state.status).toBe("partial");
    expect(state.vaults).toEqual([]);
    expect(state.failedIds).toEqual([1, 2]);
  });

  it("a later clean cycle (the Retry) clears the warning only when all reads pass", async () => {
    let state: VaultsState = initialVaultsState;
    const flaky = new Set([1]);
    const read = async (id: number) => {
      if (flaky.has(id)) throw new Error("rpc");
      return vault(id);
    };
    const run = async () => {
      const r = await loadByIds([1, 2], read, (v) => {
        state = applyVault(state, v);
      });
      state = finishCycle(state, r);
    };
    await run();
    expect(state.status).toBe("partial");
    await run(); // still failing: stays partial
    expect(state.status).toBe("partial");
    flaky.clear();
    await run(); // retry succeeds fully
    expect(state.status).toBe("ready");
    expect(state.failedIds).toEqual([]);
    expect(state.vaults?.map((v) => v.id)).toEqual([1, 2]);
  });

  it("failCycle keeps the records on screen and reports syncing", () => {
    const s: VaultsState = { status: "ready", vaults: [vault(1)], failedIds: [], expected: 1, error: null };
    const f = failCycle(s, "index unreadable");
    expect(f.status).toBe("syncing");
    expect(f.vaults).toHaveLength(1);
    expect(f.error).toBe("index unreadable");
  });
});

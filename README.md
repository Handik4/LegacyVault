# LegacyVault: Trust-Minimized Digital Estate & Succession Protocol

A GenLayer Intelligent Contract that combines an inactivity bound, a staked
succession claim, **three-source vital-record consensus** performed by GenVM
validators, and a **30-day veto-and-slash window** that lets a living owner cancel
a fraudulent claim and confiscate the claimant's bond.

| | |
|---|---|
| **Network** | GenLayer Studio Next, chain `61997` |
| **Contract** | [`0xAcB4509274F8C6311ddeEd6116D61dAB81B47163`](https://explorer-studio-next.genlayer.com/address/0xAcB4509274F8C6311ddeEd6116D61dAB81B47163) |
| **Deploy tx** | `0xe3a8d024cd13db823c1728e978c6b96c2846bcb81f857f6d968807fcff6555cf` (FINALIZED, MAJORITY_AGREE, FINISHED_WITH_RETURN) |
| **Source hash** | `sha256 d6a49a07…d1644`, byte-identical to `contracts/legacy_vault.py` (checked against the explorer's copy of the deploy tx) |
| **RPC** | `https://studio-next.genlayer.com/api` |

## Status, stated plainly

- **Deployed and source-verified.** The code on-chain is this repository's contract.
- **Not seeded.** The demo vault was not created. Studio Next's `gen_call` and
  `sim_estimateTransactionFees` endpoints returned a server-side SQLAlchemy fault
  (`Can't reconnect until invalid transaction is rolled back`) for the whole build
  session; the previously deployed Westphalia contract failed identically, so it is
  an RPC-wide outage, not this contract. Two seed attempts reverted with
  `FeeValueMustBeNonZero(1)` because no fee quote could be derived. The deploy
  script now skips the seed when no quote exists and records that in
  `deployments/studio-next.json`. To seed once the RPC recovers:
  `LEGACYVAULT_DEPLOY_TX=0xe3a8d024… genlayer deploy --rpc https://studio-next.genlayer.com/api`
- **Constructor state not read back** for the same reason (`verification.registries`).
- **Registry mirrors** are served from [`deployments/mock_registry/`](deployments/mock_registry/README.md)
  of `github.com/Handik4/LegacyVault` through three distinct hosts (raw.githubusercontent.com,
  jsDelivr, githack). They are one repository behind three CDNs, i.e. a testnet
  simulation of three registries, not independent civil authorities.
- **No live-consensus integration run.** The 206 contract tests run in GenVM *direct
  mode*, which executes the leader function and replays validator closures via
  `run_validator`; it does not exercise real multi-validator consensus.
- **No third-party audit.** "Hardened" means the invariants below are each pinned by
  an adversarial test, not that an auditor has signed off.

## Architecture

```
                       ┌────────────────────────── LegacyVault (GenVM) ───────────────────────────┐
 owner ── create ────▶ │ Vault { identity_commitment, principal, heirs[1..5] bps, threshold ≥90d } │
        ◀─ heartbeat ─ │                                                                          │
                       │   ACTIVE ──initiate_claim(bond ≥ max(10%·principal, floor))──▶ CLAIM_INIT │
 heir ── bond ───────▶ │                                                                │         │
                       │                              verify_claim ── run_nondet ───────┤         │
                       │                                   │                            ▼         │
                       │        ┌── registry A (host 1) ───┤   verdict 2 QUORUM_FAILURE: retry,   │
 validators ─ GET ───▶ │        ├── registry B (host 2) ───┤              no slash                │
                       │        └── registry C (host 3) ───┘   verdict 0 NO_RECORD: bond → estate │
                       │                                       verdict 1 VERIFIED_DECEASED        │
                       │                                                    │                     │
                       │   owner veto / heartbeat / revoke  ◀── VETO_CHALLENGE_PERIOD (30 days)   │
                       │      └─ 100% of claimant bond → owner             │                     │
                       │                                      finalize_succession (anyone)        │
                       │                                                    ▼                     │
 heirs ─ claim_inheritance (pull, one each) ◀──────────────────────── SUCCEEDED                   │
                       └──────────────────────────────────────────────────────────────────────────┘
```

### State machine

| State | Entered by | Leaves by |
|---|---|---|
| `ACTIVE` | `create_vault`; veto/heartbeat/withdraw/expiry; `NO_RECORD` | `initiate_claim`, `revoke_vault` |
| `CLAIM_INITIATED` | `initiate_claim` | `verify_claim` (→ VETO or ACTIVE), `withdraw_claim`, `expire_claim` (30d), owner veto/heartbeat/revoke |
| `VETO_CHALLENGE_PERIOD` | `verify_claim` → verdict 1 | `finalize_succession` (after 30d), owner veto/heartbeat/revoke (any time before finalize) |
| `SUCCEEDED` | `finalize_succession` | terminal; heirs pull |
| `REVOKED` | `revoke_vault` | terminal |

### Consensus payload

Validators agree on exactly `{"verdict": int, "source_count": int, "cert_epoch": int, "cert_hash": str}`.
`cert_hash` is `""` unless the verdict is `1`, in which case it must be a 64-char lower-case
hex digest. It is the key for the per-vault replay guard, so it crosses consensus and
is compared by every validator; it is never free text.

| verdict | Meaning | Effect |
|---|---|---|
| `0` NO_RECORD_FOUND | ≥2 sources answered and they did not all confirm the same certificate | claim rejected; bond forfeited **into the estate** |
| `1` VERIFIED_DECEASED | ≥2 sources answered, every responder confirmed the same certificate hash and date | enter 30-day veto window |
| `2` QUORUM_FAILURE | fewer than 2 sources answered | nothing changes; retry without slashing |

A source "responds" on a clean 404/410 or a well-formed record in the LegacyVault
schema. Timeouts, 5xx/429/403, unparseable bodies, non-object JSON, bodies over 8 KB
and **foreign schemas** all count as *not responding*, so a broken registry can
never force a bond forfeiture on an honest claimant.

A record is `CONFIRMED` only if: schema matches; `identity_commitment` equals the
vault's; `status == "CONFIRMED"`; `certificate_hash` is 64-hex; `date_of_death` is a
real calendar day **≥ the vault's creation day**, **not in the future**, and **not
before the owner's last heartbeat** (an owner cannot sign after the day they died).

## Security matrix

| # | Threat | Mitigation | Pinned by |
|---|---|---|---|
| 1 | Claimant points validators at a forged page | No URL parameter exists. Record URL = `{governed base}/{commitment}.json`; bases are https-only DNS names (no IP literals, ports, userinfo, query), pairwise distinct hosts | `test_nothing_in_the_abi_accepts_a_url`, `test_record_url_is_derived_from_commitment_not_supplied`, `test_constructor_rejects_unsafe_registry_urls` |
| 2 | Governor swaps in malicious registries | 7-day timelock (`propose_registry` → permissionless `activate_registry`), independence re-checked, governor has no fund path | `test_rotation_is_timelocked_seven_days`, `test_governor_has_no_path_to_user_funds` |
| 3 | One registry lies or lags | Quorum ≥2; unanimity among responders; conflicting cert hash or date → NO_RECORD | `test_responders_must_all_agree_one_dissent_blocks`, `test_conflicting_*` |
| 4 | Leader forges verdict / source count / epoch | Validator rejects wrong keys, non-int/bool types, out-of-range or inconsistent values, then re-derives and compares all three fields | `TestValidatorEquivalence` (9 tests) |
| 5 | Leader smuggles free text into storage | Only three ints cross consensus; payload re-gated before state change | `test_validator_rejects_malformed_or_extra_key_payload` |
| 6 | Premature claim / owner hospitalised | Inactivity ≥90d, 10% bond, 30-day veto, bond confiscated to owner | `test_claim_before_inactivity_threshold_reverts`, `test_owner_veto_slashes_claimant_bond_100_percent` |
| 7 | Stale / pre-dated certificate | Death date ≥ creation day, ≤ now, ≥ last heartbeat; replay after a veto fails | `test_certificate_predating_vault_creation_rejected`, `test_stale_certificate_cannot_be_replayed_after_a_veto` |
| 8 | Bond griefing by a malfunctioning registry | Only a clean answer can slash; foreign schema = outage | `test_foreign_schema_is_not_a_response_*` |
| 9 | Third party steals an allocation | `claim_inheritance` requires the caller to be that beneficiary, once | `test_unauthenticated_caller_cannot_steal_heir_allocation`, `test_heir_cannot_double_claim` |
| 10 | One heir blocks the rest | Pull payments, no payout loop | `test_one_heir_never_claiming_does_not_block_the_others` |
| 11 | Rounding dust locked | Remainder to heir 0; sum always equals principal | `test_bps_rounding_remainder_assigned_to_primary_heir_zero_dust_locked`, `test_split_never_loses_a_wei` |
| 12 | Vault frozen by absent claimant | `withdraw_claim`, permissionless `expire_claim` after 30d | `TestClaimUnwind` |
| 13 | Payout enqueue failure destroys accounting | Failure reverts the whole call (`ERR_TRANSFER_FAILED_RESTORED`) | `test_failing_payout_reverts_with_classified_error` |
| 14 | One operator fills the quorum by registering the same endpoint in several slots | A URL **and** a host may occupy one slot only, checked against other slots' active *and staged* endpoints at proposal, and re-checked at activation | `test_duplicate_registry_url_cannot_satisfy_multi_source_quorum`, `test_activation_*` |
| 15 | A vetoed certificate is replayed in a later claim | `veto_claim` / `heartbeat` / `revoke_vault` during the challenge period record `"<vault_id>:<cert_hash>"` in `invalidated_certs`; `verify_claim` treats a replay as `NO_RECORD` (bond joins the estate) | `test_previously_vetoed_certificate_cannot_be_replayed_in_future_claim` |
| 16 | Attacker poisons a victim's certificate via a throwaway vault with the same commitment | The invalidation record is **per vault**, not global | `test_invalidation_is_scoped_to_one_vault_so_it_cannot_poison_a_victims_heirs` |
| 17 | Zero / negative / dust deposits, bad bps | Strict validation | `test_strict_input_validation_blocks_negative_or_zero_deposits` |

### Known limits (design, not bugs)

- **Registry honesty is the root of trust.** If all responding registries confirm a
  false death, only the owner's veto stands between a claimant and the estate.
- **Registry lag costs the claimant.** A real death not yet published yields
  `NO_RECORD` and the bond joins the estate; the heir can retry with a new bond.
- **Note references are public on-chain.** The contract withholds them from views
  until finalization, but storage is readable. Store ciphertext or a pointer to it.
- **Duplicate commitments are allowed** (uniqueness would let anyone squat a
  victim's commitment). A vault is only ever paid from its own deposit.
- **90-day minimum inactivity** means a live demo of the full path needs either a
  90-day wait or the direct-mode test suite.
- Studio Next has no time travel; the veto path is demonstrated in tests.

## Repository layout

```
contracts/legacy_vault.py        Intelligent Contract
tests/                           pytest direct-mode suite (206 cases)
deploy/deploy_legacy_vault.ts    genlayer deploy script: fee derivation, strict receipts, seed + verify
deployments/studio-next.json     deployment record (what was and was not verified)
deployments/legacy_vault_abi.json  schema from genvm-lint
deployments/mock_registry/       testnet registry fixtures (served via 3 hosts)
frontend/                        Next.js 14.2.35 + Tailwind light-mode UI
```

## Reproduce from a clean checkout

```bash
# Contract tests (Python 3.12 required by the genlayer-test pin)
uv venv --python 3.12
uv pip install --prerelease=allow -r requirements-dev.txt
.venv/bin/python -m pytest -q                     # 206 passed

# Lint + SDK validation + Pyright typecheck (both clean)
GENVM_VERSION=v0.6.0-rc8 .venv/bin/genvm-lint check contracts/legacy_vault.py
GENVM_VERSION=v0.6.0-rc8 .venv/bin/genvm-lint typecheck contracts/legacy_vault.py

# Frontend
cd frontend
npm install
npm test                  # 99 unit tests: receipt assessment, amount parsing, identity, bps, registry rules
npx tsc --noEmit
npm run build
```

**Why `GENVM_VERSION=v0.6.0-rc8`:** the contract pins runner
`py-genlayer:5jycge4q…`, which GenVM bundle rc9 no longer ships. The test conftest
sets this variable itself; the linter needs it exported.

### Deploy

```bash
genlayer deploy --rpc https://studio-next.genlayer.com/api
# env: LEGACYVAULT_REGISTRY_A/B/C, LEGACYVAULT_SEED=0, LEGACYVAULT_DEPLOY_TX=<hash to adopt>
```

The script derives the fee deposit from the live policy (never a constant), applies a
strict receipt check (ACCEPTED/FINALIZED **and** MAJORITY_AGREE **and**
FINISHED_WITH_RETURN), verifies the deployed source hash through the explorer
independently of `gen_call`, and records exactly which checks passed.

## Frontend behaviour

- **Writes:** `estimateTransactionFeesForWrite()` → `writeContract({ fees })` →
  `waitForTransactionReceipt()` → strict assessment. No gas limit or fee is
  hardcoded; if no quote is available the write is refused, not sent with zero.
- **Receipts:** `UNDETERMINED`, `MAJORITY_DISAGREE`, no-majority, timeouts and
  reverts each surface as explicit errors. Studio Next returns snake_case names
  (`status_name`, `result_name`); both spellings are read. Numeric consensus codes
  are not trusted (observed `result: 1` ↔ `MAJORITY_AGREE`, which differs from the
  SDK enum order).
- **Account isolation:** the panel container is keyed by the connected address, so
  switching accounts unmounts it, clearing form state and vault data; transaction
  results are tied to the component's AbortController and discarded after unmount.
- **Input validation:** GEN amounts must be plain positive decimals (no sign, exponent,
  hex, separators, >18 dp); whole numbers digits-only; bps must total 10000.
- **Polling cannot abort a read.** A `SerialLoader` holds an in-flight lock: the 30s tick
  is a no-op while a read is running (no abort, no stacking); explicit refreshes during
  a read coalesce into exactly one follow-up. Aborts happen only on unmount.
- **Owner / Succession panels load per account.** They use `get_vault_ids_for` +
  `get_vault`, rendering each record as it arrives, instead of waiting on a traversal
  of every vault. Heir notes come from the full `get_vault` record (the paged summary
  view deliberately omits them), so they survive a reload.
- **Partial failures are never masked.** Vault health is decided once per load cycle from
  that cycle's failure set. A single vault arriving only adds a record to the view; it
  cannot clear another vault's failure. If any indexed vault fails, the panel shows the
  vaults that loaded **and** a warning ("X of Y vaults failed to load from RPC. Critical
  heartbeat or veto actions may be hidden.") naming the failed ids, with Retry. The
  "no vaults" empty state is only shown when every read succeeded.
- **Reads:** every read runs under a 6-second AbortController. On failure the
  `SyncAlert` banner appears and values render `—`, never `0`. This was exercised
  for real against the failing RPC during development.

## Frontend dependency advisories

`npm audit` was run against the official registry (`--registry=https://registry.npmjs.org`;
this machine's default mirror does not implement the audit endpoint).

**Before:** 15 advisories (5 moderate, 7 high, 3 critical). **After:** 6 (0 moderate,
5 high, 1 critical) packages flagged. Build, `tsc` and all 99 vitest tests pass after the
changes, and the generated CSS was spot-checked for the project's design-token classes.

### Resolved

| Package | Advisories | Fix applied |
|---|---|---|
| `postcss` bundled inside `next` (8.4.31) | 4 high (XSS via `</style>`, sourceMappingURL file reads) | `overrides: { next: { postcss: "8.5.30" } }`; the whole tree now resolves one postcss 8.5.30 |
| `postcss-selector-parser` (<7.1.6, via tailwindcss and postcss-nested) | 1 moderate (quadratic selector parsing) | `overrides: { "postcss-selector-parser": "7.1.6" }`. This crosses a major from the 6.x these packages declare; the build and generated CSS were verified, but treat it as the one override worth re-checking on a Tailwind upgrade |
| `vitest` 2.x chain: `vite`, `esbuild`, `@vitest/mocker`, `vite-node`, `tinypool` | 1 critical, 1 high, 3 moderate (dev server file read, prototype-pollution RCE gadget) | direct bump to `vitest@^5.0.4` (and `@types/node@^22`, required by its peer range). Dev-only; none of it ships in the bundle |

### Remaining (not patchable without a major upgrade)

| Package | Severity | Reachable from | Used by LegacyVault? |
|---|---|---|---|
| `next@14.2.35`: 23 advisories, first fixed in **15.5.24**; no 14.x backport exists | 1 critical (RCE), several high | the **Next.js server runtime** when self-hosted with `next start` | See breakdown below |
| `braces` ≤3.0.3 (GHSA-vfj7-8cjw-p6xm, high; no patched release), plus `micromatch`, `fast-glob`, `chokidar` and `tailwindcss@3.4.19` flagged through it | high | **build time only**: Tailwind expands the content globs in `tailwind.config.ts` | Inputs are the repo's own glob strings, not attacker data; nothing ships to the browser. Fix is Tailwind 4 (config-format migration) |

Breakdown of the Next.js advisories against what this app actually uses (checked by
searching `src/` and `next.config.mjs`):

| Feature the advisory concerns | Advisories | Used here? |
|---|---|---|
| Image Optimizer / `next/image` | GHSA-9g9p-9gw9-jx7f, GHSA-3x4c-7xq6-9pq8, GHSA-h64f-5h5j-jqjh, **GHSA-2xp9-vwfh-vxw4 (critical, AVIF)** | `next/image` not used; `next.config.mjs` sets no `images` options. The `/_next/image` route is part of the server runtime regardless, so this still applies to a self-hosted server |
| Server Actions / Server Functions | GHSA-m99w-x7hq-7vfj, GHSA-89xv-2m56-2m9x, GHSA-4c39-4ccg-62r3, GHSA-955p-x3mx-jcvp | No (`"use server"` absent) |
| React Server Components request handling | GHSA-h25m-26qc-wcjf, GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj | App Router is used (layout + page), so the server runtime processes RSC requests if self-hosted |
| Rewrites, middleware, i18n | GHSA-ggv3-7p47-pfv8, GHSA-p9j2-gv94-2wf4, GHSA-3g8h-86w9-wvmq, GHSA-36qx-fr4f-26g5 | No rewrites, redirects, middleware, i18n or Pages Router |
| Response / RSC cache confusion | GHSA-68g3-v927-f742, GHSA-4633-3j49-mh5q, GHSA-wfc6-r584-vfw7, GHSA-vfv6-92ff-j949 | Server-side caching behavior; the page is fully static (`○ Static` in the build output) and takes no request bodies |
| CSP nonces, `beforeInteractive` scripts | GHSA-ffhc-5mcf-pf4q, GHSA-gx5p-jg67-6x7h | No (`next/script` and CSP nonces not used) |
| WebSocket upgrades | GHSA-c4j6-fc7j-m34r | Not used by the app; applies to a self-hosted server |
| Windows-hosted servers | **GHSA-p293-qw3h-jr36 (critical, RCE)** | Only if the Next server is run on Windows |

**Reading this honestly:** the application code does not use the vulnerable features, but
several advisories concern the *server runtime* itself, which `npm start` runs. Anyone
exposing `next start` publicly should upgrade to Next ≥ 15.5.24 first (a small change for
an app this size, left out of this pass because it is a major-version migration) or serve
only the prerendered static output. Wallet and RPC traffic goes browser-to-GenLayer and
never passes through the Next server.

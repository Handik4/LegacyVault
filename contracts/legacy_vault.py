# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# LegacyVault: Trust-Minimized Digital Estate & Succession Protocol.
#
# A dead-man's-switch estate vault that does not trust the clock alone. An
# owner locks native GEN against an immutable identity commitment and a 1..5 heir
# table in basis points. After a mandatory inactivity window a registered heir
# (or the owner's designated executor) may post a bond and ask GenVM validators to
# corroborate a death record against THREE independent, protocol-governed vital
# record registries. A verified death does not release funds: it opens a 30-day
# veto window in which a living owner cancels the claim and takes the claimant's
# whole bond. Only after that window may the estate be finalized and heirs pull
# their exact allocation.
#
# Security invariants (each is pinned by a regression test):
#   1. NO USER URLS. Claimants never pass a URL. Registry base URLs live in
#      contract storage, are https-only / host-shaped / mutually distinct, and
#      rotate only through a 7-day governor timelock. The record URL is
#      derived: {registry_base}/{identity_commitment}.json.
#   2. QUORUM. >= 2 of 3 registries must return the same CONFIRMED certificate
#      (same hash, same date of death). A clean 404/410 is "no record at this
#      source": it abstains and cannot veto two matching confirmations (CDN lag),
#      but a source that returns a conflicting certificate or an explicit
#      non-confirming record (REVOKED / ALIVE / wrong identity) blocks the
#      claim. Fewer than 2 responders is a retryable QUORUM_FAILURE.
#   3. STRICT PAYLOAD EQUIVALENCE. The only thing validators agree on is the
#      4-field payload {"verdict": int, "source_count": int, "cert_epoch": int,
#      "cert_hash": str}. The validator checks exact keys / types / internal
#      consistency (cert_hash is "" unless verdict is 1, then 64-char hex),
#      re-derives the payload itself and requires all four fields to match. No
#      leader-supplied free text ever reaches storage.
#   4. VETO + SLASH. Until finalize_succession() the owner can call
#      veto_claim() / heartbeat() / revoke_vault(); the claimant's bond is
#      confiscated to the owner.
#   5. ZERO-DUST BPS. Shares sum to exactly 10000; the integer remainder goes
#      to heir index 0, so no wei is stranded. Heirs pull their own share.
#   6. PULL PAYMENT. No loop ever pays out. Each heir calls claim_inheritance().
#   7. NO CERTIFICATE REPLAY. A certificate that a living owner vetoed is
#      recorded against THAT vault and can never open another claim on it. The
#      record is per-vault on purpose: duplicate identity commitments are
#      allowed, so a global blacklist would let an attacker veto a victim's real
#      certificate through a throwaway vault and lock the victim's heirs out.
#   8. UNIQUE SOURCES. A registry URL or host may appear in at most one slot,
#      counting both active and staged (pending) rotations, so one operator can
#      never fill the 3-source quorum by itself.

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import NoReturn

import genlayer as gl
from genlayer import Address, u256
from genlayer.storage import DynArray, TreeMap

# genvm-lint requires the bare name `allow_storage` on storage dataclasses.
allow_storage = gl.storage.allow

# --- Error classification ----------------------------------------------------
ERR_EXPECTED = "[EXPECTED]"
ERR_INPUT = f"{ERR_EXPECTED} ERR_INVALID_INPUT"
ERR_STATE = f"{ERR_EXPECTED} ERR_INVALID_STATE"
ERR_AUTH = f"{ERR_EXPECTED} ERR_UNAUTHORIZED"
ERR_TIME = f"{ERR_EXPECTED} ERR_TOO_EARLY"
ERR_BOND = f"{ERR_EXPECTED} ERR_INSUFFICIENT_BOND"
ERR_NOT_FOUND = f"{ERR_EXPECTED} ERR_UNKNOWN_VAULT"
ERR_NOTHING = f"{ERR_EXPECTED} ERR_NOTHING_TO_CLAIM"
ERR_TRANSFER = f"{ERR_EXPECTED} ERR_TRANSFER_FAILED_RESTORED"

# --- Vault lifecycle ---------------------------------------------------------
ST_ACTIVE = 0  # healthy; heartbeat clock running
ST_CLAIM_INITIATED = 1  # bond posted, awaiting registry verification
ST_VETO_PERIOD = 2  # death corroborated; 30-day veto window open
ST_SUCCEEDED = 3  # finalized; heirs may pull allocations
ST_REVOKED = 4  # owner withdrew the estate
STATE_NAMES = {
    ST_ACTIVE: "ACTIVE",
    ST_CLAIM_INITIATED: "CLAIM_INITIATED",
    ST_VETO_PERIOD: "VETO_CHALLENGE_PERIOD",
    ST_SUCCEEDED: "SUCCEEDED",
    ST_REVOKED: "REVOKED",
}

# --- Registry verdict enum (the only consensus payload) ----------------------
V_NO_RECORD = 0
V_VERIFIED_DECEASED = 1
V_QUORUM_FAILURE = 2

# --- Protocol constants ------------------------------------------------------
DAY = 86_400
MIN_INACTIVITY = 90 * DAY
MAX_INACTIVITY = 3_650 * DAY
VETO_WINDOW = 30 * DAY
CLAIM_VERIFY_WINDOW = 30 * DAY  # a claim not verified by then is releasable by anyone
REGISTRY_TIMELOCK = 7 * DAY
MIN_DEPOSIT = 10**15  # 0.001 GEN
MIN_CLAIM_BOND = 10**15  # fixed floor; the bond is max(floor, 10% of principal)
CLAIM_BOND_BPS = 1_000
BPS_TOTAL = 10_000
MAX_BENEFICIARIES = 5
REGISTRY_COUNT = 3
MIN_SOURCES = 2
MAX_NOTE_LEN = 512
MAX_RECORD_BYTES = 8_192
RECORD_SCHEMA = "legacyvault.vital-record/v1"
STATUS_CONFIRMED = "CONFIRMED"

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
# https only, DNS name with an alphabetic TLD (no IP literal in any encoding),
# no userinfo / port / query / fragment, conservative path alphabet ('@' is
# allowed in the PATH only, for CDN forms such as /gh/user/repo@branch).
_BASE_URL = re.compile(r"^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(/[A-Za-z0-9._~@-]+)*$")
_RESERVED_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".test", ".invalid", ".example")
_RESERVED_HOSTS = ("localhost",)


# ============================================================================
# Pure helpers (no storage access: safe to call inside the nondet closure)
# ============================================================================
def _fail(code: str, detail: str = "") -> NoReturn:
    raise gl.vm.UserError(f"{code} {detail}".strip())


def _registry_host(base_url: str) -> str:
    return base_url[len("https://"):].split("/", 1)[0].lower()


def _valid_registry_base(base_url: str) -> bool:
    """Deterministic shape + SSRF guard for a governed registry base URL."""
    if not isinstance(base_url, str) or len(base_url) > 200:
        return False
    if not _BASE_URL.match(base_url):
        return False
    host = _registry_host(base_url)
    if host in _RESERVED_HOSTS:
        return False
    for suffix in _RESERVED_SUFFIXES:
        if host.endswith(suffix):
            return False
    return True


def _parse_iso_day(text: str) -> int:
    """Strict YYYY-MM-DD -> UTC midnight epoch seconds, or -1 if malformed."""
    if not isinstance(text, str):
        return -1
    m = _ISO_DATE.match(text)
    if m is None:
        return -1
    try:
        d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
    except (ValueError, OverflowError):
        return -1
    return int(d.timestamp())


def _evaluate_record(
    record: object, commitment: str, creation_day: int, now: int, last_heartbeat: int
) -> dict:
    """Judge one well-formed JSON record. Never raises.

    A record is CONFIRMED only if every one of these holds: schema matches, the
    record names exactly this vault's identity commitment, status is CONFIRMED,
    the certificate hash is a 64-char hex digest, the date of death is a valid
    calendar day that is not before the vault was created, not in the future, and
    does not precede the owner's own last heartbeat (an owner cannot sign
    transactions after the day they died)."""
    none = {"state": "no_record", "cert_hash": "", "death_epoch": 0}
    if not isinstance(record, dict):
        return none
    if record.get("schema") != RECORD_SCHEMA:
        return none
    ident = record.get("identity_commitment")
    if not isinstance(ident, str) or ident.lower() != commitment:
        return none
    if record.get("status") != STATUS_CONFIRMED:
        return none
    cert = record.get("certificate_hash")
    if not isinstance(cert, str) or not _HEX64.match(cert.lower()):
        return none
    death_day = _parse_iso_day(record.get("date_of_death"))
    if death_day < 0:
        return none
    if death_day < creation_day:
        return none  # certificate predates the vault
    if death_day > now:
        return none  # death in the future
    if death_day + DAY <= last_heartbeat:
        return none  # owner demonstrably acted after the recorded death
    return {"state": "confirmed", "cert_hash": cert.lower(), "death_epoch": death_day}


def _fetch_source(base_url: str, commitment: str, creation_day: int, now: int, last_heartbeat: int) -> dict:
    """Query ONE registry. Returns {"responded": bool, "state", "cert_hash",
    "death_epoch"}. Unreachable / rate-limited / 5xx / corrupt transport counts
    as NOT responded; a clean 404/410 is a responded "absent" (abstains, never
    vetoes); a well-formed non-confirming record is a responded "no_record"
    (explicit negative)."""
    silent = {"responded": False, "state": "no_record", "cert_hash": "", "death_epoch": 0}
    url = f"{base_url}/{commitment}.json"
    try:
        res = gl.nondet.web.get(url)
    except Exception:
        return silent
    status = getattr(res, "status", None)
    if status is None:
        status = getattr(res, "status_code", None)
    if not isinstance(status, int):
        return silent
    if status in (404, 410):
        return {"responded": True, "state": "absent", "cert_hash": "", "death_epoch": 0}
    if not (200 <= status < 300):
        return silent
    try:
        body = res.body
        if isinstance(body, (bytes, bytearray)):
            if len(body) > MAX_RECORD_BYTES:
                return silent
            text = bytes(body).decode("utf-8")
        elif isinstance(body, str):
            if len(body) > MAX_RECORD_BYTES:
                return silent
            text = body
        else:
            return silent
        record = json.loads(text)
    except Exception:
        return silent
    # A registry that does not answer in OUR schema is not answering the
    # question at all. Counting it as "responded: no record" would let one
    # misconfigured endpoint force a bond forfeiture on an honest claimant, so
    # it is treated exactly like an outage.
    if not isinstance(record, dict) or record.get("schema") != RECORD_SCHEMA:
        return silent
    verdict = _evaluate_record(record, commitment, creation_day, now, last_heartbeat)
    return {
        "responded": True,
        "state": verdict["state"],
        "cert_hash": verdict["cert_hash"],
        "death_epoch": verdict["death_epoch"],
    }


def _aggregate(results: list) -> dict:
    """Collapse per-source outcomes to the discrete consensus payload.

    Each source is one of: not responded (outage / 5xx / foreign schema),
    "absent" (clean 404/410: no record at this source, which abstains from
    positive proof), "confirmed" (a valid CONFIRMED record), or "no_record" (a
    well-formed record that is NOT a valid confirmation for this vault: REVOKED,
    ALIVE, wrong identity, predates the vault, ...; an explicit negative).

      * fewer than 2 responders                      -> QUORUM_FAILURE
      * >= 2 CONFIRMED, one identical certificate
        (hash + epoch), and no source that holds a
        conflicting or explicitly negative record    -> VERIFIED_DECEASED
      * anything else with >= 2 responders           -> NO_RECORD

    A lagging mirror that still answers 404 therefore cannot veto two matching
    confirmations, while a registry that affirmatively contradicts them can.
    For VERIFIED_DECEASED, source_count is the number of matching confirmations;
    otherwise it is the number of responders."""
    responded = [r for r in results if r["responded"]]
    n = len(responded)
    if n < MIN_SOURCES:
        return {"verdict": V_QUORUM_FAILURE, "source_count": n, "cert_epoch": 0, "cert_hash": ""}
    confirmed = [r for r in responded if r["state"] == "confirmed"]
    dissent = [r for r in responded if r["state"] == "no_record"]
    if len(confirmed) >= MIN_SOURCES and not dissent:
        first = confirmed[0]
        if all(
            r["cert_hash"] == first["cert_hash"] and r["death_epoch"] == first["death_epoch"]
            for r in confirmed
        ):
            return {
                "verdict": V_VERIFIED_DECEASED,
                "source_count": len(confirmed),
                "cert_epoch": int(first["death_epoch"]),
                "cert_hash": first["cert_hash"],
            }
    return {"verdict": V_NO_RECORD, "source_count": n, "cert_epoch": 0, "cert_hash": ""}


def _is_int(x: object) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _payload_well_formed(p: object) -> bool:
    """Exact-structure gate for a consensus payload. Rejects extra / missing
    keys, wrong types (bool counts as wrong) and internally inconsistent
    combinations, so a leader cannot smuggle anything else in. `cert_hash` is
    either "" or a 64-char lower-case hex digest; it is never free text."""
    if not isinstance(p, dict):
        return False
    if set(p.keys()) != {"verdict", "source_count", "cert_epoch", "cert_hash"}:
        return False
    v, n, c, h = p["verdict"], p["source_count"], p["cert_epoch"], p["cert_hash"]
    if not (_is_int(v) and _is_int(n) and _is_int(c)):
        return False
    if not isinstance(h, str):
        return False
    if v not in (V_NO_RECORD, V_VERIFIED_DECEASED, V_QUORUM_FAILURE):
        return False
    if n < 0 or n > REGISTRY_COUNT or c < 0:
        return False
    if v == V_VERIFIED_DECEASED:
        return n >= MIN_SOURCES and c > 0 and _HEX64.match(h) is not None
    if h != "" or c != 0:
        return False
    if v == V_QUORUM_FAILURE:
        return n < MIN_SOURCES
    return n >= MIN_SOURCES


def _payloads_agree(theirs: object, mine: object) -> bool:
    """Validator decision: both payloads well-formed and equal on every
    consensus field."""
    if not _payload_well_formed(theirs) or not _payload_well_formed(mine):
        return False
    return (
        int(theirs["verdict"]) == int(mine["verdict"])  # type: ignore[index]
        and int(theirs["source_count"]) == int(mine["source_count"])  # type: ignore[index]
        and int(theirs["cert_epoch"]) == int(mine["cert_epoch"])  # type: ignore[index]
        and theirs["cert_hash"] == mine["cert_hash"]  # type: ignore[index]
    )


def _cert_key(vault_id: int, cert_hash: str) -> str:
    return f"{vault_id}:{cert_hash}"


def _valid_commitment(s: str) -> bool:
    return isinstance(s, str) and _HEX64.match(s) is not None


def _split_shares(principal: int, shares_bps: list) -> list:
    """Deterministic zero-dust split. floor(principal*bps/10000) per heir; the
    whole integer remainder is added to heir index 0 so sum == principal."""
    amounts = [(principal * int(b)) // BPS_TOTAL for b in shares_bps]
    amounts[0] += principal - sum(amounts)
    return amounts


# ============================================================================
# Storage schema
# ============================================================================
@allow_storage
@dataclass
class Vault:
    owner: Address
    identity_commitment: str
    principal: u256
    created_at: u256
    last_heartbeat: u256
    inactivity_threshold: u256
    state: u256
    beneficiary_count: u256
    executor_hex: str  # "" == none
    claimant: Address
    claim_bond: u256
    claim_started_at: u256
    veto_until: u256
    cert_epoch: u256
    verify_attempts: u256
    finalized_at: u256
    cert_hash: str  # certificate hash that opened the current veto window


@allow_storage
@dataclass
class Beneficiary:
    addr: Address
    bps: u256
    note_ref: str  # opaque pointer to an encrypted key-shard / note
    amount: u256  # fixed at finalize_succession
    claimed: bool


class LegacyVault(gl.contract.Contract):
    vaults: TreeMap[u256, Vault]
    # slot = vault_id * 8 + heir_index  (heir_index < MAX_BENEFICIARIES < 8)
    beneficiaries: TreeMap[u256, Beneficiary]
    next_vault_id: u256
    escrowed: u256  # every wei the contract is liable for
    governor: Address
    registry_url: TreeMap[u256, str]  # slot 0..2 -> active registry base URL
    registry_pending_url: TreeMap[u256, str]
    registry_pending_at: TreeMap[u256, u256]  # activation epoch (0 == none)
    # "<vault_id>:<cert_hash>" -> True once a living owner vetoed that certificate
    invalidated_certs: TreeMap[str, bool]
    # address hex -> ids of vaults it owns / is an heir of / executes. Lets the
    # UI load one account's vaults without walking the whole vault history.
    account_vaults: TreeMap[str, DynArray[u256]]

    def __init__(self, registry_a: str, registry_b: str, registry_c: str):
        urls = [registry_a, registry_b, registry_c]
        hosts = []
        for u in urls:
            if not _valid_registry_base(u):
                _fail(ERR_INPUT, "registry base URL must be https://<dns-name>[/path]")
            hosts.append(_registry_host(u))
        if len(set(hosts)) != REGISTRY_COUNT:
            _fail(ERR_INPUT, "registries must live on independent hosts")
        for i in range(REGISTRY_COUNT):
            self.registry_url[i] = urls[i]
            self.registry_pending_at[i] = 0
            self.registry_pending_url[i] = ""
        self.next_vault_id = 1
        self.escrowed = 0
        self.governor = gl.message.sender_address

    # ------------------------------------------------------------------ views
    @gl.public.view
    def get_protocol_overview(self) -> dict:
        return {
            "vault_count": str(int(self.next_vault_id) - 1),
            "escrowed": str(self.escrowed),
            "balance": str(self.balance),
            "solvent": self.balance >= self.escrowed,
            "governor": self.governor.as_hex,
            "registries": self.get_registries(),
            "constants": {
                "min_inactivity_seconds": MIN_INACTIVITY,
                "max_inactivity_seconds": MAX_INACTIVITY,
                "veto_window_seconds": VETO_WINDOW,
                "claim_verify_window_seconds": CLAIM_VERIFY_WINDOW,
                "registry_timelock_seconds": REGISTRY_TIMELOCK,
                "min_deposit": str(MIN_DEPOSIT),
                "min_claim_bond": str(MIN_CLAIM_BOND),
                "claim_bond_bps": CLAIM_BOND_BPS,
                "min_sources": MIN_SOURCES,
                "max_beneficiaries": MAX_BENEFICIARIES,
            },
        }

    @gl.public.view
    def get_registries(self) -> list:
        out = []
        for i in range(REGISTRY_COUNT):
            url = self.registry_url[i]
            out.append(
                {
                    "index": i,
                    "base_url": url,
                    "host": _registry_host(url),
                    "pending_url": self.registry_pending_url[i],
                    "pending_at": int(self.registry_pending_at[i]),
                }
            )
        return out

    @gl.public.view
    def whoami(self) -> str:
        return gl.message.sender_address.as_hex

    @gl.public.view
    def required_claim_bond(self, vault_id: u256) -> str:
        v = self._vault(vault_id)
        return str(self._required_bond(int(v.principal)))

    @gl.public.view
    def get_vault(self, vault_id: u256) -> dict:
        return self._vault_view(vault_id, True)

    @gl.public.view
    def get_vault_ids_for(self, address_hex: str) -> list:
        """Ids of every vault this address owns, is a beneficiary of, or
        executes. O(1) in the number of vaults overall: this is what lets a
        panel load one account's vaults without traversing history."""
        key = address_hex.strip()
        if not re.match(r"^0x[0-9a-fA-F]{40}$", key):
            return []
        key = Address(key).as_hex
        if key not in self.account_vaults:
            return []
        out = []
        arr = self.account_vaults[key]
        for i in range(len(arr)):
            out.append(int(arr[i]))
        return out

    @gl.public.view
    def is_certificate_invalidated(self, vault_id: u256, cert_hash: str) -> bool:
        return self._is_invalidated(int(vault_id), cert_hash.strip().lower())

    @gl.public.view
    def get_vault_summaries(self, start: u256, count: u256) -> list:
        """Compact page of vaults [start, start+count). Heir rows carry no
        note references. Capped at 25 per call."""
        out = []
        n = int(count)
        if n > 25:
            n = 25
        total = int(self.next_vault_id)
        i = int(start)
        if i < 1:
            i = 1
        while i < total and len(out) < n:
            out.append(self._vault_view(i, False))
            i += 1
        return out

    # ----------------------------------------------------------------- writes
    @gl.public.write.payable
    def create_vault(
        self,
        identity_commitment: str,
        inactivity_days: int,
        beneficiaries: list,
        shares_bps: list,
        note_refs: list,
        executor: str,
    ) -> int:
        """Lock the attached GEN as an estate. `identity_commitment` is the
        lower-case hex SHA-256 of `full_name|birth_date|jurisdiction_id`."""
        value = int(gl.message.value)
        if value <= 0:
            _fail(ERR_INPUT, "deposit must be greater than zero")
        if value < MIN_DEPOSIT:
            _fail(ERR_INPUT, "deposit below the protocol minimum")
        commitment = identity_commitment.strip().lower() if isinstance(identity_commitment, str) else ""
        if not _valid_commitment(commitment):
            _fail(ERR_INPUT, "identity_commitment must be a 64-char hex SHA-256")
        if not _is_int(inactivity_days) or inactivity_days < 0:
            _fail(ERR_INPUT, "inactivity_days must be a non-negative integer")
        threshold = inactivity_days * DAY
        if threshold < MIN_INACTIVITY or threshold > MAX_INACTIVITY:
            _fail(ERR_INPUT, "inactivity window must be between 90 and 3650 days")

        if not (isinstance(beneficiaries, list) and isinstance(shares_bps, list) and isinstance(note_refs, list)):
            _fail(ERR_INPUT, "beneficiaries, shares_bps and note_refs must be lists")
        n = len(beneficiaries)
        if n < 1 or n > MAX_BENEFICIARIES:
            _fail(ERR_INPUT, "between 1 and 5 beneficiaries required")
        if len(shares_bps) != n or len(note_refs) != n:
            _fail(ERR_INPUT, "beneficiaries, shares_bps and note_refs must be the same length")

        owner = gl.message.sender_address
        seen = set()
        addrs = []
        total_bps = 0
        for i in range(n):
            b = shares_bps[i]
            if not _is_int(b) or b <= 0 or b > BPS_TOTAL:
                _fail(ERR_INPUT, "each share must be an integer in 1..10000 bps")
            total_bps += b
            note = note_refs[i]
            if not isinstance(note, str) or len(note) > MAX_NOTE_LEN:
                _fail(ERR_INPUT, "note reference must be a string of at most 512 chars")
            a = self._parse_address(beneficiaries[i])
            if a == owner:
                _fail(ERR_INPUT, "the owner cannot be a beneficiary")
            if a.as_hex in seen:
                _fail(ERR_INPUT, "duplicate beneficiary")
            seen.add(a.as_hex)
            addrs.append(a)
        if total_bps != BPS_TOTAL:
            _fail(ERR_INPUT, "shares must sum to exactly 10000 bps")

        executor_hex = ""
        if isinstance(executor, str) and executor.strip() != "":
            ex = self._parse_address(executor)
            if ex == owner:
                _fail(ERR_INPUT, "the owner cannot be the executor")
            executor_hex = ex.as_hex

        vid = int(self.next_vault_id)
        self.next_vault_id = vid + 1
        now = self._now()
        self.vaults[vid] = Vault(
            owner=owner,
            identity_commitment=commitment,
            principal=value,
            created_at=now,
            last_heartbeat=now,
            inactivity_threshold=threshold,
            state=ST_ACTIVE,
            beneficiary_count=n,
            executor_hex=executor_hex,
            claimant=owner,
            claim_bond=0,
            claim_started_at=0,
            veto_until=0,
            cert_epoch=0,
            verify_attempts=0,
            finalized_at=0,
            cert_hash="",
        )
        for i in range(n):
            self.beneficiaries[vid * 8 + i] = Beneficiary(
                addr=addrs[i], bps=shares_bps[i], note_ref=note_refs[i], amount=0, claimed=False
            )
        self._index_vault(owner.as_hex, vid)
        for a in addrs:
            self._index_vault(a.as_hex, vid)
        if executor_hex != "":
            self._index_vault(executor_hex, vid)
        self.escrowed += value
        return vid

    @gl.public.write
    def heartbeat(self, vault_id: u256) -> None:
        """Owner proof of life. Resets the inactivity clock and, if a claim is
        open, cancels it and confiscates the claimant's bond to the owner."""
        v = self._vault(vault_id)
        self._only_owner(v)
        st = int(v.state)
        if st not in (ST_ACTIVE, ST_CLAIM_INITIATED, ST_VETO_PERIOD):
            _fail(ERR_STATE, "vault is closed")
        slashed = self._cancel_open_claim(int(vault_id), v)
        v.last_heartbeat = self._now()
        self.vaults[vault_id] = v
        if slashed > 0:
            self._pay(v.owner, slashed)

    @gl.public.write
    def veto_claim(self, vault_id: u256) -> None:
        """Owner cancels an open claim (before or after verification) and takes
        100% of the claimant's bond. Also resets the inactivity clock."""
        v = self._vault(vault_id)
        self._only_owner(v)
        if int(v.state) not in (ST_CLAIM_INITIATED, ST_VETO_PERIOD):
            _fail(ERR_STATE, "no open claim to veto")
        slashed = self._cancel_open_claim(int(vault_id), v)
        v.last_heartbeat = self._now()
        self.vaults[vault_id] = v
        self._pay(v.owner, slashed)

    @gl.public.write
    def revoke_vault(self, vault_id: u256) -> None:
        """Owner withdraws the whole estate (and any open claimant's bond)
        so long as no succession has been finalized."""
        v = self._vault(vault_id)
        self._only_owner(v)
        if int(v.state) not in (ST_ACTIVE, ST_CLAIM_INITIATED, ST_VETO_PERIOD):
            _fail(ERR_STATE, "vault is closed")
        slashed = self._cancel_open_claim(int(vault_id), v)
        payout = int(v.principal) + slashed
        self.escrowed -= int(v.principal)
        v.principal = 0
        v.state = ST_REVOKED
        v.last_heartbeat = self._now()
        self.vaults[vault_id] = v
        self._pay(v.owner, payout)

    @gl.public.write.payable
    def initiate_claim(self, vault_id: u256) -> None:
        """A registered heir (or the designated executor) stakes a bond to
        open a succession claim once the inactivity window has elapsed."""
        v = self._vault(vault_id)
        if int(v.state) != ST_ACTIVE:
            _fail(ERR_STATE, "vault already has an open claim or is closed")
        sender = gl.message.sender_address
        if not self._is_claimant_eligible(vault_id, v, sender):
            _fail(ERR_AUTH, "only a registered beneficiary or the executor may claim")
        now = self._now()
        if now < int(v.last_heartbeat) + int(v.inactivity_threshold):
            _fail(ERR_TIME, "inactivity threshold has not elapsed")
        bond = int(gl.message.value)
        if bond < self._required_bond(int(v.principal)):
            _fail(ERR_BOND, "claim bond below max(floor, 10% of principal)")
        v.state = ST_CLAIM_INITIATED
        v.claimant = sender
        v.claim_bond = bond
        v.claim_started_at = now
        v.veto_until = 0
        v.cert_epoch = 0
        self.vaults[vault_id] = v
        self.escrowed += bond

    @gl.public.write
    def verify_claim(self, vault_id: u256) -> int:
        """Claimant triggers the 3-registry death-record check.

        Returns the verdict: 0 NO_RECORD (claim rejected, bond forfeited to the
        estate), 1 VERIFIED_DECEASED (30-day veto window opens), 2 QUORUM_FAILURE
        (fewer than 2 registries answered; nothing is slashed, retry later)."""
        v = self._vault(vault_id)
        if int(v.state) != ST_CLAIM_INITIATED:
            _fail(ERR_STATE, "no claim awaiting verification")
        if gl.message.sender_address != v.claimant:
            _fail(ERR_AUTH, "only the claimant may trigger verification")

        # Plain locals only: nothing inside the nondet closures touches self.
        commitment = v.identity_commitment
        creation_day = (int(v.created_at) // DAY) * DAY
        last_heartbeat = int(v.last_heartbeat)
        now = self._now()
        bases = [self.registry_url[i] for i in range(REGISTRY_COUNT)]

        def leader_fn() -> dict:
            results = [_fetch_source(b, commitment, creation_day, now, last_heartbeat) for b in bases]
            return _aggregate(results)

        def validator_fn(leaders_res) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            theirs = leaders_res.calldata
            if not _payload_well_formed(theirs):
                return False
            mine = leader_fn()
            return _payloads_agree(theirs, mine)

        payload = gl.vm.run_nondet(leader_fn, validator_fn)
        # Defence in depth: the decided payload is re-gated before it can touch
        # state, so even a harness that skips validation cannot persist junk.
        if not _payload_well_formed(payload):
            _fail(ERR_STATE, "malformed registry payload")
        verdict = int(payload["verdict"])

        v.verify_attempts = int(v.verify_attempts) + 1
        cert_hash = str(payload["cert_hash"])
        if verdict == V_VERIFIED_DECEASED and self._is_invalidated(int(vault_id), cert_hash):
            # The owner already vetoed this exact certificate on this vault, which
            # proved them alive after it was issued. Presenting it again is a
            # rejected claim: same consequence as NO_RECORD, bond joins the estate.
            verdict = V_NO_RECORD
        if verdict == V_VERIFIED_DECEASED:
            v.state = ST_VETO_PERIOD
            v.veto_until = now + VETO_WINDOW
            v.cert_epoch = int(payload["cert_epoch"])
            v.cert_hash = cert_hash
        elif verdict == V_NO_RECORD:
            # Bond forfeited into the estate: a failed lookup proves nothing
            # about whether the owner is alive, so the penalty stays with the
            # vault (owner via revoke, heirs via succession) rather than
            # vanishing into a possibly-dead owner's account.
            bond = int(v.claim_bond)
            v.principal = int(v.principal) + bond
            v.claim_bond = 0
            v.claimant = v.owner
            v.state = ST_ACTIVE
            v.claim_started_at = 0
        # V_QUORUM_FAILURE: state unchanged, bond intact, retryable.
        self.vaults[vault_id] = v
        return verdict

    @gl.public.write
    def withdraw_claim(self, vault_id: u256) -> None:
        """Claimant abandons a not-yet-verified claim and reclaims the full
        bond. Once the death record is verified the claim is committed."""
        v = self._vault(vault_id)
        if int(v.state) != ST_CLAIM_INITIATED:
            _fail(ERR_STATE, "claim is not awaiting verification")
        if gl.message.sender_address != v.claimant:
            _fail(ERR_AUTH, "only the claimant may withdraw")
        self._release_claim_bond(vault_id, v)

    @gl.public.write
    def expire_claim(self, vault_id: u256) -> None:
        """Anyone may unwind a claim left unverified for CLAIM_VERIFY_WINDOW,
        returning the bond (no slash) so the vault cannot be frozen."""
        v = self._vault(vault_id)
        if int(v.state) != ST_CLAIM_INITIATED:
            _fail(ERR_STATE, "claim is not awaiting verification")
        if self._now() < int(v.claim_started_at) + CLAIM_VERIFY_WINDOW:
            _fail(ERR_TIME, "claim verification window still open")
        self._release_claim_bond(vault_id, v)

    @gl.public.write
    def finalize_succession(self, vault_id: u256) -> None:
        """After the veto window closes, unlock the estate and refund the
        honest claimant's bond. Permissionless."""
        v = self._vault(vault_id)
        if int(v.state) != ST_VETO_PERIOD:
            _fail(ERR_STATE, "vault is not in the veto challenge period")
        now = self._now()
        if now < int(v.veto_until):
            _fail(ERR_TIME, "veto window still open")
        n = int(v.beneficiary_count)
        base = int(vault_id) * 8
        shares = [int(self.beneficiaries[base + i].bps) for i in range(n)]
        amounts = _split_shares(int(v.principal), shares)
        for i in range(n):
            b = self.beneficiaries[base + i]
            b.amount = amounts[i]
            self.beneficiaries[base + i] = b
        bond = int(v.claim_bond)
        claimant = v.claimant
        v.claim_bond = 0
        v.state = ST_SUCCEEDED
        v.finalized_at = now
        self.vaults[vault_id] = v
        self.escrowed -= bond
        if bond > 0:
            self._pay(claimant, bond)

    @gl.public.write
    def claim_inheritance(self, vault_id: u256) -> str:
        """An heir pulls their exact allocation. Returns the encrypted
        key-shard / note reference registered for that heir."""
        v = self._vault(vault_id)
        if int(v.state) != ST_SUCCEEDED:
            _fail(ERR_STATE, "succession not finalized")
        sender = gl.message.sender_address
        base = int(vault_id) * 8
        idx = -1
        for i in range(int(v.beneficiary_count)):
            if self.beneficiaries[base + i].addr == sender:
                idx = i
                break
        if idx < 0:
            _fail(ERR_AUTH, "caller is not a beneficiary of this vault")
        b = self.beneficiaries[base + idx]
        if b.claimed:
            _fail(ERR_NOTHING, "allocation already claimed")
        amount = int(b.amount)
        b.claimed = True
        self.beneficiaries[base + idx] = b
        self.escrowed -= amount
        if amount > 0:
            self._pay(sender, amount)
        return b.note_ref

    # ------------------------------------------------- registry governance
    @gl.public.write
    def propose_registry(self, index: int, base_url: str) -> None:
        """Governor stages a registry rotation. It only takes effect after
        REGISTRY_TIMELOCK, giving owners a window to react. Neither the URL nor
        its host may match ANY other slot, active or staged."""
        if gl.message.sender_address != self.governor:
            _fail(ERR_AUTH, "governor only")
        if not _is_int(index) or index < 0 or index >= REGISTRY_COUNT:
            _fail(ERR_INPUT, "registry index out of range")
        if not _valid_registry_base(base_url):
            _fail(ERR_INPUT, "registry base URL must be https://<dns-name>[/path]")
        self._assert_registry_unique(index, base_url, include_pending=True)
        self.registry_pending_url[index] = base_url
        self.registry_pending_at[index] = self._now() + REGISTRY_TIMELOCK

    @gl.public.write
    def activate_registry(self, index: int) -> None:
        """Permissionless: apply a staged rotation once its timelock elapsed.
        Uniqueness is re-checked against the slots as they are NOW."""
        if not _is_int(index) or index < 0 or index >= REGISTRY_COUNT:
            _fail(ERR_INPUT, "registry index out of range")
        at = int(self.registry_pending_at[index])
        if at == 0:
            _fail(ERR_STATE, "no pending rotation")
        if self._now() < at:
            _fail(ERR_TIME, "registry timelock still running")
        url = self.registry_pending_url[index]
        self._assert_registry_unique(index, url, include_pending=False)
        self.registry_url[index] = url
        self.registry_pending_url[index] = ""
        self.registry_pending_at[index] = 0

    @gl.public.write
    def cancel_registry_rotation(self, index: int) -> None:
        if gl.message.sender_address != self.governor:
            _fail(ERR_AUTH, "governor only")
        if not _is_int(index) or index < 0 or index >= REGISTRY_COUNT:
            _fail(ERR_INPUT, "registry index out of range")
        self.registry_pending_url[index] = ""
        self.registry_pending_at[index] = 0

    @gl.public.write
    def transfer_governor(self, new_governor: str) -> None:
        if gl.message.sender_address != self.governor:
            _fail(ERR_AUTH, "governor only")
        self.governor = self._parse_address(new_governor)

    # ------------------------------------------------------------ internals
    def _now(self) -> int:
        # Inside GenVM datetime.now() is the transaction timestamp; the direct
        # harness patches it identically so warp() controls it.
        return int(datetime.now(timezone.utc).timestamp())

    def _assert_registry_unique(self, index: int, url: str, include_pending: bool) -> None:
        """A URL and a host may each occupy at most one slot. Compares against
        every OTHER slot's active endpoint and (when staging) its pending one."""
        host = _registry_host(url)
        for j in range(REGISTRY_COUNT):
            if j == index:
                continue
            others = [self.registry_url[j]]
            if include_pending and int(self.registry_pending_at[j]) != 0:
                others.append(self.registry_pending_url[j])
            for other in others:
                if other == url or _registry_host(other) == host:
                    _fail(ERR_INPUT, f"registry duplicates slot {j}: URL and host must be unique per slot")

    def _index_vault(self, key: str, vault_id: int) -> None:
        self.account_vaults.get_or_insert_default(key).append(vault_id)

    def _is_invalidated(self, vault_id: int, cert_hash: str) -> bool:
        return cert_hash != "" and _cert_key(vault_id, cert_hash) in self.invalidated_certs

    def _vault(self, vault_id: u256) -> Vault:
        if vault_id not in self.vaults:
            _fail(ERR_NOT_FOUND, "unknown vault")
        return self.vaults[vault_id]

    def _only_owner(self, v: Vault) -> None:
        if gl.message.sender_address != v.owner:
            _fail(ERR_AUTH, "only the vault owner may do this")

    def _parse_address(self, raw: object) -> Address:
        if not isinstance(raw, str):
            _fail(ERR_INPUT, "address must be a hex string")
        s = raw.strip()
        if not re.match(r"^0x[0-9a-fA-F]{40}$", s):
            _fail(ERR_INPUT, "address must be 0x + 40 hex chars")
        a = Address(s)
        if int.from_bytes(a.as_bytes, "big") == 0:
            _fail(ERR_INPUT, "zero address not allowed")
        return a

    def _required_bond(self, principal: int) -> int:
        pct = (principal * CLAIM_BOND_BPS + BPS_TOTAL - 1) // BPS_TOTAL  # ceil
        return pct if pct > MIN_CLAIM_BOND else MIN_CLAIM_BOND

    def _is_claimant_eligible(self, vault_id: u256, v: Vault, who: Address) -> bool:
        if v.executor_hex != "" and who.as_hex == v.executor_hex:
            return True
        base = int(vault_id) * 8
        for i in range(int(v.beneficiary_count)):
            if self.beneficiaries[base + i].addr == who:
                return True
        return False

    def _cancel_open_claim(self, vault_id: int, v: Vault) -> int:
        """Reset claim fields on `v` (caller persists it). Returns the bond
        confiscated for the owner (0 when no claim was open) and debits
        escrow for it; the caller is responsible for paying it out."""
        st = int(v.state)
        if st not in (ST_CLAIM_INITIATED, ST_VETO_PERIOD):
            return 0
        bond = int(v.claim_bond)
        if st == ST_VETO_PERIOD and v.cert_hash != "":
            # Veto / heartbeat / revoke during the challenge period: the
            # certificate that opened it can never open another claim on THIS
            # vault.
            self.invalidated_certs[_cert_key(vault_id, v.cert_hash)] = True
        v.state = ST_ACTIVE
        v.claim_bond = 0
        v.claimant = v.owner
        v.claim_started_at = 0
        v.veto_until = 0
        v.cert_epoch = 0
        v.cert_hash = ""
        self.escrowed -= bond
        return bond

    def _release_claim_bond(self, vault_id: u256, v: Vault) -> None:
        bond = int(v.claim_bond)
        claimant = v.claimant
        v.state = ST_ACTIVE
        v.claim_bond = 0
        v.claimant = v.owner
        v.claim_started_at = 0
        self.vaults[vault_id] = v
        self.escrowed -= bond
        if bond > 0:
            self._pay(claimant, bond)

    def _pay(self, to: Address, amount: int) -> None:
        """Checks-effects-interactions: every caller has already applied its
        state change. A synchronous enqueue failure reverts the whole call so no
        accounting change survives without its transfer."""
        if amount <= 0:
            return
        try:
            gl.chain.Account(to).emit_transfer(amount, on="finalized")
        except Exception:
            _fail(ERR_TRANSFER)

    def _vault_view(self, vault_id: u256, with_notes: bool) -> dict:
        v = self._vault(vault_id)
        st = int(v.state)
        n = int(v.beneficiary_count)
        base = int(vault_id) * 8
        heirs = []
        for i in range(n):
            b = self.beneficiaries[base + i]
            # Note references are withheld until the estate is finalized. This is
            # a UX gate, not secrecy: contract storage is public, so the
            # reference MUST already be ciphertext or a pointer to ciphertext.
            reveal = with_notes and st == ST_SUCCEEDED
            heirs.append(
                {
                    "address": b.addr.as_hex,
                    "bps": int(b.bps),
                    "amount": str(b.amount),
                    "claimed": bool(b.claimed),
                    "note_ref": b.note_ref if reveal else "",
                }
            )
        has_claim = st in (ST_CLAIM_INITIATED, ST_VETO_PERIOD)
        return {
            "vault_id": int(vault_id),
            "owner": v.owner.as_hex,
            "identity_commitment": v.identity_commitment,
            "principal": str(v.principal),
            "state": st,
            "state_name": STATE_NAMES[st],
            "created_at": int(v.created_at),
            "last_heartbeat": int(v.last_heartbeat),
            "inactivity_threshold": int(v.inactivity_threshold),
            "claimable_at": int(v.last_heartbeat) + int(v.inactivity_threshold),
            "executor": v.executor_hex,
            "claimant": v.claimant.as_hex if has_claim else "",
            "claim_bond": str(v.claim_bond),
            "claim_started_at": int(v.claim_started_at),
            "veto_until": int(v.veto_until),
            "cert_epoch": int(v.cert_epoch),
            "cert_hash": v.cert_hash,
            "verify_attempts": int(v.verify_attempts),
            "finalized_at": int(v.finalized_at),
            "required_bond": str(self._required_bond(int(v.principal))),
            "beneficiaries": heirs,
        }

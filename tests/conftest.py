"""Shared helpers for LegacyVault direct-mode tests.

Uses the genlayer-test pytest plugin fixtures: direct_vm, direct_deploy,
direct_alice, direct_bob, direct_charlie, direct_owner.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

# The contract pins runner py-genlayer:5jycge4q...; the newest cached GenVM
# bundle (rc9) no longer ships it, rc8 does. Pin before the harness resolves it.
os.environ.setdefault("GENVM_VERSION", "v0.6.0-rc8")

sys.path.insert(0, os.path.dirname(__file__))

CONTRACT = "contracts/legacy_vault.py"

GEN = 10**18
DAY = 86_400
VETO = 30 * DAY
MIN_DEPOSIT = 10**15
MIN_BOND = 10**15

REG_A = "https://civil-registry-a.vitalrecords.org/v1/records"
REG_B = "https://civil-registry-b.deathindex.net/records"
REG_C = "https://civil-registry-c.statevitals.gov/mirror"
REGISTRIES = (REG_A, REG_B, REG_C)
HOST_PATTERNS = (r"civil-registry-a\.vitalrecords\.org", r"civil-registry-b\.deathindex\.net", r"civil-registry-c\.statevitals\.gov")

T0 = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
SCHEMA = "legacyvault.vital-record/v1"
CERT = "ab" * 32


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def at(days: float = 0, seconds: int = 0) -> str:
    return iso(T0 + timedelta(days=days, seconds=seconds))


def epoch_of(dt: datetime) -> int:
    return int(dt.timestamp())


def day_epoch(date_str: str) -> int:
    y, m, d = (int(x) for x in date_str.split("-"))
    return int(datetime(y, m, d, tzinfo=timezone.utc).timestamp())


def commitment(name="Ada Lovelace", birth="1815-12-10", jurisdiction="GB-LND") -> str:
    """SHA-256 of `full_name|birth_date|jurisdiction_id` (normalized as the
    frontend does: whitespace-collapsed lower-case name, upper-case jurisdiction)."""
    n = " ".join(name.split()).lower()
    return hashlib.sha256(f"{n}|{birth}|{jurisdiction.strip().upper()}".encode()).hexdigest()


def record(commit: str, **over) -> dict:
    r = {
        "schema": SCHEMA,
        "identity_commitment": commit,
        "status": "CONFIRMED",
        "certificate_hash": CERT,
        "date_of_death": "2026-02-10",
    }
    r.update(over)
    return r


def _resp(spec):
    """spec: dict -> 200 JSON; int -> bare status; str -> 200 raw body."""
    if isinstance(spec, dict):
        return {"status": 200, "body": json.dumps(spec)}
    if isinstance(spec, int):
        return {"status": spec, "body": ""}
    return {"status": 200, "body": spec}


def mock_registries(vm, a, b, c):
    vm.clear_mocks()
    for pat, spec in zip(HOST_PATTERNS, (a, b, c)):
        vm.mock_web(pat, _resp(spec))


def hexof(contract, vm, who) -> str:
    prev = getattr(vm, "sender", None)
    vm.sender = who
    k = contract.whoami()
    if prev is not None:
        vm.sender = prev
    return k


class Env:
    """Bundles a deployed contract with convenience flows."""

    def __init__(self, c, vm, alice, bob, charlie, owner):
        self.c, self.vm = c, vm
        self.alice, self.bob, self.charlie, self.owner = alice, bob, charlie, owner
        self.hex = {
            "alice": hexof(c, vm, alice),
            "bob": hexof(c, vm, bob),
            "charlie": hexof(c, vm, charlie),
            "owner": hexof(c, vm, owner),
        }
        self.commit = commitment()

    def fund(self, who, amount=1000 * GEN):
        try:
            self.vm.deal(who, amount)
        except Exception:
            pass

    def create(self, *, value=10 * GEN, days=90, heirs=None, notes=None, executor="", commit=None, sender=None):
        """heirs: list of (who_key, bps). Defaults: bob 6000 / charlie 4000."""
        heirs = heirs or [("bob", 6000), ("charlie", 4000)]
        addrs = [self.hex[k] for k, _ in heirs]
        bps = [b for _, b in heirs]
        notes = notes or [f"ipfs://cipher-{k}" for k, _ in heirs]
        who = sender or self.owner
        self.fund(who)
        self.vm.sender = who
        self.vm.value = value
        try:
            vid = self.c.create_vault(self.commit if commit is None else commit, days, addrs, bps, notes, executor)
        finally:
            self.vm.value = 0
        return vid

    def claim(self, vid, who=None, value=None):
        who = who or self.bob
        self.fund(who)
        self.vm.sender = who
        self.vm.value = int(self.c.required_claim_bond(vid)) if value is None else value
        try:
            self.c.initiate_claim(vid)
        finally:
            self.vm.value = 0

    def verify(self, vid, who=None):
        self.vm.sender = who or self.bob
        return self.c.verify_claim(vid)

    def all_confirmed(self, **over):
        r = record(self.commit, **over)
        mock_registries(self.vm, r, r, r)

    def warp(self, days):
        self.vm.warp(at(days))

    def to_veto(self, *, vid=None, days_idle=100, bond_who=None):
        """create -> idle -> claim -> verify (3/3). Returns vault id."""
        vid = vid or self.create()
        self.warp(days_idle)
        self.claim(vid, bond_who)
        self.all_confirmed()
        assert self.verify(vid, bond_who or self.bob) == 1
        return vid


@pytest.fixture
def env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner):
    direct_vm.warp(at(0))
    direct_vm.sender = direct_owner
    c = direct_deploy(CONTRACT, *REGISTRIES)
    return Env(c, direct_vm, direct_alice, direct_bob, direct_charlie, direct_owner)


@pytest.fixture
def transfers(monkeypatch):
    """Record every gl.chain.Account(...).emit_transfer: list of (hex, amount)."""
    log = []

    class _Rec:
        def __init__(self, addr):
            self.addr = addr

        def emit_transfer(self, amount, **kwargs):
            h = getattr(self.addr, "as_hex", None) or str(self.addr)
            log.append((h.lower(), int(amount)))

    import genlayer.chain as chain_mod

    monkeypatch.setattr(chain_mod, "Account", _Rec)
    return log

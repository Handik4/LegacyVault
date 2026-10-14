"""LegacyVault direct-mode suite: lifecycle, consensus, adversarial regressions.

Direct mode executes the leader function; validator logic is exercised through
`direct_vm.run_validator(...)`, which replays the captured validator closure
against forged / malformed leader payloads.

Run: .venv/bin/python -m pytest -q
"""

import json

import pytest

from conftest import (
    CERT, DAY, GEN, MIN_BOND, MIN_DEPOSIT, REG_A, REG_B, REG_C, REGISTRIES, T0, VETO,
    at, commitment, day_epoch, mock_registries, record,
)

BAD_INPUT = "ERR_INVALID_INPUT"
BAD_STATE = "ERR_INVALID_STATE"
UNAUTH = "ERR_UNAUTHORIZED"
EARLY = "ERR_TOO_EARLY"
BOND_ERR = "ERR_INSUFFICIENT_BOND"


def total_to(log, who_hex):
    return sum(a for h, a in log if h == who_hex.lower())


# =========================================================== creation & input
class TestCreation:
    def test_create_vault_happy_path(self, env):
        vid = env.create(value=10 * GEN, days=120)
        v = env.c.get_vault(vid)
        assert vid == 1
        assert v["owner"] == env.hex["owner"]
        assert v["principal"] == str(10 * GEN)
        assert v["state_name"] == "ACTIVE"
        assert v["identity_commitment"] == env.commit
        assert v["inactivity_threshold"] == 120 * DAY
        assert v["claimable_at"] == v["last_heartbeat"] + 120 * DAY
        assert [b["bps"] for b in v["beneficiaries"]] == [6000, 4000]
        assert env.c.get_protocol_overview()["escrowed"] == str(10 * GEN)

    def test_vault_ids_increment_and_summaries_paginate(self, env):
        for _ in range(3):
            env.create()
        s = env.c.get_vault_summaries(1, 2)
        assert [x["vault_id"] for x in s] == [1, 2]
        assert [x["vault_id"] for x in env.c.get_vault_summaries(3, 10)] == [3]
        assert env.c.get_vault_summaries(99, 5) == []
        assert env.c.get_protocol_overview()["vault_count"] == "3"

    def test_summaries_are_capped_at_25(self, env):
        for _ in range(27):
            env.create(value=MIN_DEPOSIT)
        assert len(env.c.get_vault_summaries(1, 1000)) == 25

    def test_bps_must_sum_to_10000_when_short(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(heirs=[("bob", 6000), ("charlie", 3999)])

    def test_bps_must_sum_to_10000_when_over(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(heirs=[("bob", 6000), ("charlie", 4001)])

    def test_single_beneficiary_full_share(self, env):
        vid = env.create(heirs=[("bob", 10000)])
        assert env.c.get_vault(vid)["beneficiaries"][0]["bps"] == 10000

    def test_zero_beneficiaries_rejected(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.vm.sender = env.owner
            env.vm.value = GEN
            env.c.create_vault(env.commit, 90, [], [], [], "")

    def test_six_beneficiaries_rejected(self, env):
        six = [env.hex["alice"], env.hex["bob"], env.hex["charlie"]] + [
            "0x" + f"{i:040x}" for i in (101, 102, 103)
        ]
        with env.vm.expect_revert(BAD_INPUT):
            env.vm.sender = env.owner
            env.vm.value = GEN
            env.c.create_vault(env.commit, 90, six, [2000, 2000, 2000, 2000, 1000, 1000], [""] * 6, "")

    def test_five_beneficiaries_accepted(self, env):
        five = [env.hex["alice"], env.hex["bob"], env.hex["charlie"]] + ["0x" + f"{i:040x}" for i in (101, 102)]
        env.vm.sender = env.owner
        env.vm.value = GEN
        vid = env.c.create_vault(env.commit, 90, five, [2000] * 5, [""] * 5, "")
        assert len(env.c.get_vault(vid)["beneficiaries"]) == 5

    def test_duplicate_beneficiary_rejected(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(heirs=[("bob", 5000), ("bob", 5000)])

    def test_owner_cannot_be_beneficiary(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(heirs=[("owner", 5000), ("bob", 5000)])

    @pytest.mark.parametrize("bad", [0, -1, -6000, 10001])
    def test_share_out_of_range_rejected(self, env, bad):
        with env.vm.expect_revert(BAD_INPUT):
            env.vm.sender = env.owner
            env.vm.value = GEN
            env.c.create_vault(env.commit, 90, [env.hex["bob"], env.hex["charlie"]], [bad, 10000 - bad], ["", ""], "")

    def test_strict_input_validation_blocks_negative_or_zero_deposits(self, env):
        env.vm.sender = env.owner
        for value in (0, 1, MIN_DEPOSIT - 1):
            env.vm.value = value
            with env.vm.expect_revert(BAD_INPUT):
                env.c.create_vault(env.commit, 90, [env.hex["bob"]], [10000], [""], "")
        # A negative attached value cannot be represented by the unsigned
        # message value; the harness must reject it before the contract runs.
        env.vm.value = -1
        with pytest.raises(Exception):
            env.c.create_vault(env.commit, 90, [env.hex["bob"]], [10000], [""], "")
        env.vm.value = 0
        assert env.c.get_protocol_overview()["vault_count"] == "0"

    def test_minimum_deposit_accepted(self, env):
        assert env.create(value=MIN_DEPOSIT) == 1

    @pytest.mark.parametrize("days", [-90, -1, 0, 1, 89])
    def test_inactivity_below_90_days_rejected(self, env, days):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(days=days)

    def test_inactivity_above_ten_years_rejected(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(days=3651)

    def test_inactivity_bounds_inclusive(self, env):
        env.create(days=90)
        env.create(days=3650)

    @pytest.mark.parametrize("bad", ["", "abc", "z" * 64, "a" * 63, "a" * 65, "0x" + "a" * 62])
    def test_malformed_identity_commitment_rejected(self, env, bad):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(commit=bad)

    def test_uppercase_commitment_is_normalized(self, env):
        vid = env.create(commit=env.commit.upper())
        assert env.c.get_vault(vid)["identity_commitment"] == env.commit

    @pytest.mark.parametrize("bad", ["", "bob", "0x1234", "0x" + "g" * 40, "0x" + "0" * 40])
    def test_malformed_or_zero_beneficiary_address_rejected(self, env, bad):
        with env.vm.expect_revert(BAD_INPUT):
            env.vm.sender = env.owner
            env.vm.value = GEN
            env.c.create_vault(env.commit, 90, [bad], [10000], [""], "")

    def test_mismatched_list_lengths_rejected(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.vm.sender = env.owner
            env.vm.value = GEN
            env.c.create_vault(env.commit, 90, [env.hex["bob"], env.hex["charlie"]], [10000], ["", ""], "")

    def test_oversized_note_reference_rejected(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(heirs=[("bob", 10000)], notes=["x" * 513])

    def test_executor_cannot_be_owner(self, env):
        with env.vm.expect_revert(BAD_INPUT):
            env.create(executor=env.hex["owner"])


# ===================================================== heartbeat & inactivity
class TestInactivity:
    def test_heartbeat_resets_the_inactivity_clock(self, env):
        vid = env.create()
        env.warp(60)
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        v = env.c.get_vault(vid)
        assert v["last_heartbeat"] == int((T0.timestamp())) + 60 * DAY
        assert v["claimable_at"] == v["last_heartbeat"] + 90 * DAY

    def test_heartbeat_only_owner(self, env):
        vid = env.create()
        for who in (env.bob, env.alice):
            env.vm.sender = who
            with env.vm.expect_revert(UNAUTH):
                env.c.heartbeat(vid)

    def test_claim_before_inactivity_threshold_reverts(self, env):
        vid = env.create(days=90)
        env.warp(89)
        env.vm.sender = env.bob
        env.vm.value = MIN_BOND * 10
        with env.vm.expect_revert(EARLY):
            env.c.initiate_claim(vid)

    def test_claim_one_second_before_threshold_reverts(self, env):
        vid = env.create(days=90)
        env.vm.warp(at(89, 86399))
        env.vm.sender = env.bob
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(EARLY):
            env.c.initiate_claim(vid)

    def test_claim_exactly_at_threshold_allowed(self, env):
        vid = env.create(days=90)
        env.warp(90)
        env.claim(vid)
        assert env.c.get_vault(vid)["state_name"] == "CLAIM_INITIATED"

    def test_heartbeat_restarts_window_for_claims(self, env):
        vid = env.create(days=90)
        env.warp(80)
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        env.warp(100)  # 20 days after the ping
        env.vm.sender = env.bob
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(EARLY):
            env.c.initiate_claim(vid)


# ============================================================ claim initiation
class TestInitiateClaim:
    def test_stranger_cannot_claim(self, env):
        vid = env.create()
        env.warp(100)
        env.vm.sender = env.alice  # not an heir
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(UNAUTH):
            env.c.initiate_claim(vid)

    def test_owner_cannot_claim_own_vault(self, env):
        vid = env.create()
        env.warp(100)
        env.vm.sender = env.owner
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(UNAUTH):
            env.c.initiate_claim(vid)

    def test_designated_executor_may_claim(self, env):
        vid = env.create(executor=env.hex["alice"])
        env.warp(100)
        env.claim(vid, env.alice)
        v = env.c.get_vault(vid)
        assert v["state_name"] == "CLAIM_INITIATED"
        assert v["claimant"] == env.hex["alice"]

    def test_required_bond_is_ten_percent_of_principal(self, env):
        vid = env.create(value=10 * GEN)
        assert env.c.required_claim_bond(vid) == str(1 * GEN)

    def test_required_bond_has_fixed_floor(self, env):
        vid = env.create(value=MIN_DEPOSIT)
        assert env.c.required_claim_bond(vid) == str(MIN_BOND)

    def test_bond_below_requirement_reverts(self, env):
        vid = env.create(value=10 * GEN)
        env.warp(100)
        env.vm.sender = env.bob
        env.vm.value = GEN - 1
        with env.vm.expect_revert(BOND_ERR):
            env.c.initiate_claim(vid)

    def test_zero_bond_reverts(self, env):
        vid = env.create()
        env.warp(100)
        env.vm.sender = env.bob
        env.vm.value = 0
        with env.vm.expect_revert(BOND_ERR):
            env.c.initiate_claim(vid)

    def test_second_claim_while_open_reverts(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid, env.bob)
        env.vm.sender = env.charlie
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(BAD_STATE):
            env.c.initiate_claim(vid)

    def test_overpaid_bond_is_fully_tracked_and_refunded(self, env, transfers):
        vid = env.create(value=10 * GEN)
        env.warp(100)
        env.claim(vid, env.bob, value=3 * GEN)
        assert env.c.get_vault(vid)["claim_bond"] == str(3 * GEN)
        env.all_confirmed()
        env.verify(vid)
        env.warp(131)
        env.vm.sender = env.charlie
        env.c.finalize_succession(vid)
        assert total_to(transfers, env.hex["bob"]) == 3 * GEN

    def test_unknown_vault_reverts(self, env):
        with env.vm.expect_revert("ERR_UNKNOWN_VAULT"):
            env.c.get_vault(42)
        env.vm.sender = env.owner
        with env.vm.expect_revert("ERR_UNKNOWN_VAULT"):
            env.c.heartbeat(42)


# ============================================== multi-source vital consensus
class TestRegistryConsensus:
    def _ready(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        return vid

    def test_three_of_three_agreement_verifies_death(self, env):
        vid = self._ready(env)
        env.all_confirmed()
        assert env.verify(vid) == 1
        v = env.c.get_vault(vid)
        assert v["state_name"] == "VETO_CHALLENGE_PERIOD"
        assert v["veto_until"] == int(T0.timestamp()) + 100 * DAY + VETO
        assert v["cert_epoch"] == day_epoch("2026-02-10")

    @pytest.mark.parametrize("down", [0, 1, 2])
    @pytest.mark.parametrize("failure", [500, 503, 429, 403])
    def test_two_of_three_quorum_verifies_when_one_source_down(self, env, down, failure):
        vid = self._ready(env)
        specs = [record(env.commit)] * 3
        specs[down] = failure
        mock_registries(env.vm, *specs)
        assert env.verify(vid) == 1

    def test_one_source_responding_is_quorum_failure_without_slash(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, record(env.commit), 503, 500)
        assert env.verify(vid) == 2
        v = env.c.get_vault(vid)
        assert v["state_name"] == "CLAIM_INITIATED"
        assert v["claim_bond"] == str(GEN)  # untouched
        assert v["principal"] == str(10 * GEN)

    def test_zero_sources_responding_is_quorum_failure(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, 500, 502, 504)
        assert env.verify(vid) == 2

    def test_quorum_failure_is_retryable_then_succeeds(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, 500, 500, record(env.commit))
        assert env.verify(vid) == 2
        assert env.verify(vid) == 2
        env.all_confirmed()
        assert env.verify(vid) == 1
        assert env.c.get_vault(vid)["verify_attempts"] == 3

    def test_unanimous_not_found_is_no_record_and_bond_joins_estate(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, 404, 404, 404)
        assert env.verify(vid) == 0
        v = env.c.get_vault(vid)
        assert v["state_name"] == "ACTIVE"
        assert v["claim_bond"] == "0"
        assert v["claimant"] == ""
        assert v["principal"] == str(11 * GEN)  # 10 + forfeited 1 bond
        assert env.c.get_protocol_overview()["escrowed"] == str(11 * GEN)

    def test_one_not_found_among_two_responders_is_no_record(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, record(env.commit), 404, 500)
        assert env.verify(vid) == 0

    def test_responders_must_all_agree_one_dissent_blocks(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, record(env.commit), record(env.commit), 404)
        assert env.verify(vid) == 0

    def test_conflicting_certificate_hashes_block_verification(self, env):
        vid = self._ready(env)
        mock_registries(
            env.vm, record(env.commit), record(env.commit, certificate_hash="cd" * 32), record(env.commit)
        )
        assert env.verify(vid) == 0

    def test_conflicting_death_dates_block_verification(self, env):
        vid = self._ready(env)
        mock_registries(
            env.vm, record(env.commit), record(env.commit, date_of_death="2026-02-11"), record(env.commit)
        )
        assert env.verify(vid) == 0

    def test_certificate_predating_vault_creation_rejected(self, env):
        vid = self._ready(env)
        env.all_confirmed(date_of_death="2025-12-31")
        assert env.verify(vid) == 0
        assert env.c.get_vault(vid)["state_name"] == "ACTIVE"

    def test_certificate_dated_on_creation_day_accepted(self, env):
        vid = self._ready(env)
        env.all_confirmed(date_of_death="2026-01-01")
        assert env.verify(vid) == 1

    def test_future_dated_certificate_rejected(self, env):
        vid = self._ready(env)  # now == 2026-04-11
        env.all_confirmed(date_of_death="2026-04-12")
        assert env.verify(vid) == 0

    def test_death_after_owner_last_heartbeat_contradiction_rejected(self, env):
        vid = env.create()
        env.warp(60)  # 2026-03-02
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        env.warp(160)
        env.claim(vid)
        env.all_confirmed(date_of_death="2026-02-10")  # owner was demonstrably alive on 03-02
        assert env.verify(vid) == 0

    def test_death_on_day_of_last_heartbeat_accepted(self, env):
        vid = env.create()
        env.warp(60)
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        env.warp(160)
        env.claim(vid)
        env.all_confirmed(date_of_death="2026-03-02")
        assert env.verify(vid) == 1

    @pytest.mark.parametrize("status", ["PENDING", "REVOKED", "confirmed", "", None, 1])
    def test_status_must_be_exactly_confirmed(self, env, status):
        vid = self._ready(env)
        env.all_confirmed(status=status)
        assert env.verify(vid) == 0

    def test_record_for_a_different_identity_rejected(self, env):
        vid = self._ready(env)
        env.all_confirmed(identity_commitment=commitment("Charles Babbage", "1791-12-26", "GB-LND"))
        assert env.verify(vid) == 0

    @pytest.mark.parametrize(
        "over",
        [
            {"certificate_hash": "xyz"},
            {"certificate_hash": "ab" * 31},
            {"certificate_hash": None},
            {"date_of_death": "10/02/2026"},
            {"date_of_death": "2026-02-30"},
            {"date_of_death": "2026-13-01"},
            {"date_of_death": 20260210},
        ],
    )
    def test_malformed_record_fields_rejected(self, env, over):
        vid = self._ready(env)
        env.all_confirmed(**over)
        assert env.verify(vid) == 0

    @pytest.mark.parametrize("body", ["not json", "{", "[]", "null", ""])
    def test_corrupt_transport_counts_as_not_responded(self, env, body):
        vid = self._ready(env)
        r = record(env.commit)
        mock_registries(env.vm, body, body, r)  # only one valid responder -> quorum failure
        assert env.verify(vid) == 2

    def test_non_object_json_is_not_a_response(self, env):
        vid = self._ready(env)
        mock_registries(env.vm, json.dumps([1, 2]), json.dumps("x"), record(env.commit))
        assert env.verify(vid) == 2

    @pytest.mark.parametrize("schema", ["legacyvault.vital-record/v2", "", None, 1])
    def test_foreign_schema_is_not_a_response_so_cannot_slash_honest_claimant(self, env, schema):
        vid = self._ready(env)
        env.all_confirmed(schema=schema)
        assert env.verify(vid) == 2  # retryable, bond untouched
        assert env.c.get_vault(vid)["claim_bond"] == str(GEN)

    def test_oversized_record_is_not_responded(self, env):
        vid = self._ready(env)
        huge = json.dumps(record(env.commit, padding="x" * 9000))
        mock_registries(env.vm, huge, huge, record(env.commit))
        assert env.verify(vid) == 2

    def test_record_url_is_derived_from_commitment_not_supplied(self, env):
        """Only a URL ending in /<identity_commitment>.json is mocked: if the
        contract fetched anything else every source would be silent."""
        vid = self._ready(env)
        env.vm.clear_mocks()
        body = json.dumps(record(env.commit))
        for base in REGISTRIES:
            host = base.split("https://")[1].replace(".", r"\.")
            env.vm.mock_web(rf".*{host}/{env.commit}\.json$", {"status": 200, "body": body})
        assert env.verify(vid) == 1

    def test_nothing_in_the_abi_accepts_a_url(self, env):
        import inspect

        for name in ("initiate_claim", "verify_claim", "create_vault"):
            params = inspect.signature(getattr(env.c, name)).parameters
            assert not any("url" in p.lower() or "uri" in p.lower() for p in params)

    def test_only_claimant_may_trigger_verification(self, env):
        vid = self._ready(env)
        env.all_confirmed()
        for who in (env.charlie, env.alice, env.owner):
            env.vm.sender = who
            with env.vm.expect_revert(UNAUTH):
                env.c.verify_claim(vid)

    def test_verify_without_open_claim_reverts(self, env):
        vid = env.create()
        env.vm.sender = env.bob
        with env.vm.expect_revert(BAD_STATE):
            env.c.verify_claim(vid)

    def test_verify_twice_after_success_reverts(self, env):
        vid = self._ready(env)
        env.all_confirmed()
        env.verify(vid)
        env.vm.sender = env.bob
        with env.vm.expect_revert(BAD_STATE):
            env.c.verify_claim(vid)


# ============================================== validator equivalence (forgery)
class TestValidatorEquivalence:
    EPOCH = day_epoch("2026-02-10")

    def _verified(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.all_confirmed()
        env.verify(vid)
        return {"verdict": 1, "source_count": 3, "cert_epoch": self.EPOCH, "cert_hash": CERT}

    def test_validator_accepts_exact_honest_payload(self, env):
        honest = self._verified(env)
        assert env.vm.run_validator() is True
        assert env.vm.run_validator(leader_result=honest) is True

    def test_validator_rejects_forged_verdict_or_source_count(self, env):
        honest = self._verified(env)
        for forged in (
            {**honest, "verdict": 0},
            {**honest, "verdict": 2},
            {**honest, "source_count": 2},
            {**honest, "source_count": 1},
            {**honest, "verdict": 0, "source_count": 2},
        ):
            assert env.vm.run_validator(leader_result=forged) is False, forged

    def test_validator_rejects_forged_cert_epoch(self, env):
        honest = self._verified(env)
        assert env.vm.run_validator(leader_result={**honest, "cert_epoch": honest["cert_epoch"] + DAY}) is False
        assert env.vm.run_validator(leader_result={**honest, "cert_epoch": 0}) is False

    def test_validator_rejects_forged_certificate_hash(self, env):
        """The hash is what the replay guard keys on, so a leader that swapped
        it could dodge (or poison) the invalidation record."""
        honest = self._verified(env)
        assert env.vm.run_validator(leader_result={**honest, "cert_hash": "cd" * 32}) is False
        assert env.vm.run_validator(leader_result={**honest, "cert_hash": ""}) is False
        assert env.vm.run_validator(leader_result={**honest, "cert_hash": CERT.upper()}) is False

    def test_validator_rejects_malformed_or_extra_key_payload(self, env):
        honest = self._verified(env)
        e = honest["cert_epoch"]
        bad_payloads = [
            {**honest, "note": "death certificate looks fine"},  # leader free text
            {"verdict": 1, "source_count": 3, "cert_epoch": e},  # missing cert_hash
            {"verdict": 1, "source_count": 3, "cert_hash": CERT},  # missing cert_epoch
            {"verdict": 1, "cert_epoch": e, "cert_hash": CERT},
            {},
            {**honest, "verdict": "1"},
            {**honest, "verdict": 1.0},
            {**honest, "verdict": True},
            {**honest, "source_count": 3.0},
            {**honest, "source_count": None},
            {**honest, "cert_epoch": str(e)},
            {**honest, "cert_hash": 12345},
            {**honest, "cert_hash": None},
            {**honest, "verdict": 7},
            {**honest, "verdict": -1},
            {**honest, "source_count": -3},
            {**honest, "source_count": 4},
            {**honest, "cert_epoch": -5},
            [1, 3, e, CERT],
            "VERIFIED_DECEASED",
            1,
            None,
        ]
        for p in bad_payloads:
            assert env.vm.run_validator(leader_result=p) is False, p

    def test_validator_rejects_internally_inconsistent_payloads(self, env):
        self._verified(env)
        e = self.EPOCH
        assert env.vm.run_validator(leader_result={"verdict": 1, "source_count": 1, "cert_epoch": e, "cert_hash": CERT}) is False
        assert env.vm.run_validator(leader_result={"verdict": 1, "source_count": 3, "cert_epoch": 0, "cert_hash": CERT}) is False
        assert env.vm.run_validator(leader_result={"verdict": 2, "source_count": 3, "cert_epoch": 0, "cert_hash": ""}) is False
        # a non-verified verdict may not carry a certificate
        assert env.vm.run_validator(leader_result={"verdict": 0, "source_count": 3, "cert_epoch": 0, "cert_hash": CERT}) is False
        assert env.vm.run_validator(leader_result={"verdict": 2, "source_count": 1, "cert_epoch": e, "cert_hash": ""}) is False

    def test_validator_rejects_a_leader_error(self, env):
        self._verified(env)
        assert env.vm.run_validator(leader_error=Exception("[TRANSIENT] boom")) is False

    def test_validator_disagrees_when_it_sees_different_registry_data(self, env):
        honest = self._verified(env)
        mock_registries(env.vm, 404, 404, 404)  # validator's independent view
        assert env.vm.run_validator(leader_result=honest) is False

    def test_validator_agrees_on_honest_no_record(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        mock_registries(env.vm, 404, 404, 404)
        assert env.verify(vid) == 0
        assert env.vm.run_validator() is True
        assert env.vm.run_validator(leader_result={"verdict": 0, "source_count": 3, "cert_epoch": 0, "cert_hash": ""}) is True
        assert env.vm.run_validator(
            leader_result={"verdict": 1, "source_count": 3, "cert_epoch": self.EPOCH, "cert_hash": CERT}
        ) is False

    def test_validator_agrees_on_quorum_failure_and_blocks_upgrade_to_verified(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        mock_registries(env.vm, 500, 500, record(env.commit))
        assert env.verify(vid) == 2
        assert env.vm.run_validator() is True
        assert env.vm.run_validator(
            leader_result={"verdict": 1, "source_count": 2, "cert_epoch": self.EPOCH, "cert_hash": CERT}
        ) is False


# ============================================================ veto & slashing
class TestVetoAndSlash:
    def test_owner_veto_slashes_claimant_bond_100_percent(self, env, transfers):
        vid = env.to_veto()
        assert env.c.get_vault(vid)["claim_bond"] == str(GEN)
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        v = env.c.get_vault(vid)
        assert v["state_name"] == "ACTIVE"
        assert v["claim_bond"] == "0"
        assert v["claimant"] == ""
        assert v["veto_until"] == 0 and v["cert_epoch"] == 0
        assert total_to(transfers, env.hex["owner"]) == GEN  # the whole bond
        assert total_to(transfers, env.hex["bob"]) == 0  # claimant got nothing back
        assert v["principal"] == str(10 * GEN)  # principal untouched
        assert env.c.get_protocol_overview()["escrowed"] == str(10 * GEN)

    def test_veto_resets_inactivity_clock(self, env):
        vid = env.to_veto()
        env.warp(105)
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        v = env.c.get_vault(vid)
        assert v["last_heartbeat"] == int(T0.timestamp()) + 105 * DAY
        env.vm.sender = env.bob
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(EARLY):
            env.c.initiate_claim(vid)

    def test_heartbeat_during_veto_period_cancels_and_slashes(self, env, transfers):
        vid = env.to_veto()
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        assert env.c.get_vault(vid)["state_name"] == "ACTIVE"
        assert total_to(transfers, env.hex["owner"]) == GEN

    def test_veto_before_verification_also_slashes(self, env, transfers):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        assert env.c.get_vault(vid)["state_name"] == "ACTIVE"
        assert total_to(transfers, env.hex["owner"]) == GEN

    def test_veto_works_after_window_elapsed_but_before_finalize(self, env, transfers):
        vid = env.to_veto()
        env.warp(200)  # long past veto_until, nobody finalized
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        assert total_to(transfers, env.hex["owner"]) == GEN

    def test_only_owner_may_veto(self, env):
        vid = env.to_veto()
        for who in (env.bob, env.charlie, env.alice):
            env.vm.sender = who
            with env.vm.expect_revert(UNAUTH):
                env.c.veto_claim(vid)
        assert env.c.get_vault(vid)["state_name"] == "VETO_CHALLENGE_PERIOD"

    def test_veto_without_open_claim_reverts(self, env):
        vid = env.create()
        env.vm.sender = env.owner
        with env.vm.expect_revert(BAD_STATE):
            env.c.veto_claim(vid)

    def test_plain_heartbeat_with_no_claim_pays_nothing(self, env, transfers):
        vid = env.create()
        env.vm.sender = env.owner
        env.c.heartbeat(vid)
        assert transfers == []

    def test_vetoed_vault_can_be_claimed_again_after_new_inactivity(self, env):
        vid = env.to_veto()
        env.warp(101)  # 2026-04-12
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        env.warp(101 + 90)
        env.claim(vid)
        # genuinely after the owner's last ping AND a different certificate: the
        # vetoed one is invalidated for this vault regardless of the date shown
        env.all_confirmed(date_of_death="2026-04-20", certificate_hash="ef" * 32)
        assert env.verify(vid) == 1

    def test_stale_certificate_cannot_be_replayed_after_a_veto(self, env):
        """The February certificate that opened the first claim contradicts the
        owner's April heartbeat, so it can never be replayed against the vault."""
        vid = env.to_veto()
        env.warp(101)
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        env.warp(101 + 90)
        env.claim(vid)
        env.all_confirmed(date_of_death="2026-02-10")
        assert env.verify(vid) == 0


# ================================================== finalize & BPS distribution
class TestDistribution:
    def test_finalize_before_veto_expiry_reverts(self, env):
        vid = env.to_veto()
        env.vm.warp(at(100 + 30, -1))
        env.vm.sender = env.charlie
        with env.vm.expect_revert(EARLY):
            env.c.finalize_succession(vid)

    def test_finalize_exactly_at_veto_expiry(self, env):
        vid = env.to_veto()
        env.warp(130)
        env.vm.sender = env.charlie
        env.c.finalize_succession(vid)
        assert env.c.get_vault(vid)["state_name"] == "SUCCEEDED"

    def test_finalize_requires_verified_state(self, env):
        vid = env.create()
        env.warp(200)
        env.vm.sender = env.bob
        with env.vm.expect_revert(BAD_STATE):
            env.c.finalize_succession(vid)

    def test_finalize_returns_honest_claimant_bond(self, env, transfers):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice  # anyone may finalize
        env.c.finalize_succession(vid)
        assert total_to(transfers, env.hex["bob"]) == GEN
        v = env.c.get_vault(vid)
        assert v["claim_bond"] == "0"
        assert env.c.get_protocol_overview()["escrowed"] == str(10 * GEN)  # only the estate remains

    def test_finalize_fixes_allocations_per_bps(self, env):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        amounts = [int(b["amount"]) for b in env.c.get_vault(vid)["beneficiaries"]]
        assert amounts == [6 * GEN, 4 * GEN]

    def test_bps_rounding_remainder_assigned_to_primary_heir_zero_dust_locked(self, env, transfers):
        principal = 1_000_000_000_000_007
        vid = env.create(value=principal, heirs=[("alice", 1000), ("bob", 3000), ("charlie", 6000)])
        env.warp(100)
        env.claim(vid, env.bob)
        env.all_confirmed()
        env.verify(vid, env.bob)
        env.warp(131)
        env.vm.sender = env.owner  # an arbitrary caller
        env.c.finalize_succession(vid)
        floor = [principal * b // 10000 for b in (1000, 3000, 6000)]
        remainder = principal - sum(floor)
        assert remainder > 0
        amounts = [int(b["amount"]) for b in env.c.get_vault(vid)["beneficiaries"]]
        assert amounts == [floor[0] + remainder, floor[1], floor[2]]
        assert sum(amounts) == principal  # zero dust
        for who in ("alice", "bob", "charlie"):
            env.vm.sender = getattr(env, who)
            env.c.claim_inheritance(vid)
        paid_to_heirs = sum(total_to(transfers, env.hex[w]) for w in ("alice", "bob", "charlie"))
        bond = int(env.c.required_claim_bond(vid)) if False else MIN_DEPOSIT  # floor bond
        assert paid_to_heirs == principal + bond  # estate + refunded bond (bob)
        assert env.c.get_protocol_overview()["escrowed"] == "0"  # nothing stranded

    @pytest.mark.parametrize(
        "shares", [[3333, 3333, 3334], [1, 9999], [1, 1, 1, 1, 9996], [5000, 2500, 2500], [9999, 1]]
    )
    def test_split_never_loses_a_wei(self, env, shares):
        keys = ["alice", "bob", "charlie", "owner", "owner"]
        names = ["alice", "bob", "charlie"]
        # use synthetic extra heirs when more than 3 shares
        addrs = [env.hex[k] for k in names[: len(shares)]] + ["0x" + f"{i:040x}" for i in range(201, 210)]
        addrs = addrs[: len(shares)]
        principal = 1_000_000_000_000_003 + len(shares)
        env.vm.sender = env.owner
        env.vm.value = principal
        vid = env.c.create_vault(env.commit, 90, addrs, shares, [""] * len(shares), "")
        env.warp(100)
        env.claim(vid, env.alice)
        env.all_confirmed()
        env.verify(vid, env.alice)
        env.warp(131)
        env.vm.sender = env.charlie
        env.c.finalize_succession(vid)
        amounts = [int(b["amount"]) for b in env.c.get_vault(vid)["beneficiaries"]]
        assert sum(amounts) == principal

    def test_claim_inheritance_pays_exact_allocation_and_returns_note(self, env, transfers):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        env.vm.sender = env.charlie
        note = env.c.claim_inheritance(vid)
        assert note == "ipfs://cipher-charlie"
        assert total_to(transfers, env.hex["charlie"]) == 4 * GEN

    def test_unauthenticated_caller_cannot_steal_heir_allocation(self, env, transfers):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        before = list(transfers)
        for thief in (env.alice, env.owner):
            env.vm.sender = thief
            with env.vm.expect_revert(UNAUTH):
                env.c.claim_inheritance(vid)
        assert transfers == before
        assert [b["claimed"] for b in env.c.get_vault(vid)["beneficiaries"]] == [False, False]

    def test_heir_cannot_double_claim(self, env, transfers):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        env.vm.sender = env.bob
        env.c.claim_inheritance(vid)
        n = len(transfers)
        with env.vm.expect_revert("ERR_NOTHING_TO_CLAIM"):
            env.c.claim_inheritance(vid)
        assert len(transfers) == n

    def test_claim_inheritance_before_finalization_reverts(self, env):
        vid = env.to_veto()
        env.vm.sender = env.bob
        with env.vm.expect_revert(BAD_STATE):
            env.c.claim_inheritance(vid)

    def test_one_heir_never_claiming_does_not_block_the_others(self, env, transfers):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        env.vm.sender = env.charlie  # bob (primary) never shows up
        env.c.claim_inheritance(vid)
        assert total_to(transfers, env.hex["charlie"]) == 4 * GEN
        # bob's share is still escrowed and claimable at any later time
        assert env.c.get_protocol_overview()["escrowed"] == str(6 * GEN)
        env.warp(900)
        env.vm.sender = env.bob
        env.c.claim_inheritance(vid)
        assert env.c.get_protocol_overview()["escrowed"] == "0"

    def test_failing_payout_reverts_with_classified_error(self, env, monkeypatch):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)

        class _Boom:
            def __init__(self, *_):
                pass

            def emit_transfer(self, *a, **k):
                raise RuntimeError("enqueue failed")

        import genlayer.chain as chain_mod

        monkeypatch.setattr(chain_mod, "Account", _Boom)
        env.vm.sender = env.bob
        with env.vm.expect_revert("ERR_TRANSFER_FAILED_RESTORED"):
            env.c.claim_inheritance(vid)

    def test_note_references_hidden_until_finalized(self, env):
        vid = env.to_veto()
        assert all(b["note_ref"] == "" for b in env.c.get_vault(vid)["beneficiaries"])
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        refs = [b["note_ref"] for b in env.c.get_vault(vid)["beneficiaries"]]
        assert refs == ["ipfs://cipher-bob", "ipfs://cipher-charlie"]
        # compact summaries never carry them
        assert all(b["note_ref"] == "" for b in env.c.get_vault_summaries(1, 5)[0]["beneficiaries"])

    def test_forfeited_bond_flows_to_heirs_at_succession(self, env, transfers):
        vid = env.create(value=10 * GEN)
        env.warp(100)
        env.claim(vid, env.bob)
        mock_registries(env.vm, 404, 404, 404)
        env.verify(vid, env.bob)  # bob loses 1 GEN into the estate
        env.claim(vid, env.charlie)
        env.all_confirmed()
        env.verify(vid, env.charlie)
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        amounts = [int(b["amount"]) for b in env.c.get_vault(vid)["beneficiaries"]]
        assert sum(amounts) == 11 * GEN
        assert amounts[0] == 11 * GEN * 6000 // 10000


# ================================================ certificate replay guard
class TestCertificateReplay:
    SAME_DAY = "2026-04-11"  # == the veto day, so the heartbeat-contradiction rule alone would NOT stop a replay

    def _veto_same_day_cert(self, env, via="veto_claim"):
        vid = env.create()
        env.warp(100)  # 2026-04-11
        env.claim(vid)
        env.all_confirmed(date_of_death=self.SAME_DAY)
        assert env.verify(vid) == 1
        env.vm.sender = env.owner
        getattr(env.c, via)(vid)
        return vid

    def test_previously_vetoed_certificate_cannot_be_replayed_in_future_claim(self, env, transfers):
        vid = self._veto_same_day_cert(env)
        assert env.c.is_certificate_invalidated(vid, CERT) is True
        env.warp(100 + 90)
        env.claim(vid, env.bob)
        env.all_confirmed(date_of_death=self.SAME_DAY)  # the very same certificate
        before = int(env.c.get_vault(vid)["principal"])
        assert env.verify(vid, env.bob) == 0  # rejected, not VERIFIED
        v = env.c.get_vault(vid)
        assert v["state_name"] == "ACTIVE" and v["cert_hash"] == ""
        assert int(v["principal"]) == before + GEN  # replayer's bond joined the estate
        assert total_to(transfers, env.hex["bob"]) == 0

    def test_heartbeat_during_veto_period_also_invalidates_the_certificate(self, env):
        vid = self._veto_same_day_cert(env, via="heartbeat")
        assert env.c.is_certificate_invalidated(vid, CERT) is True

    def test_revoke_during_veto_period_invalidates_the_certificate(self, env):
        vid = self._veto_same_day_cert(env, via="revoke_vault")
        assert env.c.is_certificate_invalidated(vid, CERT) is True

    def test_a_different_certificate_is_still_accepted_after_a_veto(self, env):
        vid = self._veto_same_day_cert(env)
        env.warp(100 + 90)  # 2026-07-10
        env.claim(vid, env.bob)
        env.all_confirmed(date_of_death="2026-07-09", certificate_hash="cd" * 32)
        assert env.verify(vid, env.bob) == 1
        assert env.c.get_vault(vid)["cert_hash"] == "cd" * 32

    def test_veto_before_verification_invalidates_nothing(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.vm.sender = env.owner
        env.c.veto_claim(vid)
        assert env.c.is_certificate_invalidated(vid, CERT) is False

    def test_invalidation_is_scoped_to_one_vault_so_it_cannot_poison_a_victims_heirs(self, env):
        """Duplicate commitments are allowed, so an attacker can verify the
        victim's real certificate on a throwaway vault and veto it. That must not
        lock out the victim's own vault."""
        attacker = env.create(heirs=[("alice", 10000)], sender=env.owner)
        victim = env.create(heirs=[("bob", 10000)], sender=env.charlie)  # same commitment
        env.warp(100)
        env.claim(attacker, env.alice)
        env.all_confirmed(date_of_death=self.SAME_DAY)
        env.verify(attacker, env.alice)
        env.vm.sender = env.owner
        env.c.veto_claim(attacker)
        assert env.c.is_certificate_invalidated(attacker, CERT) is True
        assert env.c.is_certificate_invalidated(victim, CERT) is False
        env.claim(victim, env.bob)
        env.all_confirmed(date_of_death=self.SAME_DAY)
        assert env.verify(victim, env.bob) == 1

    def test_verified_vault_exposes_its_certificate_hash(self, env):
        vid = env.to_veto()
        assert env.c.get_vault(vid)["cert_hash"] == CERT
        assert env.c.is_certificate_invalidated(vid, CERT) is False


# ========================================================= terminal states
class TestTerminalStates:
    def _succeeded(self, env):
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        return vid

    def test_succeeded_vault_rejects_owner_actions(self, env):
        vid = self._succeeded(env)
        env.vm.sender = env.owner
        for call in (env.c.heartbeat, env.c.revoke_vault):
            with env.vm.expect_revert(BAD_STATE):
                call(vid)
        with env.vm.expect_revert(BAD_STATE):
            env.c.veto_claim(vid)

    def test_succeeded_vault_cannot_be_finalized_twice(self, env):
        vid = self._succeeded(env)
        env.vm.sender = env.alice
        with env.vm.expect_revert(BAD_STATE):
            env.c.finalize_succession(vid)

    def test_succeeded_vault_rejects_new_claims(self, env):
        vid = self._succeeded(env)
        env.vm.sender = env.bob
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(BAD_STATE):
            env.c.initiate_claim(vid)


# ================================================================= revoke
class TestRevoke:
    def test_revoke_returns_full_principal(self, env, transfers):
        vid = env.create(value=7 * GEN)
        env.vm.sender = env.owner
        env.c.revoke_vault(vid)
        assert total_to(transfers, env.hex["owner"]) == 7 * GEN
        v = env.c.get_vault(vid)
        assert v["state_name"] == "REVOKED" and v["principal"] == "0"
        assert env.c.get_protocol_overview()["escrowed"] == "0"

    def test_revoke_during_veto_period_also_slashes_claim_bond(self, env, transfers):
        vid = env.to_veto()
        env.vm.sender = env.owner
        env.c.revoke_vault(vid)
        assert total_to(transfers, env.hex["owner"]) == 10 * GEN + GEN
        assert total_to(transfers, env.hex["bob"]) == 0
        assert env.c.get_protocol_overview()["escrowed"] == "0"

    def test_revoke_with_unverified_claim_slashes_bond(self, env, transfers):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.vm.sender = env.owner
        env.c.revoke_vault(vid)
        assert total_to(transfers, env.hex["owner"]) == 11 * GEN

    def test_only_owner_may_revoke(self, env):
        vid = env.create()
        for who in (env.bob, env.alice):
            env.vm.sender = who
            with env.vm.expect_revert(UNAUTH):
                env.c.revoke_vault(vid)

    def test_double_revoke_reverts(self, env):
        vid = env.create()
        env.vm.sender = env.owner
        env.c.revoke_vault(vid)
        with env.vm.expect_revert(BAD_STATE):
            env.c.revoke_vault(vid)

    def test_revoked_vault_rejects_claims_and_heartbeat(self, env):
        vid = env.create()
        env.vm.sender = env.owner
        env.c.revoke_vault(vid)
        env.warp(200)
        env.vm.sender = env.bob
        env.vm.value = 10 * GEN
        with env.vm.expect_revert(BAD_STATE):
            env.c.initiate_claim(vid)
        env.vm.sender = env.owner
        with env.vm.expect_revert(BAD_STATE):
            env.c.heartbeat(vid)


# ================================================== claim unwinding / liveness
class TestClaimUnwind:
    def test_withdraw_claim_refunds_full_bond(self, env, transfers):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.vm.sender = env.bob
        env.c.withdraw_claim(vid)
        assert total_to(transfers, env.hex["bob"]) == GEN
        assert env.c.get_vault(vid)["state_name"] == "ACTIVE"
        assert env.c.get_protocol_overview()["escrowed"] == str(10 * GEN)

    def test_only_claimant_may_withdraw_claim(self, env):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        for who in (env.charlie, env.owner):
            env.vm.sender = who
            with env.vm.expect_revert(UNAUTH):
                env.c.withdraw_claim(vid)

    def test_cannot_withdraw_after_verification(self, env):
        vid = env.to_veto()
        env.vm.sender = env.bob
        with env.vm.expect_revert(BAD_STATE):
            env.c.withdraw_claim(vid)

    def test_expire_claim_after_window_returns_bond_without_slash(self, env, transfers):
        vid = env.create()
        env.warp(100)
        env.claim(vid)
        env.warp(129)
        env.vm.sender = env.charlie
        with env.vm.expect_revert(EARLY):
            env.c.expire_claim(vid)
        env.warp(130)
        env.c.expire_claim(vid)
        assert total_to(transfers, env.hex["bob"]) == GEN
        assert env.c.get_vault(vid)["state_name"] == "ACTIVE"

    def test_expire_claim_unavailable_once_verified(self, env):
        vid = env.to_veto()
        env.warp(300)
        env.vm.sender = env.charlie
        with env.vm.expect_revert(BAD_STATE):
            env.c.expire_claim(vid)


# ====================================================== registry governance
class TestRegistryGovernance:
    NEW = "https://civil-registry-d.newhost.org/records"

    def test_genesis_registries_are_exposed(self, env):
        regs = env.c.get_registries()
        assert [r["base_url"] for r in regs] == list(REGISTRIES)
        assert len({r["host"] for r in regs}) == 3

    @pytest.mark.parametrize(
        "bad",
        [
            "http://civil-registry-a.vitalrecords.org/records",  # not https
            "https://127.0.0.1/records",
            "https://2130706433/records",
            "https://localhost/records",
            "https://169.254.169.254/latest",
            "https://registry.internal/records",
            "https://user:pw@registry.org/records",
            "https://registry.org:8443/records",
            "https://registry.org/records?x=1",
            "https://registry.org/records#frag",
            "https://registry.org/records/",
            "ftp://registry.org/records",
            "",
            "registry.org",
        ],
    )
    def test_constructor_rejects_unsafe_registry_urls(self, direct_deploy, direct_vm, bad):
        from conftest import CONTRACT

        with direct_vm.expect_revert(BAD_INPUT):
            direct_deploy(CONTRACT, bad, REG_B, REG_C)

    def test_constructor_accepts_cdn_style_mirror_urls(self, direct_deploy, direct_vm):
        from conftest import CONTRACT

        c = direct_deploy(
            CONTRACT,
            "https://raw.githubusercontent.com/Handik4/LegacyVault/main/deployments/mock_registry/a",
            "https://cdn.jsdelivr.net/gh/Handik4/LegacyVault@main/deployments/mock_registry/b",
            "https://rawcdn.githack.com/Handik4/LegacyVault/main/deployments/mock_registry/c",
        )
        assert [r["host"] for r in c.get_registries()] == [
            "raw.githubusercontent.com", "cdn.jsdelivr.net", "rawcdn.githack.com"
        ]

    def test_constructor_rejects_duplicate_hosts(self, direct_deploy, direct_vm):
        from conftest import CONTRACT

        with direct_vm.expect_revert(BAD_INPUT):
            direct_deploy(CONTRACT, REG_A, REG_A + "/mirror", REG_C)

    def test_only_governor_may_propose_rotation(self, env):
        env.vm.sender = env.bob
        with env.vm.expect_revert(UNAUTH):
            env.c.propose_registry(0, self.NEW)

    def test_rotation_is_timelocked_seven_days(self, env):
        env.vm.sender = env.owner  # deployer == governor
        env.c.propose_registry(0, self.NEW)
        assert env.c.get_registries()[0]["base_url"] == REG_A  # not live yet
        env.warp(6)
        with env.vm.expect_revert(EARLY):
            env.c.activate_registry(0)
        env.warp(7)
        env.vm.sender = env.charlie  # permissionless
        env.c.activate_registry(0)
        assert env.c.get_registries()[0]["base_url"] == self.NEW

    def test_rotated_registry_is_the_one_queried(self, env):
        vid = env.create()
        env.vm.sender = env.owner
        env.c.propose_registry(0, self.NEW)
        env.warp(100)
        env.c.activate_registry(0)
        env.claim(vid)
        env.vm.clear_mocks()
        body = {"status": 200, "body": json.dumps(record(env.commit))}
        env.vm.mock_web(r".*civil-registry-d\.newhost\.org.*", body)
        env.vm.mock_web(r".*civil-registry-b\.deathindex\.net.*", body)
        env.vm.mock_web(r".*civil-registry-a\.vitalrecords\.org.*", {"status": 500, "body": ""})
        env.vm.mock_web(r".*civil-registry-c\.statevitals\.gov.*", {"status": 500, "body": ""})
        assert env.verify(vid) == 1

    def test_activate_without_pending_rotation_reverts(self, env):
        with env.vm.expect_revert(BAD_STATE):
            env.c.activate_registry(1)

    def test_rotation_cannot_collapse_independence(self, env):
        env.vm.sender = env.owner
        with env.vm.expect_revert(BAD_INPUT):
            env.c.propose_registry(0, REG_B + "/alt")

    def test_rotation_index_bounds(self, env):
        env.vm.sender = env.owner
        for idx in (-1, 3, 99):
            with env.vm.expect_revert(BAD_INPUT):
                env.c.propose_registry(idx, self.NEW)

    def test_governor_can_cancel_pending_rotation(self, env):
        env.vm.sender = env.owner
        env.c.propose_registry(2, self.NEW)
        env.c.cancel_registry_rotation(2)
        env.warp(30)
        with env.vm.expect_revert(BAD_STATE):
            env.c.activate_registry(2)

    def test_governor_transfer(self, env):
        env.vm.sender = env.owner
        env.c.transfer_governor(env.hex["alice"])
        assert env.c.get_protocol_overview()["governor"] == env.hex["alice"]
        with env.vm.expect_revert(UNAUTH):
            env.c.propose_registry(0, self.NEW)
        env.vm.sender = env.alice
        env.c.propose_registry(0, self.NEW)

    def test_governor_has_no_path_to_user_funds(self, env):
        names = {n for n in dir(env.c) if not n.startswith("_")}
        assert not {n for n in names if "drain" in n or "sweep" in n or "rescue" in n}


    def test_duplicate_registry_url_cannot_satisfy_multi_source_quorum(self, env):
        """Slots must be pairwise unique by URL AND host, counting staged
        rotations, so a single operator can never fill the quorum alone."""
        env.vm.sender = env.owner
        # 1. same URL as another ACTIVE slot
        with env.vm.expect_revert("registry duplicates slot"):
            env.c.propose_registry(0, REG_B)
        # 2. same HOST as another active slot, different path
        with env.vm.expect_revert("registry duplicates slot"):
            env.c.propose_registry(0, "https://civil-registry-b.deathindex.net/other/path")
        # 3. stage a legitimate rotation on slot 1, then try to stage the same
        #    URL and the same host on slot 2: pending-vs-pending must collide.
        env.c.propose_registry(1, self.NEW)
        with env.vm.expect_revert("registry duplicates slot"):
            env.c.propose_registry(2, self.NEW)
        with env.vm.expect_revert("registry duplicates slot"):
            env.c.propose_registry(2, self.NEW + "/v2")
        # 4. a slot may restage a different path on its OWN host
        env.c.propose_registry(1, self.NEW + "/v2")
        # nothing changed: three distinct active hosts remain
        hosts = [r["host"] for r in env.c.get_registries()]
        assert len(set(hosts)) == 3
        # and a verification with two real sources + one dead still needs two
        # DIFFERENT hosts: the registry list can never contain a repeat
        assert hosts == [
            "civil-registry-a.vitalrecords.org",
            "civil-registry-b.deathindex.net",
            "civil-registry-c.statevitals.gov",
        ]

    def test_activation_rechecks_uniqueness_against_current_slots(self, env):
        env.vm.sender = env.owner
        env.c.propose_registry(0, self.NEW)  # pending on slot 0
        env.warp(7)
        env.c.activate_registry(0)
        # slot 1 may not be pointed at the host slot 0 now occupies
        with env.vm.expect_revert("registry duplicates slot"):
            env.c.propose_registry(1, self.NEW + "/mirror")

    def test_activation_blocks_a_collision_created_after_staging(self, env):
        """Stage slot 1 -> host X while slot 0 is still on A; then slot 0 is
        rotated to X first. Slot 1's activation must now fail."""
        env.vm.sender = env.owner
        env.c.propose_registry(1, "https://civil-registry-x.unique-one.org/r")
        env.c.cancel_registry_rotation(1)  # staging X on slot 0 requires X to be free
        env.c.propose_registry(0, "https://civil-registry-x.unique-one.org/r")
        env.c.propose_registry(1, "https://civil-registry-y.unique-two.org/r")
        env.warp(7)
        env.c.activate_registry(0)
        env.c.activate_registry(1)
        assert len({r["host"] for r in env.c.get_registries()}) == 3


# ========================================================== account indexes
class TestAccountIndex:
    def test_owner_heir_and_executor_vault_ids_are_indexed(self, env):
        a = env.create()  # owner, heirs bob+charlie
        b = env.create(heirs=[("alice", 10000)], executor=env.hex["bob"])
        assert env.c.get_vault_ids_for(env.hex["owner"]) == [a, b]
        assert env.c.get_vault_ids_for(env.hex["bob"]) == [a, b]  # heir of a, executor of b
        assert env.c.get_vault_ids_for(env.hex["charlie"]) == [a]
        assert env.c.get_vault_ids_for(env.hex["alice"]) == [b]

    def test_unknown_or_malformed_address_yields_empty_list(self, env):
        env.create()
        assert env.c.get_vault_ids_for("0x" + "ab" * 20) == []
        assert env.c.get_vault_ids_for("not-an-address") == []
        assert env.c.get_vault_ids_for("") == []

    def test_index_lookup_is_case_insensitive(self, env):
        a = env.create()
        assert env.c.get_vault_ids_for(env.hex["bob"].lower()) == [a]

    def test_full_detail_view_carries_note_refs_after_finalization(self, env):
        """get_vault (not the summary) is the record that persists heir notes."""
        vid = env.to_veto()
        env.warp(131)
        env.vm.sender = env.alice
        env.c.finalize_succession(vid)
        full = env.c.get_vault(vid)
        assert [b["note_ref"] for b in full["beneficiaries"]] == ["ipfs://cipher-bob", "ipfs://cipher-charlie"]


# ================================================================= solvency
class TestSolvency:
    def test_escrow_tracks_every_deposit_and_bond(self, env):
        a = env.create(value=5 * GEN)
        b = env.create(value=2 * GEN)
        assert env.c.get_protocol_overview()["escrowed"] == str(7 * GEN)
        env.warp(100)
        env.claim(a, env.bob)
        assert env.c.get_protocol_overview()["escrowed"] == str(7 * GEN + GEN // 2)
        env.vm.sender = env.owner
        env.c.revoke_vault(b)
        assert env.c.get_protocol_overview()["escrowed"] == str(5 * GEN + GEN // 2)

    def test_solvent_flag_reflects_contract_balance(self, env):
        env.create(value=5 * GEN)
        assert env.c.get_protocol_overview()["solvent"] is False  # harness does not credit
        env.vm.deal(env.vm._contract_address, 5 * GEN)
        assert env.c.get_protocol_overview()["solvent"] is True

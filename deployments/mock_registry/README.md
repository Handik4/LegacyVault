# Mock registry (testnet simulation)

The contract derives every record URL as `{registry_base}/{identity_commitment}.json`.
The three genesis bases serve this directory through three **distinct hosts** (the
contract rejects any two slots that share a URL or a host, active or staged):

| Slot | Host | Base URL |
|------|------|----------|
| 0 | raw.githubusercontent.com | `https://raw.githubusercontent.com/Handik4/LegacyVault/main/deployments/mock_registry/a` |
| 1 | cdn.jsdelivr.net | `https://cdn.jsdelivr.net/gh/Handik4/LegacyVault@main/deployments/mock_registry/b` |
| 2 | rawcdn.githack.com | `https://rawcdn.githack.com/Handik4/LegacyVault/main/deployments/mock_registry/c` |

These are **not independent civil registries**: one repository behind three CDNs is
exactly enough to exercise the 3-source quorum on a testnet. Production points the
slots at genuinely separate registries via the 7-day `propose_registry` /
`activate_registry` timelock.

## Fixtures

`a/`, `b/` and `c/` each hold `9fb736df3c6ee8ba6416b35a04c78abddc77f4c2438442fcc4f2f5a14417bfc9.json`, the record for the demo
identity `demo testator|1970-01-01|DEMO`. A request for any other commitment is a
clean 404, which the contract counts as a responding "no record".

A record only verifies if its `date_of_death` is on or after the vault's creation
day, not in the future, and not before the owner's last heartbeat. The demo record is
dated `2026-10-14`, so it verifies for a demo vault created on that day.

## Record schema

```json
{
  "schema": "legacyvault.vital-record/v1",
  "identity_commitment": "<64 lowercase hex>",
  "status": "CONFIRMED",
  "certificate_hash": "<64 lowercase hex>",
  "date_of_death": "YYYY-MM-DD"
}
```

`SAMPLE.json` is a template that matches no real commitment.

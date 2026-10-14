# Registry mirrors (testnet simulation)

The contract derives every record URL as `{registry_base}/{identity_commitment}.json`.
The three genesis bases point at three independent hosts that all serve this
directory from the public repository:

| Slot | Host | Base URL |
|------|------|----------|
| 0 | raw.githubusercontent.com | `.../moltaphet/LegacyVault/main/registry-mirror/a` |
| 1 | cdn.jsdelivr.net | `.../gh/moltaphet/LegacyVault@main/registry-mirror/b` |
| 2 | rawcdn.githack.com | `.../moltaphet/LegacyVault/main/registry-mirror/c` |

These are **not independent civil registries**: they are one repository behind three
CDNs, which is exactly enough to exercise the 3-source quorum on a testnet. A
production deployment points the three slots at genuinely separate registries via
the 7-day `propose_registry` / `activate_registry` timelock.

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

`SAMPLE.json` is a template; it matches no real commitment. To simulate a death for
a vault you own, publish a record named `<identity_commitment>.json` in each of
`a/`, `b/` and `c/` (same certificate hash and date in all three).

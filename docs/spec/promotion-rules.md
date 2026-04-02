# Memory OS — Promotion Rules

## Trust Level Promotion

Memories advance through trust levels as evidence accumulates.

## Thresholds

| Transition | Minimum Score |
|-----------|---------------|
| t1_extracted → t2_validated | 0.4 |
| t2_validated → t3_committed | 0.7 |
| t3_committed → t5_canonical | 0.9 |

Note: t4_human is assigned by explicit human confirmation, not score-based promotion.

## Scoring Weights

| Dimension | Weight | Description |
|-----------|--------|-------------|
| importance | 0.30 | How consequential is this memory? |
| reusability | 0.20 | Will this be referenced across many sessions? |
| stability | 0.20 | How unlikely is this to change? |
| explicitness | 0.20 | Was this explicitly stated by the user? |
| evidence_strength | 0.10 | How much supporting evidence exists? |

## Explicit Signals (Japanese)

These signals in user content boost confidence and explicitness score:
- `覚えて` (remember this)
- `今後は` (from now on)
- `この方針で` (with this policy)
- `ベースにする` (use as base)
- `長期的に` (long-term)

## Auto-Promote Types

These types can be automatically promoted through t1→t2→t3:
- `episode`
- `evidence`
- `artifact_reference`
- `handoff_summary`

## Never Auto-Promote Types

These types require human confirmation at every level:
- `identity`
- `relationship`
- `goal`
- `policy`
- `decision`
- `procedure`

Canonical status (`t5_canonical`) always requires human action, regardless of type.

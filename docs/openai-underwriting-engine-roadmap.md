# OpenAI Underwriting Engine Roadmap

This document explains how VFC should use OpenAI in the underwriting engine.

## Important Principle

Do not start with model fine-tuning.

Start with a structured underwriting analysis API that extracts and summarizes consistent fields from bank statement text. Then collect human-reviewed outcomes. Fine-tuning can come later when there are enough high-quality examples.

## Phase 1 — Structured AI Extraction

Goal: convert bank statement text and application context into structured underwriting data.

Input:

```txt
Business name
Owner name
Industry
Time in business
Credit score
Estimated monthly sales
Extracted bank statement text
```

Output:

```json
{
  "average_monthly_deposits": 72500,
  "monthly_deposit_breakdown": [
    { "month": "2026-01", "total_deposits": 71000 },
    { "month": "2026-02", "total_deposits": 73500 }
  ],
  "nsf_count": 2,
  "negative_days": 3,
  "existing_mca_payments": 0,
  "large_deposits_to_verify": [],
  "revenue_trend": "stable",
  "cash_flow_strength": "moderate",
  "risk_flags": ["verify ownership", "confirm no active MCA stacking"],
  "risk_grade": "B",
  "underwriter_notes": "Stable deposits with limited negative activity. Verify existing obligations before approval."
}
```

This is not a final lending decision. Final decision must remain human-reviewed.

## Phase 2 — Rules Engine Offer Calculation

The deterministic VFC rules engine calculates:

```txt
Low offer
High offer
Risk grade
Recommended action
Conditions
```

This should use extracted values such as:

```txt
Average monthly deposits
Credit score
NSF count
Negative days
Existing MCA payments
Revenue trend
```

The model gives extraction and notes. The rules engine gives the offer range.

## Phase 3 — Human Feedback Capture

Every final decision should be saved as training feedback:

```txt
Application ID
AI extracted fields
Rules engine recommendation
Human final decision
Final approved amount
Decline reason
Conditions
Lender sent to
Funded or not funded
Actual repayment performance later
```

This becomes the VFC underwriting dataset.

## Phase 4 — Prompt Improvement Before Fine-Tuning

Before fine-tuning, improve:

```txt
Prompt instructions
JSON schema
Document text extraction
Risk flag categories
Offer rules
Dashboard review workflow
```

This is cheaper, faster, and safer than immediately training a custom model.

## Phase 5 — Fine-Tuning Later

Only consider fine-tuning once VFC has enough clean reviewed examples.

Recommended minimum dataset before fine-tuning:

```txt
100+ reviewed applications for basic style/consistency improvement
500+ reviewed applications for stronger underwriting pattern learning
1,000+ reviewed applications for meaningful MCA-specific model behavior
```

Each training example should include:

```txt
Input: application profile + cleaned statement summary + extracted metrics
Expected output: underwriter-style JSON + notes + risk flags
```

Do not include raw client bank statements, SINs, government IDs, full account numbers, or unredacted sensitive personal information in training files.

## Phase 6 — Evaluation Set

Keep a separate set of reviewed applications that are never used for training.

Use them to test whether the engine is improving:

```txt
Extraction accuracy
Risk flag accuracy
Grade consistency
Offer range reasonableness
False approvals
False declines
Missing MCA stacking risk
```

## Recommended MVP Flow

```txt
Client uploads 6 months statements
↓
Files stored in applicant/company Drive folder
↓
Statement text is extracted
↓
OpenAI returns structured JSON
↓
Rules engine calculates offer range
↓
Dashboard displays AI notes + suggested range
↓
Raj/VFC makes final human decision
↓
Decision is stored as feedback
```

## Security Rules

Never commit these to GitHub:

```txt
OpenAI API key
Raw bank statements
Client IDs
Credit reports
Service account private keys
Unredacted training files
```

Use Apps Script Properties for API keys.
Use private Drive or Cloud Storage for documents.
Use redacted/cleaned datasets for future fine-tuning.

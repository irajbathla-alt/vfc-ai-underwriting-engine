# VFC AI Underwriting Engine

Bank-statement underwriting engine with isolated bank profiles.

## Banking architecture

- `apps-script/BankingCore.gs` — shared frozen-fact storage, recurring-payment math, financing-credit matching and deterministic result fingerprints.
- `apps-script/BankRouter.gs` — routes each statement to its bank profile and creates the six bank-training tabs.
- `apps-script/Bank_RBC.gs` — **RBC v4.0 candidate**, with a generic printed-column ledger parser and exact four-control reconciliation.
- `apps-script/Bank_TD.gs` — TD v2.2 candidate.
- `apps-script/Bank_Scotia.gs` — pending training.
- `apps-script/Bank_BMO.gs` — BMO v1.4 candidate.
- `apps-script/Bank_CIBC.gs` — pending training.
- `apps-script/Bank_CoastCapital.gs` — pending training.

A bank-specific change should be made only in that bank's file. The shared core should change only when a rule genuinely applies to every bank.

RBC v4.0 does not key extraction to a company name, account number, known statement total or expected lender. It first reads the standard RBC Account Activity columns deterministically, then accepts the ledger only when credit count, credit total, debit count and debit total all match the printed Account Summary. The existing AI ledger reader is a checksum-gated fallback for transcripts whose table geometry is unavailable.

## Repeatability

Statement facts are frozen when uploaded. Re-uploading the same logical statement restores the first verified current-rules ledger, so later extraction differences do not silently change an approved result.

Use `lockBankRegressionBaseline(companyName, period, 'RBC')` only after approving a live RBC validation case, then `verifyBankRegressionBaseline(...)` after future changes.

Statement upload does not create a training feature row. A case enters the historical training dataset only through `saveLenderDecision(...)`, when an explicit lender outcome is saved. `rebuildStructuredFeatures()` rebuilds outcome-backed cases only.

## Training order

Validate RBC v4.0 in the deployed Apps Script environment, then lock its baseline. Train or approve the remaining bank candidates independently, one at a time.

# VFC AI Underwriting Engine

Bank-statement underwriting engine with isolated bank profiles.

## Banking architecture

- `apps-script/BankingCore.gs` — shared frozen-fact storage, recurring-payment math, financing-credit matching and deterministic result fingerprints.
- `apps-script/BankRouter.gs` — routes each statement to its bank profile and creates the six bank-training tabs.
- `apps-script/Bank_RBC.gs` — **RBC v1.0, trained and locked**.
- `apps-script/Bank_TD.gs` — pending training.
- `apps-script/Bank_Scotia.gs` — pending training.
- `apps-script/Bank_BMO.gs` — pending training.
- `apps-script/Bank_CIBC.gs` — pending training.
- `apps-script/Bank_CoastCapital.gs` — pending training.

A bank-specific change should be made only in that bank's file. The shared core should change only when a rule genuinely applies to every bank.

## Repeatability

Statement facts are frozen when uploaded. Re-uploading the same statement fingerprint restores the first verified ledger, so later OpenAI extraction differences do not silently change an already-trained RBC result.

Use `lockBankRegressionBaseline(companyName, period, 'RBC')` after approving an RBC test case, then `verifyBankRegressionBaseline(...)` after future changes.

## Training order

RBC is locked. Train the remaining banks independently, one at a time: TD, Scotia, BMO, CIBC, Coast Capital.

# VFC AI Underwriting Engine

Bank-statement underwriting engine with isolated bank profiles.

## Banking architecture

- `apps-script/BankingCore.gs` — shared frozen-fact storage, recurring-payment math, financing-credit matching and deterministic result fingerprints.
- `apps-script/BankRouter.gs` — routes each statement to its bank profile and creates the six bank-training tabs.
- `apps-script/Bank_RBC.gs` — **RBC v4.2 candidate**, with printed-column and running-balance ledger parsing, exact four-control reconciliation and named-counterparty recurring-outflow detection.
- `apps-script/Bank_TD.gs` — TD v2.2 candidate.
- `apps-script/Bank_Scotia.gs` — pending training.
- `apps-script/Bank_BMO.gs` — BMO v1.4 candidate.
- `apps-script/Bank_CIBC.gs` — pending training.
- `apps-script/Bank_CoastCapital.gs` — pending training.

A bank-specific change should be made only in that bank's file. The shared core should change only when a rule genuinely applies to every bank.

RBC v4.2 does not key extraction to a company name, account number, known statement total or expected lender. It first reads the RBC Account Activity columns. When extracted text loses column spacing but preserves transaction rows and running balances, it solves directions from those balances and the printed counts and totals. Both routes require every visible activity row and exact credit/debit counts and dollar totals from that statement's own Account Summary. The existing AI original-PDF ledger reader is the fallback when text loses row boundaries or is ambiguous; the same audit still applies. An incomplete or ambiguous ledger stops upload instead of inventing transactions or obligations.

The debt review groups identifiable recurring debits by bank and counterparty, separates confirmed financing from other recurring outflows, retains inactive streams without adding them to current debt, and highlights the best-evidenced active financing stream rather than the largest payment. Recurrence or an identical amount alone never proves a loan. An isolated larger catch-up is retained in observed totals but cannot replace an otherwise repeated normal monthly amount. Anonymous or unidentifiable debit references cannot reliably be assigned an obligation; these remain in the verified ledger but are not labeled as confirmed recurring obligations.

## Repeatability

Statement facts are frozen when uploaded. Re-uploading the same logical statement restores the first verified current-rules ledger, so later extraction differences do not silently change an approved result.

Use `lockBankRegressionBaseline(companyName, period, 'RBC')` only after approving a live RBC validation case, then `verifyBankRegressionBaseline(...)` after future changes.

Statement upload does not create a training feature row. A case enters the historical training dataset only through `saveLenderDecision(...)`, when an explicit lender outcome is saved. `rebuildStructuredFeatures()` rebuilds outcome-backed cases only.

## Training order

Validate RBC v4.2 in the deployed Apps Script environment with statements from multiple companies, then lock its baseline. The local check covered 24 actual RBC PDFs from four account sets with both column-preserving and spacing-free row-preserving text, but the live PDF text service still needs validation. Train or approve the remaining bank candidates independently, one at a time.

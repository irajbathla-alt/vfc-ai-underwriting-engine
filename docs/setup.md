# Setup Guide

## Google Sheet / Apps Script

Use the Apps Script project attached to the VFC underwriting Google Sheet.

Core files:

- `Code.gs` — upload, OCR, common statement intake and Sheets/Drive plumbing
- `BankingCore.gs` — frozen banking facts and deterministic recurring-obligation math
- `BankRouter.gs` — bank selection and isolation
- `Bank_RBC.gs` — RBC v1.0 trained / locked
- `Bank_TD.gs` — pending training
- `Bank_Scotia.gs` — pending training
- `Bank_BMO.gs` — pending training
- `Bank_CIBC.gs` — pending training
- `Bank_CoastCapital.gs` — pending training
- `InstitutionalUnderwritingLayer.gs` — production Our Max
- `OpenAIRecommendation.gs` — separate OpenAI recommendation
- `VFCUnderwritingEngine.gs` — shared underwriting helpers used by the production layer
- `SimpleSheetSetup.gs` — required Sheets setup
- `Index.html` — web-app UI
- `appsscript.json` — Apps Script manifest

## Enable Drive API

In Apps Script, open **Services**, add **Drive API**, and use v2.

## OpenAI key

In Apps Script **Project Settings → Script Properties**, add:

`OPENAI_API_KEY`

## First run

Run:

`setupSimpleVFC()`

This preserves the core underwriting sheets and creates the isolated bank-training tabs:

- `BANK_RBC`
- `BANK_TD`
- `BANK_SCOTIA`
- `BANK_BMO`
- `BANK_CIBC`
- `BANK_COAST_CAPITAL`

RBC is marked **LOCKED**. The remaining banks are marked **PENDING_TRAINING**.

## RBC repeatability lock

After validating the approved RBC reference case, run:

`lockBankRegressionBaseline(companyName, period, 'RBC')`

After any future engine change, verify it with:

`verifyBankRegressionBaseline(companyName, period, 'RBC')`

The same statement fingerprint reuses its first verified transaction ledger so repeat uploads do not silently change an already-trained banking result.

## Deployment

Deploy the Apps Script project as a Web App. The UI provides one bank selector for each isolated bank profile plus Training Data and Assessment sections.

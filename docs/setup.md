# Setup Guide

## Google Sheet / Apps Script

Use the Apps Script project attached to the VFC underwriting Google Sheet.

Core files:

- `Code.gs` — upload, OCR, common statement intake and Sheets/Drive plumbing
- `BankingCore.gs` — frozen banking facts and deterministic recurring-obligation math
- `BankRouter.gs` — bank selection and isolation
- `Bank_RBC.gs` — RBC v4.0 generic printed-column candidate
- `Bank_TD.gs` — TD v2.2 candidate
- `Bank_Scotia.gs` — pending training
- `Bank_BMO.gs` — BMO v1.4 candidate
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

RBC, TD and BMO are marked **CANDIDATE** until their deployed live validations are approved. The remaining banks are marked **PENDING_TRAINING**.

## RBC repeatability lock

RBC v4.0 first parses the standard printed Account Activity columns and accepts a statement only when printed credit count, credit total, debit count and debit total all reconcile exactly. If the transcript does not preserve enough table structure, the original-PDF AI recovery remains available behind the same deterministic audit.

After validating an approved live RBC reference case, run:

`lockBankRegressionBaseline(companyName, period, 'RBC')`

After any future engine change, verify it with:

`verifyBankRegressionBaseline(companyName, period, 'RBC')`

The same logical statement reuses its first verified current-rules transaction ledger so repeat uploads do not silently change an approved banking result.

## Training-data boundary

Uploading an assessment or parser-test statement does not create a historical training feature. Training records and structured historical features are created only after an explicit lender decision is saved. Rebuilding structured features also uses outcome-backed cases only.

## Deployment

Deploy the Apps Script project as a Web App. The UI provides one bank selector for each isolated bank profile plus Training Data and Assessment sections.

# VFC Underwriting Flow

## Stage 1 — Application Intake

Collect:
- Business name
- Owner name
- Email and phone
- Industry
- Time in business
- Credit score input
- Estimated monthly sales
- Supporting documents
- Consent acknowledgement

## Stage 2 — Document Storage

MVP options:
1. Google Drive private folder for fastest proof of concept
2. Google Cloud Storage private bucket for stronger production architecture

Never make statement files public.

## Stage 3 — Statement Extraction

Extract and normalize:
- Monthly gross deposits
- Deposit count
- Average monthly deposits
- Average daily balance when available
- Negative balance days
- NSF / returned item count
- Overdraft activity
- Existing MCA or frequent financing debits
- Revenue trend
- Large unusual deposits

## Stage 4 — AI Analysis

AI should return structured extraction and narrative notes. It should not be the sole final decision maker.

## Stage 5 — Deterministic Offer Engine

Rules engine combines:
- Average monthly deposits
- Credit score
- Time in business
- Negative events
- Existing MCA exposure
- Revenue trend
- Industry policy

Output:
- Risk grade
- Suggested low offer
- Suggested high offer
- Conditions
- Recommended review action

## Stage 6 — Premium Admin Dashboard

Show:
- Applicant profile
- Document status
- Monthly deposit chart
- Risk indicators
- AI underwriter notes
- Suggested offer range
- Final amount field
- Conditions field
- Approve button
- Decline button
- Request more docs button
- Send to lender button

## Stage 7 — Human Final Decision

A VFC reviewer confirms or overrides the recommendation.

## Stage 8 — Client Communication

After manual action:
- Send status email
- Record timestamp
- Record reviewer
- Record final amount and conditions
- Maintain audit history

## Stage 9 — Model Improvement

Later capture outcomes:
- Lender submitted to
- Lender decision
- Approved amount
- Funded amount
- Default / performance outcome
- Renewal

These labeled outcomes can eventually support a custom predictive model.

## Current AI Statement Analysis Flow

1. Client submits an application and uploads bank statements through the Client Portal.
2. Uploaded files are stored in that application's Google Drive folder.
3. In the Admin Portal, the underwriter clicks **Run AI Statement Analysis**.
4. Apps Script reads the uploaded statement files from the application's Drive folder and sends them to OpenAI.
5. OpenAI extracts average deposits, withdrawals, NSF count, negative days, MCA payments, cash-flow strength, revenue trend, and underwriter notes.
6. Apps Script appends the extracted data to `Statement Analysis` and writes the offer estimate to `Underwriting Results`.
7. The Admin Portal shows the AI results, suggested offer range, and notes so the admin can approve, decline, request documents, or send to lender.

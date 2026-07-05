# VFC Case Study Training Plan

This document defines how VFC should use existing approvals and declines to build the underwriting engine.

## Starting Point

VFC currently has approximately 50 historical case studies made up of approvals and declines from lender partners.

Current lender partners / underwriting sources:

```txt
Journey Capital
Merchant Growth
iCapital
Canacap Funding
Sheaves Capital
```

Each lender has its own underwriting criteria. The goal is not to copy one lender exactly. The goal is to study patterns across lender decisions and build a VFC recommendation engine that can estimate:

```txt
Eligibility
Risk grade
Likely lender fit
Suggested low offer
Suggested high offer
Likely approval/decline reason
Required conditions
```

## Important Rule

The model should assist underwriting. It should not be the final decision maker.

Final approval should remain manual through the VFC admin dashboard.

---

## Product Structure

The system should have two sides:

```txt
Client Portal
Admin Portal
```

Both should use the same core data fields so the client intake, admin review, AI analysis, and lender matching all work from one consistent dataset.

---

## Client Portal Flow

1. Client creates an account.
2. Client enters business and owner information.
3. Client uploads at least 6 months of bank statements.
4. Client checks preliminary eligibility.
5. Client sees a status dashboard.
6. Client waits for VFC/manual review.
7. If manually approved, client sees the approval/conditional approval in their dashboard.

Client-facing statuses:

```txt
Application Started
Documents Required
Submitted for Review
Under Review
More Information Required
Conditionally Approved
Declined
Sent to Lender
Funded
```

Client should not see internal lender strategy, internal notes, or raw AI scoring unless specifically approved for display.

---

## Admin Portal Flow

1. Admin sees all submitted applications.
2. Admin opens applicant file.
3. Admin reviews business profile, uploaded statements, and AI analysis.
4. Admin sees lender-fit recommendations.
5. Admin can approve, decline, request more documents, or send to lender.
6. Admin enters final amount, conditions, lender, and notes.
7. Client dashboard updates.
8. Decision is stored as feedback for future model improvement.

Admin-only statuses:

```txt
New Submission
AI Analysis Pending
Ready for Review
Manual Review Required
Approved by VFC
Declined by VFC
Submitted to Journey Capital
Submitted to Merchant Growth
Submitted to iCapital
Submitted to Canacap Funding
Submitted to Sheaves Capital
Funded
Lost / Not Proceeding
```

---

## Same Data Fields for Client and Admin

### Applicant / Business Fields

```txt
Application ID
Created Date
Business Legal Name
Operating Name
Owner Name
Email
Phone
Industry
Province
City
Time in Business
Business Start Date
Business Type
Monthly Sales Estimate
Requested Amount
Use of Funds
Credit Score
Consent Checkbox
```

### Bank Statement / Cash Flow Fields

```txt
Number of statements uploaded
Statement months covered
Average monthly deposits
Monthly deposit breakdown
Average daily balance
Lowest balance
Negative days
NSF count
Returned items
Overdraft use
Existing MCA payments
Existing loan payments
CRA / tax payment indicators
Payroll indicators
Rent indicators
Large deposits to verify
Revenue trend
Cash flow strength
```

### Underwriting Fields

```txt
AI risk grade
Rules engine risk grade
Suggested low offer
Suggested high offer
Recommended lender fit
Risk flags
Required conditions
AI underwriter notes
Admin internal notes
Final VFC decision
Final approved amount
Final lender selected
Final conditions
Decline reason
Funded amount
Outcome
```

---

## Historical Case Study Dataset

Each of the 50 historical files should be entered into a structured table.

Recommended columns:

```txt
Case ID
Lender Name
Decision: Approved / Declined
Funded: Yes / No
Approved Amount
Requested Amount
Business Industry
Time in Business
Credit Score
Average Monthly Deposits
NSF Count
Negative Days
Existing MCA Payments
Revenue Trend
Reason Approved
Reason Declined
Conditions
Final Notes
Statement Months Reviewed
Date of Decision
```

The system should use these case studies to create internal lender-fit rules.

Example:

```txt
Journey Capital may tolerate X but not Y.
Merchant Growth may prefer stronger deposit consistency.
iCapital may be stronger for certain risk profiles.
Canacap may fit different industries or lower documentation cases.
Sheaves Capital may have its own pattern for approvals/declines.
```

The exact criteria should be learned from VFC's real historical files, not guessed.

---

## Engine Design

The VFC engine should have three layers.

### Layer 1 — Deterministic Rules

Rules based on clear underwriting logic:

```txt
Minimum 6 months statements
Minimum time in business
Credit score range
Average monthly deposits
NSF / negative day thresholds
Existing MCA stacking exposure
Industry risk
Revenue trend
```

### Layer 2 — OpenAI Analysis

OpenAI reads extracted statement text and returns structured JSON:

```txt
Cash flow summary
Risk flags
Deposit trends
Underwriter notes
Possible lender fit reasoning
```

OpenAI should explain and summarize. It should not make the final approval.

### Layer 3 — Case Study Similarity / Lender Fit

Compare a new application against the 50 historical cases.

Output:

```txt
Most similar past cases
Likely approval range
Likely lender fit
Likely conditions
Potential decline reasons
```

---

## Training / Fine-Tuning Roadmap

Do not fine-tune immediately.

Recommended order:

```txt
1. Enter 50 case studies into a structured dataset.
2. Build rule-based lender-fit logic.
3. Use OpenAI structured extraction for new applications.
4. Save every manual admin decision.
5. Grow the dataset from 50 to 100+ cases.
6. Evaluate consistency.
7. Fine-tune only after the dataset is clean and large enough.
```

Minimum recommended dataset before fine-tuning:

```txt
50 cases: useful for rule design and prompt examples
100 cases: useful for better consistency testing
500 cases: better for meaningful pattern learning
1,000+ cases: stronger candidate for fine-tuning or custom model workflows
```

---

## Immediate Build Priorities

### Priority 1 — Historical Case Study Input Sheet

Create a new Google Sheet tab:

```txt
Historical Cases
```

This will store the 50 approvals/declines.

### Priority 2 — Admin Manual Decision Fields

Admin must be able to save:

```txt
Approved / Declined / More Docs Required
Final amount
Final lender selected
Reason
Conditions
```

### Priority 3 — Client Account / Dashboard

Client should be able to:

```txt
Create account
Submit application
Upload statements
Check status
See approval/decline once admin updates it
Upload additional documents
```

### Priority 4 — Lender Fit Engine

Use the historical cases to recommend:

```txt
Journey Capital
Merchant Growth
iCapital
Canacap Funding
Sheaves Capital
```

---

## Security Notes

Do not put raw case study documents or client bank statements in GitHub.

Case study training data should be redacted and structured.

Remove or mask:

```txt
Full bank account numbers
SIN
Government ID numbers
Client DOB
Home address unless required
Raw bank statement PDFs
Personal documents
```

Use application IDs instead of personal identifiers wherever possible.

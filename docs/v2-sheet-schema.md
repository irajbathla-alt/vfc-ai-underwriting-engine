# VFC AI Underwriting Engine V2 Sheet Schema

Run `setupVFC()` from Apps Script. It creates these tabs.

## Core upload tabs

### Companies
Stores each company or individual borrower folder.

Columns:
- Company ID
- Company Name
- Folder ID
- Folder Link
- Created At

### Uploads
Stores each uploaded bank statement PDF.

Columns:
- Upload ID
- Company ID
- Company Name
- Detected Period
- File Name
- File ID
- File Link
- Status
- Created At

### PDF Summaries
Stores AI summary for each uploaded statement.

Columns:
- Upload ID
- Company Name
- Detected Period
- File Name
- Document Type
- Bank Name
- Account Holder
- Statement Start Date
- Statement End Date
- Opening Balance
- Closing Balance
- Total Deposits
- Total Withdrawals
- NSF Count
- Negative Balance Detected
- Possible MCA Or Loan Payments
- Summary
- Risks
- Missing Info
- Created At

### Batch Summaries
Stores combined summary for the full company/period upload.

Columns:
- Batch ID
- Company Name
- Detected Period
- Files Read
- Earliest Statement Date
- Latest Statement Date
- Combined Summary
- Key Findings
- Risks
- Missing Info
- Created At

## Lender engine tabs

### Lenders
Stores your lender list.

Columns:
- Lender ID
- Lender Name
- Product Type
- Contact Name
- Contact Email
- Notes
- Status
- Created At

### Lender Criteria
Stores lender underwriting criteria.

Columns:
- Criteria ID
- Lender Name
- Minimum Monthly Revenue
- Minimum Time In Business Months
- Province Accepted
- Industry Restrictions
- NSF Tolerance
- Existing MCA Tolerance
- Required Documents
- Notes
- Last Updated

### Lender Decisions
Stores real lender approvals and declines.

Columns:
- Decision ID
- Company Name
- Period
- Lender Name
- Decision
- Approved Amount
- Decline Reason
- Conditions
- Payment Frequency
- Payment Amount
- Factor Rate Or Interest
- Term
- Date Submitted
- Date Decision Received
- Notes
- Created At

### AI Recommendations
Stores AI lender-fit recommendations.

Columns:
- Recommendation ID
- Company Name
- Period
- Recommended Lender
- Fit Level
- Reasoning
- Risks
- Missing Info
- Created At

### Deal Outcomes
Stores final funded or non-funded results.

Columns:
- Outcome ID
- Company Name
- Period
- Selected Lender
- AI Recommended Lender
- Final Result
- Funded Amount
- Funded Date
- Why This Lender Won
- Admin Notes
- Created At

## Recommended workflow

1. Upload bank statements.
2. Save lender criteria.
3. Generate AI recommendation.
4. Submit to lender.
5. Save approval or decline.
6. Save final outcome.

This creates the training dataset for later predictive modeling.

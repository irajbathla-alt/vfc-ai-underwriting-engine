# VFC AI Underwriting Engine

A starter MVP for **Vancouver Finance Company Inc.** to collect Merchant Cash Advance applications, upload/read bank statements, calculate a suggested funding range, and send approval/decline emails after manual review.

## MVP Flow

1. Client submits application through a web form.
2. Bank statements are uploaded and stored securely.
3. Google Sheets stores application records and analysis results.
4. Apps Script acts as the API/backend.
5. OpenAI reads extracted statement text and returns structured underwriting data.
6. Dashboard shows risk grade, low offer, high offer, and underwriter notes.
7. Admin clicks Approve, Decline, Request More Docs, or Send to Lender.
8. Client receives an email automatically.

## Suggested Stack

- Frontend: HTML/CSS/JavaScript first, React/Next.js later
- Backend: Google Apps Script Web App
- Database: Google Sheets
- File Storage: Google Drive first, Google Cloud Storage later
- AI: OpenAI API
- Email: GmailApp / Gmail API

## Folder Structure

```txt
frontend/        Client portal and admin dashboard starter
apps-script/    Google Apps Script backend files
docs/           Product flow, security notes, and underwriting logic
```

## Important Security Notes

Do not commit API keys, client statements, credit reports, IDs, or private client data to GitHub.
Use `.env.example` only as a template.

## First MVP Goal

Build this first:

```txt
Client uploads statements → application saved to Sheet → AI analysis runs → dashboard shows suggested MCA limit → admin approves/declines → email goes to client
```

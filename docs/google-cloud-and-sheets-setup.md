# Google Sheets + Google Cloud Connection Setup

This guide explains how to connect the VFC AI Underwriting Engine to Google Sheets and Google Cloud Storage.

## Current Project Values

```txt
Google Cloud Project ID: project-a528a6b2-3583-415a-bba
Cloud Storage Bucket: vfc-statement-uploads
Service Account Email: vfc-apps-script-storage-43@project-a528a6b2-3583-415a-bba.iam.gserviceaccount.com
```

Important: Do not store private keys, client documents, credit reports, IDs, or API keys in GitHub.

---

## Important Update — Service Account Key Creation Is Disabled

Your Google Cloud project is currently blocking downloadable service account JSON keys because of this organization policy:

```txt
iam.disableServiceAccountKeyCreation
```

This is a security protection. It means you cannot use the old method of downloading a JSON key and pasting private key values into Apps Script.

For this project, use one of these safer paths:

```txt
Option A — MVP: Use Google Drive for file uploads first.
Option B — Production: Use Cloud Run or Cloud Functions to upload files to Cloud Storage without JSON keys.
Option C — Admin-only: Ask an Organization Policy Admin to disable the policy, but this is not recommended for this MVP.
```

Recommended path for VFC right now:

```txt
Use Google Drive for MVP document storage while Sheets, OpenAI analysis, and dashboard workflow are being tested. Add Cloud Storage through Cloud Run/Functions later.
```

Why this matters:

```txt
Apps Script can easily use Google Sheets, Gmail, Drive, and UrlFetchApp.
Apps Script does not automatically become your Cloud Storage service account.
Without JSON keys, direct Cloud Storage authentication from Apps Script becomes more complex.
A Cloud Function or Cloud Run service can use its attached service account without downloadable keys.
```

---

## 1. Create the Google Sheet Database

Create a new Google Sheet named:

```txt
VFC AI Underwriting Database
```

Create these three tabs exactly:

```txt
Applications
Statement Analysis
Underwriting Results
```

Copy the Google Sheet ID from the URL.

Example URL:

```txt
https://docs.google.com/spreadsheets/d/1ABCDEF1234567890/edit#gid=0
```

The Sheet ID is:

```txt
1ABCDEF1234567890
```

Paste it into `apps-script/Code.gs`:

```js
const CONFIG = {
  SHEET_ID: 'PASTE_GOOGLE_SHEET_ID_HERE',
  APPLICATIONS_TAB: 'Applications',
  ANALYSIS_TAB: 'Statement Analysis',
  RESULTS_TAB: 'Underwriting Results',
  ADMIN_EMAIL: 'admin@vancouverfinancecompany.com',
  GCP_PROJECT_ID: 'project-a528a6b2-3583-415a-bba',
  GCS_BUCKET_NAME: 'vfc-statement-uploads',
  GCS_SERVICE_ACCOUNT_EMAIL: 'vfc-apps-script-storage-43@project-a528a6b2-3583-415a-bba.iam.gserviceaccount.com'
};
```

Replace:

```txt
PASTE_GOOGLE_SHEET_ID_HERE
```

with your real Sheet ID.

---

## 2. Create Google Apps Script Project

Open the Google Sheet.

Go to:

```txt
Extensions → Apps Script
```

Create these Apps Script files and paste the matching repo code:

```txt
Code.gs
GoogleSheets.gs
OpenAI.gs
UnderwritingEngine.gs
EmailAutomation.gs
```

For MVP testing, do not worry about CloudStorage.gs yet. Use Google Drive first.

---

## 3. Add OpenAI API Key to Apps Script

In Apps Script:

```txt
Project Settings → Script Properties → Add script property
```

Add:

```txt
Property: OPENAI_API_KEY
Value: your_real_openai_api_key
```

Do not paste your OpenAI API key into GitHub code.

---

## 4. Run Database Setup

In Apps Script, run:

```js
setupDatabaseSheets()
```

The first time, Google will ask for permissions.

Allow permissions for:

```txt
Google Sheets
Email sending
External API calls
```

---

## 5. Deploy Apps Script as Web App

In Apps Script:

```txt
Deploy → New deployment → Web app
```

Recommended MVP settings:

```txt
Execute as: Me
Who has access: Anyone
```

Copy the Web App URL.

It will look like:

```txt
https://script.google.com/macros/s/AKfycbyUa5nDM4ytZi3AH1vIokbz9LnOx_PpNNuPER_CoUaDtf3sYT4jNMRuOMLjr7kxIsc/exec
```

Paste this URL into:

```txt
frontend/script.js
```

Replace:

```js
const APPS_SCRIPT_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyUa5nDM4ytZi3AH1vIokbz9LnOx_PpNNuPER_CoUaDtf3sYT4jNMRuOMLjr7kxIsc/exec";
```

with your real Web App URL.

---

## 6. Recommended MVP File Storage — Google Drive

Because service account JSON key creation is disabled, Google Drive is the fastest MVP route.

### Step 6.1 — Create private Drive folder

In Google Drive, create a folder named:

```txt
VFC Statement Uploads
```

Do not make this folder public.

### Step 6.2 — Copy folder ID

Open the folder. The URL will look like:

```txt
https://drive.google.com/drive/folders/FOLDER_ID_HERE
```

Copy only:

```txt
FOLDER_ID_HERE
```

### Step 6.3 — Add folder ID to Apps Script Properties

In Apps Script:

```txt
Project Settings → Script Properties → Add script property
```

Add:

```txt
Property: DRIVE_UPLOAD_FOLDER_ID
Value: your_real_folder_id
```

This lets Apps Script save uploaded documents to Drive without service account keys.

---

## 7. Google Cloud Storage Setup — Already Created

You created:

```txt
Project ID: project-a528a6b2-3583-415a-bba
Bucket Name: vfc-statement-uploads
Service Account Email: vfc-apps-script-storage-43@project-a528a6b2-3583-415a-bba.iam.gserviceaccount.com
```

Recommended bucket settings:

```txt
Public access prevention: Enforced / On
Uniform bucket-level access: Enabled
Location: Canada if available
Storage class: Standard
```

This bucket can be used later when we add a Cloud Function or Cloud Run upload API.

---

## 8. Production Cloud Storage Path Without JSON Keys

Use this later when the MVP works.

```txt
Frontend → Cloud Function / Cloud Run upload endpoint → Cloud Storage bucket → File URL saved to Google Sheet
```

The Cloud Function or Cloud Run service should run as:

```txt
vfc-apps-script-storage-43@project-a528a6b2-3583-415a-bba.iam.gserviceaccount.com
```

Then it can upload to:

```txt
vfc-statement-uploads
```

without downloading a JSON private key.

This is more secure than service account keys.

---

## 9. What Not To Do

Do not try to bypass the organization policy unless you fully understand the security risk.

Do not request disabling this policy just to make the MVP work.

Do not store a service account JSON private key in:

```txt
GitHub
Frontend code
Google Sheets
Email
Client-side JavaScript
```

---

## 10. Values You Need to Connect Everything

You need these final values:

```txt
Google Sheet ID
Apps Script Web App URL
OpenAI API Key
Google Drive Folder ID for MVP uploads
Admin Email
```

Later production values:

```txt
Cloud Storage Bucket Name
Cloud Function or Cloud Run upload endpoint
Service Account Email
```

Once those are added, the MVP can follow this flow:

```txt
Frontend form → Apps Script Web App → Google Sheet row → Google Drive document storage → OpenAI analysis → underwriting result → dashboard → client email
```

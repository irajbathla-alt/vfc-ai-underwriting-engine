# Google Sheets + Google Cloud Connection Setup

This guide explains how to connect the VFC AI Underwriting Engine to Google Sheets and Google Cloud Storage.

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
  ADMIN_EMAIL: 'admin@vancouverfinancecompany.com'
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
CloudStorage.gs
```

For MVP testing, you can start without CloudStorage.gs and use Google Drive file links first.

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
https://script.google.com/macros/s/AKfycbxxxxxxx/exec
```

Paste this URL into:

```txt
frontend/script.js
```

Replace:

```js
const APPS_SCRIPT_WEB_APP_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
```

with your real Web App URL.

---

## 6. Google Cloud Storage Setup — Click-by-Click

Use Google Cloud Storage for private statement/document storage.

### Step 6.1 — Open Google Cloud Console

Go to:

```txt
https://console.cloud.google.com
```

Sign in with the Google account you want to use for the VFC project.

### Step 6.2 — Create or choose a project

At the top left, click the project dropdown.

Then choose one of these:

```txt
Select existing project
```

or

```txt
New Project
```

Recommended project name:

```txt
VFC AI Underwriting Engine
```

After creating the project, make sure it is selected in the top project dropdown.

### Step 6.3 — Make sure billing is connected

Google Cloud usually requires billing for Cloud Storage.

Go to:

```txt
Billing
```

Attach a billing account if Google asks for it.

### Step 6.4 — Enable Cloud Storage API

In Google Cloud Console search bar, search:

```txt
Cloud Storage API
```

Open it and click:

```txt
Enable
```

If it already says enabled, move to the next step.

### Step 6.5 — Go to Buckets

In the search bar, search:

```txt
Cloud Storage Buckets
```

Open:

```txt
Cloud Storage → Buckets
```

Click:

```txt
Create
```

### Step 6.6 — Name the bucket

Bucket names must be globally unique across Google Cloud, so `vfc-statement-uploads` may already be taken.

Try one of these:

```txt
vfc-statement-uploads
vfc-statement-uploads-raj
vfc-underwriting-statements
vfc-underwriting-statements-prod
```

Best recommendation:

```txt
vfc-underwriting-statements-prod
```

Do not use spaces or capital letters.

### Step 6.7 — Choose location

Choose:

```txt
Region
```

Then choose a Canadian region if available:

```txt
northamerica-northeast1 (Montréal)
```

or

```txt
northamerica-northeast2 (Toronto)
```

If you cannot find Canada, choose the closest region you prefer.

### Step 6.8 — Choose storage class

Choose:

```txt
Standard
```

This is best for documents you may need to read soon after upload.

### Step 6.9 — Access control settings

Choose:

```txt
Uniform bucket-level access: Enabled
```

Do not choose fine-grained access for this MVP.

### Step 6.10 — Public access prevention

Set:

```txt
Public access prevention: Enforced / On
```

This helps prevent uploaded documents from becoming public.

### Step 6.11 — Data protection

For MVP, use defaults.

Recommended:

```txt
Soft delete: On if available
Object versioning: Off for MVP
Retention policy: Off for MVP
Encryption: Google-managed encryption key
```

Later, production can use stronger retention and key management.

### Step 6.12 — Create bucket

Click:

```txt
Create
```

Your private bucket is now ready.

### Step 6.13 — Copy bucket name

After creation, copy the bucket name exactly.

Example:

```txt
vfc-underwriting-statements-prod
```

This value will later go into Apps Script as:

```txt
GCS_BUCKET_NAME
```

---

## 7. Service Account Setup for Cloud Storage

The service account allows the backend to upload files into the private bucket.

### Step 7.1 — Create service account

In Google Cloud Console, go to:

```txt
IAM & Admin → Service Accounts → Create Service Account
```

Name:

```txt
vfc-apps-script-storage
```

Service account ID will look like:

```txt
vfc-apps-script-storage@your-project-id.iam.gserviceaccount.com
```

### Step 7.2 — Give bucket permission only

Go back to:

```txt
Cloud Storage → Buckets → your bucket → Permissions
```

Click:

```txt
Grant Access
```

New principal:

```txt
vfc-apps-script-storage@your-project-id.iam.gserviceaccount.com
```

Role:

```txt
Storage Object Admin
```

For production, you can reduce this later to tighter permissions.

### Step 7.3 — Create service account key

Go to:

```txt
IAM & Admin → Service Accounts → vfc-apps-script-storage → Keys
```

Click:

```txt
Add Key → Create new key → JSON
```

Download the JSON key.

Important:

```txt
Do not upload this JSON key to GitHub.
Do not email it.
Do not paste it into frontend code.
```

For Apps Script MVP, store needed key values in Apps Script Properties or use Google Drive first until Cloud Storage upload code is finalized.

---

## 8. MVP Shortcut: Use Google Drive First

For fastest MVP, store files in a private Google Drive folder first.

Create a folder:

```txt
VFC Statement Uploads
```

Copy folder ID from URL:

```txt
https://drive.google.com/drive/folders/FOLDER_ID_HERE
```

Then store uploaded file links in the `Document Links` column of the Applications tab.

This is easier than Cloud Storage for the first test version.

---

## 9. Production Security Notes

Never store these in GitHub:

```txt
OpenAI API keys
Google service account private keys
Client statements
IDs
Credit reports
Banking details
```

Use:

```txt
Apps Script Properties
Google Secret Manager
Private Cloud Storage buckets
Restricted Google Drive folders
```

---

## 10. Values You Need to Connect Everything

You need these final values:

```txt
Google Sheet ID
Apps Script Web App URL
OpenAI API Key
Google Drive Folder ID or Cloud Storage Bucket Name
Admin Email
```

Once those are added, the system can follow this flow:

```txt
Frontend form → Apps Script Web App → Google Sheet row → Document storage → OpenAI analysis → underwriting result → dashboard → client email
```

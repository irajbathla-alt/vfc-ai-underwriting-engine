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

## 6. Google Cloud Storage Setup

In Google Cloud Console:

1. Create or choose a project.
2. Enable Cloud Storage API.
3. Create a private bucket.

Recommended bucket name:

```txt
vfc-statement-uploads
```

Recommended settings:

```txt
Public access prevention: On
Uniform bucket-level access: On
Location: Canada if available
```

Do not make uploaded documents public.

---

## 7. Service Account Setup for Cloud Storage

In Google Cloud Console:

```txt
IAM & Admin → Service Accounts → Create Service Account
```

Name:

```txt
vfc-apps-script-storage
```

Give it access to the bucket only, using:

```txt
Storage Object Admin
```

For production, use the least permissions possible.

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

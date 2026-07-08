# Setup Guide

## Google Sheet

Create a Google Sheet named `VFC AI Document Engine`.

Open the sheet, then go to:

Extensions > Apps Script

## Apps Script files

Copy these files into Apps Script:

- `apps-script/Code.gs`
- `apps-script/Index.html`
- `apps-script/appsscript.json`

## Enable Drive API

In Apps Script:

1. Open Services
2. Add a service
3. Select Drive API
4. Use version v2
5. Save

## OpenAI key

In Apps Script settings, add Script Property:

`OPENAI_API_KEY`

Paste your OpenAI API key as the value.

## First run

Run this function once:

`setupVFC`

It creates these tabs:

- Companies
- Uploads
- PDF Summaries
- Batch Summaries
- Settings

## Deploy

Deploy > New deployment > Web app

Recommended settings:

- Execute as: Me
- Who has access: Only myself or your organization

## Drive folder structure

The app creates:

`VFC AI Engine / Company Name / Detected Period`

Example:

`VFC AI Engine / ABC Pizza Ltd / Jan 2026 to Jun 2026`

## V1 scope

Upload bank statements only. Tax documents are intentionally excluded for now.

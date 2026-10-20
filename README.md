# Rubber Ledger

Voice-first app for the family rubber latex business: log production, sales, expenses and wages by voice on your iPhone (Safari), keep every entry in your own Google Sheet, and see monthly and financial-year (April–March) reports.

Everything is free: GitHub Pages hosts the app, a Google Apps Script attached to your sheet saves the data.

## What's in this folder

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css`, `js/` | The app (upload to GitHub) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and Home Screen icon (upload to GitHub) |
| `apps-script/Code.gs` | Backend: paste into the Google Sheet's Apps Script editor (add your OAuth Client ID at the top) |
| `tests/` | Parser tests (`node tests/parser.test.js`), optional |

## One-time setup (about 20 minutes)

### 1. Google sign-in (OAuth Client ID, free, about 5 minutes)

1. Open [console.cloud.google.com](https://console.cloud.google.com) with your Google account and create a project, e.g. **Rubber Ledger**.
2. Go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Branding**). Choose **External**, app name **Rubber Ledger**, your email as support and developer contact, and save. Under **Audience**, click **Publish app** (only the basic sign-in scopes are used, so no Google review is needed).
3. Go to **Credentials → Create credentials → OAuth client ID**. Type: **Web application**. Under **Authorized JavaScript origins** add `https://yumenoyado.github.io`. Create, and copy the **Client ID** (ends with `.apps.googleusercontent.com`).

### 2. Google Sheet and backend

1. Go to [sheets.google.com](https://sheets.google.com) and create a blank sheet named **Rubber Business Ledger**.
2. Open **Extensions → Apps Script**. Delete the sample code, paste the whole of `apps-script/Code.gs`, replace `PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com` near the top with your Client ID, and click **Save**.
3. In the function list at the top, choose **setup** and click **Run**. Approve the permission prompts (Google will warn that the app is unverified because you wrote it: click *Advanced → Go to project*).
4. Back in the sheet, reload the page. A **Rubber Ledger** menu appears. Only the Google account that owns the sheet may sign in; to allow other accounts use **Rubber Ledger → Allowed Google accounts…**.
5. In Apps Script, click **Deploy → New deployment → Select type: Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (ends with `/exec`).

"Anyone" lets the iPhone reach the script; the script itself refuses every request unless the phone has signed in with an allowed Google account (or carries the backup access key). A phone stays signed in for 180 days. To sign out every phone, use **Rubber Ledger → Sign out all phones**. The backup access key (**Rubber Ledger → Show access key**) is only needed if you don't use Google sign-in; if it ever leaks, use **Create a new access key**.

### 3. The app on GitHub Pages

The app is hosted from this repository, [yumenoyado/FamilyBusiness](https://github.com/yumenoyado/FamilyBusiness), at:

**https://yumenoyado.github.io/FamilyBusiness/**

(GitHub **Settings → Pages**: *Deploy from a branch*, branch **main**, folder **/ (root)**.)

No keys or sheet links are stored in GitHub; they are typed into the app on the phone.

### 4. iPhone

1. **Settings → General → Keyboard → Enable Dictation** (on). Also check **Settings → Safari → Microphone** is set to *Ask* or *Allow*.
2. Open **https://yumenoyado.github.io/FamilyBusiness/** in **Safari**.
3. In the app, open **Settings**, check the **Google ID** (already filled in as prakashrtvm@gmail.com), then tap **Sign in with Google**. Google pre-selects that account; if a different one is picked, the app asks you to sign in again. Another Google ID works only after it is added in the sheet under **Rubber Ledger → Allowed Google accounts**.
4. Add your workers (tappers, labourers) with their daily rate.
5. Tap **Share → Add to Home Screen**. If iOS shows **Open as Web App**, switch it **off** — the microphone only works when the app opens in Safari.
6. Five-minute voice test: tap the mic and say "Collected 38 kg latex DRC 34". Allow the microphone when asked.

## Using it

Tap the mic and speak; the words appear in the box until you tap **Go**. While speaking, saying **"delete"** removes the word before it straight away (say it twice to remove two words).

A card shows what was understood and saves itself after **3 seconds** (change this in Settings). Before it saves:

- say **"delete"** (or tap Delete) to throw it away
- say **"change amount to 7800"** or **"delete amount"** to fix one field, or tap **Edit**
- say **"save"** to save immediately

After saving, tap **Undo** on the message, or tap the mic and say **"delete"** / **"delete last 3"**.

Examples:

| Say | Saved as |
| --- | --- |
| Collected 38 kg latex, DRC 34 | Production · Latex · 38 kg · 12.9 kg dry |
| Sold 40 kg latex, DRC 35, at 190 to society | Income · Latex sale · 40 kg × 35% = 14 kg dry × ₹190 = ₹2,660 |
| Sold 50 kg sheet at 190 | Income · Sheet sale · ₹9,500 |
| Paid tapper Raju 800 | Expense · Tapping wages · Raju · ₹800 |
| Suma 3 days weeding | Expense · Weeding/labour · Suma · 3 days × her rate |
| Fertilizer 2 bags 1450 each | Expense · Fertilizer · ₹2,900 |
| Acid 600 yesterday | Expense · Acid & chemicals · ₹600 · yesterday's date |

Latex is weighed in kg (wet weight). Dry rubber kg = wet kg × DRC %, and the latex sale rate is ₹ per kg of dry rubber. (If you ever say litres, the app converts with the density in Settings, default 1.0 kg per litre.)

If the in-app mic doesn't work, tap the entry box and use the **mic key on the iPhone keyboard**, then tap **Go** — the same words and commands work.

Entries are kept **on the phone** (marked *on phone*) until you send them. Sync only happens when you ask: tap **Sync N** at the top right, the **Sync to Google Sheet** button on Home, or the one in Settings. Until then you can still edit or delete them, and deleted ones never reach the sheet. Sync regularly (at least weekly): Safari can clear data for sites unused for 7 days.

## Your Google Sheet

The app saves to a Google Sheet called **FamilyBusiness** in your Drive. If a sheet with that name exists, new entries are added to it; if not, it is created with all tabs. After a sync, each sent entry is marked **✓ archived** in the app. Archived entries stay on the phone (and in your reports) until you remove them yourself: open one and tap **Remove from phone**. Removing it from the phone leaves it in the sheet. Archived entries are read-only in the app; change them in the sheet.

| Tab | Contents |
| --- | --- |
| Transactions | One row per entry. Deleted entries are kept with Status = Deleted. |
| Workers | Name, role, wage basis, default rate, active |
| Categories | Category list (for reference) |
| Summary | Monthly and financial-year totals, dry kg produced, wages per worker — formulas, update automatically |
| Settings | Reference values |

You can edit rows directly in the sheet (the app does not copy them back to the phone). Keep the ID column unchanged.

## Updating the backend later

After changing `Code.gs`, use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. This keeps the same Web App URL.

## Updating the app later

Upload the changed files to the GitHub repository. Also change `CACHE = 'rubber-ledger-v9'` in `sw.js` to `v10`, `v11`… so phones pick up the new version.

# Deploying to cPanel (subdomain + Git Version Control)

This app is a static frontend (`index.html`, `app.js`, `styles.css`) plus a small
PHP backend (`upload.php`, `convert.php`, `delete.php`, `restore.php`) routed by
`.htaccess`. The Python files (`server.py`, `server.ps1`) are **local dev only**
and are not used on cPanel (the `.htaccess` blocks direct access to them).

Repo: `https://github.com/chocho04/doc-transcriber-app.git` (branch `main`)

---

## 1. Create the subdomain
cPanel → **Domains** → create e.g. `app.yourdomain.com`. Note its **Document Root**.

## 2. Clone the repo with cPanel Git
cPanel → **Git™ Version Control** → **Create**:
- **Clone URL:** `https://github.com/chocho04/doc-transcriber-app.git`
- **Repository Path:** set to the subdomain's **Document Root** so files are served
  directly (e.g. `/home/USER/app.yourdomain.com`).
  - If cPanel refuses to clone into a non-empty folder, clone to a fresh path and
    then point the subdomain's Document Root at that path.
- **Branch:** `main`

The app is then live at `https://app.yourdomain.com/`.

## 3. Set the PHP version
cPanel → **MultiPHP Manager** → set the subdomain to **PHP 8.1+** (8.3 recommended;
7.4 is the minimum).

## 4. HTTPS
Ensure the subdomain has an SSL cert (cPanel **AutoSSL**). The app calls the Gemini
API over HTTPS, so the site must be HTTPS to avoid mixed-content errors.

## 5. uploads/ folder permissions
The PHP scripts create `uploads/` automatically (mode 0755). If uploads fail with a
"not writable" error, set `uploads/` to **755** (or **775**) in File Manager.

## 6. Configure API keys (in the app, not on the server)
Open the site → **Settings** (gear icon; admin password default **1234**) and enter:
- **Gemini API key** — required for document transcription.
- **CloudConvert API key** — required to convert non-image files (doc/docx/xls/rtf/
  ppt/odt…). Images and PDFs don't need it.

## 7. Updating later
Push to GitHub, then cPanel → **Git Version Control** → **Manage** → **Pull**
(Update from Remote). No build step.

---

## Endpoints (handled by `.htaccess` → PHP)
| Route | File | Purpose |
|---|---|---|
| `POST /api/upload-file` | `upload.php` | save a file into `uploads/`, return its URL |
| `POST /api/delete-file` | `delete.php` | remove a file from `uploads/` |
| `POST /api/restore-file` | `restore.php` | write a backup file back into `uploads/` (name preserved) |
| `POST /api/convert-to-pdf` | `convert.php` | convert a doc to PDF/PNG (LibreOffice, else CloudConvert) |

## PHP requirements
- `mod_rewrite` (standard on cPanel) for `.htaccess` routing.
- `.user.ini` sets upload size limits (64M) and `enable_post_data_reading = Off`
  (lets the PHP read raw JSON bodies); leave it as-is.

## Backup / restore
The in-app **Backup** bundles the actual `uploads/` files into the ZIP; **Restore**
writes them back under their original names so references stay valid — works across
servers/migrations.

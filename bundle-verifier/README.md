# Kifaayat Photo Bundle Verification

A small tool that checks the photo bundle is healthy before we run the migration. It reads files locally and writes a JSON report — **no internet, no uploads, no credentials needed.** Nothing leaves your computer except the report file you send back.

---

## What you need

1. **Node.js 18 or later.** If you don't have it, download from <https://nodejs.org> (the LTS version is fine — takes ~5 min to install).
2. The folder containing your photo files. The script doesn't care where it lives — just needs the path to it.

Check Node.js is installed by opening Terminal (Mac) or PowerShell (Windows) and running:

```bash
node --version
```

If you see something like `v20.x.x`, you're set.

---

## How to run

### Step 1 — Open Terminal in this folder

On Mac: right-click the `bundle-verifier` folder in Finder → "New Terminal at Folder".
On Windows: open this folder in File Explorer → click address bar → type `cmd` → press Enter.

### Step 2 — Run the verifier

Replace `/path/to/your/bundle` with the actual path to your photo bundle:

```bash
node verify-bundle.mjs --folder /path/to/your/bundle
```

On Mac, paths look like: `/Users/megha/Downloads/kifaayat-photos`
On Windows, paths look like: `C:\Users\Megha\Downloads\kifaayat-photos`

### Step 3 — Wait for it to finish

You'll see progress lines like:

```
Scanning /Users/megha/Downloads/kifaayat-photos...
Found 11234 entries to scan

  scanned 1000/11234 (9%)
  scanned 2000/11234 (18%)
  ...
```

For a ~112 GB bundle with ~10–15K files, expect **1–3 minutes** on an SSD.

### Step 4 — Send the report back

The script creates a file called `bundle-report.json` in the current folder. Send that file to Aditya — that's all we need.

---

## What it checks

- **Total file count** — confirms the bundle extracted completely.
- **File formats** — detects JPEG, PNG, HEIC, WebP, GIF, BMP, TIFF from each file's binary header (not the extension, since your files don't have one).
- **File sizes** — min, median, average, max, p95. Useful for estimating cutover upload time.
- **Anomalies**:
  - Files with non-UUID names (we expect every photo named like `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`)
  - Zero-byte files (sign of download corruption)
  - Subdirectories (we expect a flat layout)
  - Files with unrecognised image formats (could be side-cars, junk, or new formats we haven't seen)
  - Permission / read errors

If anything's off, it'll be in the report's `concerns` section so we can plan around it before cutover.

---

## Privacy

This tool reads files on your machine and writes a summary report. It does NOT:

- Upload any photos anywhere
- Read photo CONTENTS (only the first 12 bytes of each file, which is enough to identify the format)
- Send anything over the network
- Access your Supabase, Stripe, or any other accounts

The output JSON contains only counts, file sizes, and a handful of filenames as samples. No image data, no personal user information.

You can open `verify-bundle.mjs` in any text editor and read what it does — it's about 250 lines.

---

## Trouble?

If the script errors or you're unsure about a result, just send a screenshot to Aditya and we'll sort it out.

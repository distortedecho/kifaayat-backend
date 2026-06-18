#!/usr/bin/env node
// ============================================================
// Kifaayat photo bundle verification
//
// Pure local file scan — no internet, no uploads, no credentials.
// Reads each file's first 12 bytes to detect format from binary
// magic bytes, then writes a JSON report describing what's in
// the bundle.
//
// Usage:
//   node verify-bundle.mjs --folder /path/to/photo/bundle
//
// Send the resulting bundle-report.json back to Aditya.
// ============================================================

import {
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

// ---- CLI args ----

const args = process.argv.slice(2);
let folder = null;
let outputFile = "bundle-report.json";

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--folder" || a === "-f") folder = args[++i];
  else if (a === "--output" || a === "-o") outputFile = args[++i];
  else if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(1);
  }
}

if (!folder) {
  console.error("Error: --folder is required\n");
  printHelp();
  process.exit(1);
}

const resolvedFolder = resolve(process.cwd(), folder);

// ---- Magic-byte format detection ----

function detectType(buf) {
  if (buf.length < 12) return "too_small";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "png";
  // GIF: 47 49 46 38 (37|39) 61
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  )
    return "gif";
  // WebP: RIFF ... WEBP
  if (
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  // HEIC/HEIF: ftyp(heic|heix|hevc|hevx|mif1|msf1) at offset 4
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand))
      return "heic";
  }
  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  // TIFF: II*\0 or MM\0*
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  )
    return "tiff";
  return "unknown";
}

// ---- Helpers ----

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidName(name) {
  const base = name.includes(".")
    ? name.substring(0, name.lastIndexOf("."))
    : name;
  return UUID_REGEX.test(base);
}

function bytesToReadable(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// ---- Scan ----

console.log(`Scanning ${resolvedFolder}...`);
const startTime = Date.now();

let entries;
try {
  entries = readdirSync(resolvedFolder, { withFileTypes: true });
} catch (err) {
  console.error(`Failed to read folder: ${err.message}`);
  process.exit(1);
}

console.log(`Found ${entries.length} entries to scan\n`);

const formatCounts = {};
let totalFiles = 0;
let totalBytes = 0;
let sizeMin = Infinity;
let sizeMax = 0;
const sizes = [];
const anomalies = {
  non_uuid_filenames: [],
  zero_byte_files: [],
  subdirectories: [],
  unknown_format_samples: [],
  hidden_files: [],
  read_errors: [],
};

const ANOMALY_SAMPLE_LIMIT = 25;

for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];

  if (entry.isDirectory()) {
    if (anomalies.subdirectories.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.subdirectories.push(entry.name);
    }
    continue;
  }
  if (entry.name.startsWith(".")) {
    if (anomalies.hidden_files.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.hidden_files.push(entry.name);
    }
    continue;
  }
  if (!entry.isFile()) continue;

  const fullPath = resolve(resolvedFolder, entry.name);
  let size;
  try {
    size = statSync(fullPath).size;
  } catch (err) {
    if (anomalies.read_errors.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.read_errors.push({ name: entry.name, error: err.message });
    }
    continue;
  }

  totalFiles += 1;
  totalBytes += size;
  if (size < sizeMin) sizeMin = size;
  if (size > sizeMax) sizeMax = size;
  sizes.push(size);

  if (!isUuidName(entry.name)) {
    if (anomalies.non_uuid_filenames.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.non_uuid_filenames.push(entry.name);
    }
  }

  if (size === 0) {
    formatCounts.zero_byte = (formatCounts.zero_byte || 0) + 1;
    if (anomalies.zero_byte_files.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.zero_byte_files.push(entry.name);
    }
    continue;
  }

  let headerBuf;
  try {
    const fd = openSync(fullPath, "r");
    headerBuf = Buffer.alloc(12);
    readSync(fd, headerBuf, 0, 12, 0);
    closeSync(fd);
  } catch (err) {
    if (anomalies.read_errors.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.read_errors.push({ name: entry.name, error: err.message });
    }
    continue;
  }

  const type = detectType(headerBuf);
  formatCounts[type] = (formatCounts[type] || 0) + 1;
  if (type === "unknown") {
    if (anomalies.unknown_format_samples.length < ANOMALY_SAMPLE_LIMIT) {
      anomalies.unknown_format_samples.push(entry.name);
    }
  }

  if ((i + 1) % 1000 === 0) {
    const pct = Math.round(((i + 1) / entries.length) * 100);
    console.log(`  scanned ${i + 1}/${entries.length} (${pct}%)`);
  }
}

// ---- Size distribution ----

sizes.sort((a, b) => a - b);
const p50 = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 0;
const p95 = sizes.length > 0 ? sizes[Math.floor(sizes.length * 0.95)] : 0;
const avg = sizes.length > 0 ? Math.round(totalBytes / sizes.length) : 0;

const elapsedSec = parseFloat(((Date.now() - startTime) / 1000).toFixed(2));

// ---- Build report ----

const report = {
  scanned_at: new Date().toISOString(),
  folder: resolvedFolder,
  scan_duration_seconds: elapsedSec,
  total_files: totalFiles,
  total_bytes: totalBytes,
  total_size_readable: bytesToReadable(totalBytes),
  by_format: formatCounts,
  size_distribution: {
    min_bytes: sizeMin === Infinity ? 0 : sizeMin,
    max_bytes: sizeMax,
    avg_bytes: avg,
    p50_bytes: p50,
    p95_bytes: p95,
    min_readable: bytesToReadable(sizeMin === Infinity ? 0 : sizeMin),
    max_readable: bytesToReadable(sizeMax),
    avg_readable: bytesToReadable(avg),
  },
  anomalies,
};

// ---- Health verdict ----

const concerns = [];
if (totalFiles === 0) concerns.push("No files found in folder");
if (anomalies.non_uuid_filenames.length > 0) {
  concerns.push(
    `${anomalies.non_uuid_filenames.length}${
      anomalies.non_uuid_filenames.length === ANOMALY_SAMPLE_LIMIT ? "+" : ""
    } files with non-UUID names (expected UUID-only filenames)`
  );
}
if (anomalies.zero_byte_files.length > 0) {
  concerns.push(
    `${anomalies.zero_byte_files.length}${
      anomalies.zero_byte_files.length === ANOMALY_SAMPLE_LIMIT ? "+" : ""
    } zero-byte files (possible download corruption)`
  );
}
if (anomalies.subdirectories.length > 0) {
  concerns.push(
    `${anomalies.subdirectories.length} subdirectory/ies found (expected flat structure)`
  );
}
if (anomalies.unknown_format_samples.length > 0) {
  concerns.push(
    `${anomalies.unknown_format_samples.length}${
      anomalies.unknown_format_samples.length === ANOMALY_SAMPLE_LIMIT ? "+" : ""
    } files with unrecognised image format`
  );
}
if (anomalies.read_errors.length > 0) {
  concerns.push(
    `${anomalies.read_errors.length}${
      anomalies.read_errors.length === ANOMALY_SAMPLE_LIMIT ? "+" : ""
    } files we couldn't read (permission or corruption)`
  );
}

report.summary = {
  healthy: concerns.length === 0,
  concerns,
};

// ---- Console output ----

console.log("\n========== BUNDLE VERIFICATION REPORT ==========\n");
console.log(`Total files:    ${report.total_files.toLocaleString()}`);
console.log(`Total size:     ${report.total_size_readable}`);
console.log(`Scan time:      ${report.scan_duration_seconds}s\n`);
console.log("Format breakdown:");
for (const [fmt, count] of Object.entries(report.by_format).sort(
  (a, b) => b[1] - a[1]
)) {
  console.log(`  ${fmt.padEnd(12)} ${count.toLocaleString()}`);
}
console.log("\nSize distribution:");
console.log(`  min:    ${report.size_distribution.min_readable}`);
console.log(`  median: ${bytesToReadable(p50)}`);
console.log(`  avg:    ${report.size_distribution.avg_readable}`);
console.log(`  p95:    ${bytesToReadable(p95)}`);
console.log(`  max:    ${report.size_distribution.max_readable}`);

if (concerns.length > 0) {
  console.log("\n⚠️  Concerns:");
  for (const c of concerns) console.log(`  - ${c}`);
} else {
  console.log("\n✅ No concerns. Bundle looks healthy.");
}

writeFileSync(outputFile, JSON.stringify(report, null, 2));
console.log(`\nFull report written to: ${outputFile}`);
console.log("Send this file back to Aditya.\n");

// ---- Help ----

function printHelp() {
  console.log(`
Kifaayat photo bundle verification

Pure local file scan — no internet, no uploads, no credentials needed.
Reads each file's binary header to detect format, then writes a JSON
report.

Usage:
  node verify-bundle.mjs --folder <path> [--output <file>]

Options:
  --folder <path>   Path to the photo bundle folder (required)
  --output <file>   Output report filename (default: bundle-report.json)
  --help            Show this help

Example:
  node verify-bundle.mjs --folder /Users/megha/Downloads/kifaayat-photos
`);
}

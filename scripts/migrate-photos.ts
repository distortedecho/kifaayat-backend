// ============================================================
// Sharetribe photo bundle importer
//
// Two modes:
//
// TEST mode (--test)
//   Distributes a small set of sample photos across the top N
//   migrated listings. Validates the upload/storage/DB-link
//   pipeline end-to-end without needing UUID-matching against
//   real production data. Use when running on dev with the
//   synthetic data + a handful of sample photos from the client.
//
//     tsx scripts/migrate-photos.ts \
//       --photos-folder ./sample-da \
//       --test --target-listings 25
//
// PRODUCTION mode (default)
//   Reads the bundle metadata JSON (same shape as the existing
//   Sharetribe export). For every listing, matches UUIDs in
//   `attributes.images[]` against files in --photos-folder. For
//   every user, matches `attributes.profile.avatar` against a file.
//   Uploads each photo to Supabase Storage, writes URLs back to
//   `listing_photos.url` and `profiles.avatar_url`.
//
//     tsx scripts/migrate-photos.ts \
//       --bundle-metadata /path/to/bundle.json \
//       --photos-folder /path/to/photos \
//       --commit
//
// Filenames in --photos-folder are UUIDs WITHOUT extensions
// (confirmed from client's sample). Content type is sniffed from
// the binary magic bytes at upload time.
//
// Resumable: every upload checks if a `listing_photos` row already
// references this photo's storage_path; if so, skipped. Storage
// uploads use `upsert: false` so a half-finished run + re-run won't
// double-upload.
// ============================================================

import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface CliArgs {
  bundleMetadata: string | null;
  photosFolder: string;
  testMode: boolean;
  targetListings: number;
  dryRun: boolean;
  bucket: string;
  photoType: "product" | "brand_tag" | "receipt";
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let bundleMetadata: string | null = null;
  let photosFolder = "./sample-da";
  let testMode = false;
  let targetListings = 25;
  let dryRun = true; // safe default
  let bucket = "listing-photos";
  let photoType: "product" | "brand_tag" | "receipt" = "product";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bundle-metadata") bundleMetadata = args[++i];
    else if (a === "--photos-folder") photosFolder = args[++i];
    else if (a === "--test") testMode = true;
    else if (a === "--target-listings") targetListings = parseInt(args[++i], 10);
    else if (a === "--commit") dryRun = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--bucket") bucket = args[++i];
    else if (a === "--photo-type") {
      const v = args[++i];
      if (v !== "product" && v !== "brand_tag" && v !== "receipt") {
        console.error(`Invalid --photo-type: ${v}`);
        process.exit(1);
      }
      photoType = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }

  return {
    bundleMetadata,
    photosFolder: resolve(process.cwd(), photosFolder),
    testMode,
    targetListings,
    dryRun,
    bucket,
    photoType,
  };
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/migrate-photos.ts [options]

Modes:
  Test:        --test --target-listings <N>
  Production:  --bundle-metadata <path>

Common options:
  --photos-folder <path>   Directory containing UUID-named photo files
  --commit                 Actually upload (default is dry-run)
  --bucket <name>          Supabase storage bucket (default: listing-photos)
  --photo-type <type>      product | brand_tag | receipt (default: product)
  -h, --help               Show this help

Environment:
  SUPABASE_URL                  Required
  SUPABASE_SERVICE_ROLE_KEY     Required (storage uploads need service role)
`);
}

// ============================================================
// Content-type detection from magic bytes (since photos have no extension)
// ============================================================

interface DetectedType {
  contentType: string;
  extension: string;
}

function detectContentType(buf: Buffer): DetectedType {
  if (buf.length < 12) return { contentType: "application/octet-stream", extension: "bin" };

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return { contentType: "image/png", extension: "png" };
  }
  // GIF: 47 49 46 38 (37|39) 61
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { contentType: "image/gif", extension: "gif" };
  }
  // WebP: RIFF ... WEBP at offset 8
  if (
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  // HEIC/HEIF: ftypheic / ftypheix / ftypmif1 / ftypmsf1 at offset 4
  if (buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { contentType: "image/heic", extension: "heic" };
    }
  }

  return { contentType: "application/octet-stream", extension: "bin" };
}

// ============================================================
// UUID validation — bundle filenames should be UUIDs
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(name: string): boolean {
  // Strip extension if present (be lenient even though bundle is UUID-only)
  const base = name.includes(".") ? name.substring(0, name.lastIndexOf(".")) : name;
  return UUID_REGEX.test(base);
}

function listPhotoFiles(folder: string): string[] {
  const files = readdirSync(folder).filter((f) => {
    const full = `${folder}/${f}`;
    try {
      return statSync(full).isFile() && !f.startsWith(".");
    } catch {
      return false;
    }
  });
  return files;
}

// ============================================================
// Upload + DB write
// ============================================================

interface UploadStats {
  uploaded: number;
  skipped_existing: number;
  failed: number;
  unsupported_type: number;
}

async function uploadAndLink(
  supabase: SupabaseClient,
  bucket: string,
  photoBuffer: Buffer,
  photoFilename: string,
  listingId: string,
  position: number,
  photoType: "product" | "brand_tag" | "receipt",
  sellerId: string,
  dryRun: boolean,
  stats: UploadStats
): Promise<void> {
  const detected = detectContentType(photoBuffer);
  if (detected.contentType === "application/octet-stream") {
    console.error(`  [skip] ${photoFilename}: unrecognised binary type`);
    stats.unsupported_type += 1;
    return;
  }

  // Storage path mirrors the runtime upload pattern:
  //   sellerId/listingId/<photo-filename-without-ext>.<ext>
  const baseName = photoFilename.includes(".")
    ? photoFilename.substring(0, photoFilename.lastIndexOf("."))
    : photoFilename;
  const storagePath = `${sellerId}/${listingId}/${baseName}.${detected.extension}`;

  // Idempotency check: skip if a listing_photos row already exists
  // for this storage path.
  if (!dryRun) {
    const { data: existing } = await supabase
      .from("listing_photos")
      .select("id")
      .eq("storage_path", storagePath)
      .limit(1)
      .maybeSingle();
    if (existing) {
      stats.skipped_existing += 1;
      return;
    }
  }

  if (dryRun) {
    console.log(`  [dry-run] would upload ${photoFilename} → ${storagePath} (${detected.contentType})`);
    stats.uploaded += 1;
    return;
  }

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, photoBuffer, {
      contentType: detected.contentType,
      upsert: false,
    });
  if (uploadError) {
    // "already exists" means a previous run uploaded it but the DB
    // row was never written. Recover by linking the existing object.
    if (uploadError.message?.includes("exists")) {
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
      await supabase.from("listing_photos").insert({
        listing_id: listingId,
        storage_path: storagePath,
        url: urlData.publicUrl,
        position,
        photo_type: photoType,
      });
      stats.uploaded += 1;
      return;
    }
    console.error(`  [fail] ${photoFilename}: ${uploadError.message}`);
    stats.failed += 1;
    return;
  }

  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  const { error: insertError } = await supabase.from("listing_photos").insert({
    listing_id: listingId,
    storage_path: storagePath,
    url: urlData.publicUrl,
    position,
    photo_type: photoType,
  });
  if (insertError) {
    console.error(`  [fail] ${photoFilename}: DB insert failed: ${insertError.message}`);
    stats.failed += 1;
    return;
  }

  stats.uploaded += 1;
}

// ============================================================
// TEST mode — distribute sample photos across top N migrated listings
// ============================================================

async function runTestMode(args: CliArgs): Promise<void> {
  const supabase = createSupabaseAdmin();
  const photoFiles = listPhotoFiles(args.photosFolder);
  if (photoFiles.length === 0) {
    console.error(`No files found in ${args.photosFolder}`);
    process.exit(1);
  }

  console.log(
    `TEST MODE — distributing ${photoFiles.length} sample photos across top ${args.targetListings} migrated listings`
  );

  const { data: targets, error } = await supabase
    .from("listings")
    .select("id, seller_id, title")
    .not("legacy_sharetribe_id", "is", null)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(args.targetListings);

  if (error || !targets) {
    console.error("Failed to fetch target listings:", error);
    process.exit(1);
  }

  console.log(`Fetched ${targets.length} target listings`);

  // Pre-read all photos into memory (small set)
  const photos = photoFiles.map((f) => ({
    filename: basename(f),
    buffer: readFileSync(`${args.photosFolder}/${f}`),
  }));

  const stats: UploadStats = {
    uploaded: 0,
    skipped_existing: 0,
    failed: 0,
    unsupported_type: 0,
  };

  for (const target of targets) {
    console.log(`\n[${target.title}] listing=${target.id}`);
    // Distribute photos round-robin: photo 0 → position 0, photo 1 → position 1, etc.
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      await uploadAndLink(
        supabase,
        args.bucket,
        photo.buffer,
        photo.filename,
        target.id as string,
        i,
        args.photoType,
        target.seller_id as string,
        args.dryRun,
        stats
      );
    }
  }

  printStats(stats);
}

// ============================================================
// PRODUCTION mode — match by UUID against bundle metadata
// ============================================================

interface BundleRecord {
  id: string;
  type: string;
  attributes: {
    author?: string;
    images?: string[];
    profile?: {
      avatar?: string | null;
    };
  };
}

async function runProductionMode(args: CliArgs): Promise<void> {
  if (!args.bundleMetadata) {
    console.error("--bundle-metadata is required in production mode");
    process.exit(1);
  }

  console.log(`Loading bundle metadata: ${args.bundleMetadata}`);
  const records = JSON.parse(
    readFileSync(args.bundleMetadata, "utf8")
  ) as BundleRecord[];
  console.log(`Loaded ${records.length} bundle records`);

  // Index the photo files by UUID prefix (filenames are UUID-only)
  const photoFiles = listPhotoFiles(args.photosFolder);
  const photoIndex = new Map<string, string>();
  for (const f of photoFiles) {
    if (looksLikeUuid(f)) {
      const uuid = f.includes(".") ? f.substring(0, f.lastIndexOf(".")) : f;
      photoIndex.set(uuid.toLowerCase(), f);
    }
  }
  console.log(`Indexed ${photoIndex.size} photo files`);

  const supabase = createSupabaseAdmin();
  const stats: UploadStats = {
    uploaded: 0,
    skipped_existing: 0,
    failed: 0,
    unsupported_type: 0,
  };
  let listingsProcessed = 0;
  let avatarsProcessed = 0;
  let missingPhotos = 0;

  // Walk records
  for (const r of records) {
    if (r.type === "listing") {
      const images = r.attributes.images ?? [];
      if (images.length === 0) continue;

      // Resolve sharetribe listing UUID → supabase listing id + seller id
      const { data: listing } = await supabase
        .from("listings")
        .select("id, seller_id")
        .eq("legacy_sharetribe_id", r.id)
        .maybeSingle();
      if (!listing) continue;

      for (let i = 0; i < images.length; i++) {
        const photoUuid = images[i].toLowerCase();
        const photoFilename = photoIndex.get(photoUuid);
        if (!photoFilename) {
          missingPhotos += 1;
          continue;
        }
        const buffer = readFileSync(`${args.photosFolder}/${photoFilename}`);
        await uploadAndLink(
          supabase,
          args.bucket,
          buffer,
          photoFilename,
          listing.id as string,
          i,
          args.photoType,
          listing.seller_id as string,
          args.dryRun,
          stats
        );
      }
      listingsProcessed += 1;
      if (listingsProcessed % 100 === 0) {
        console.log(`  processed ${listingsProcessed} listings`);
      }
    } else if (r.type === "user") {
      const avatarUuid = r.attributes.profile?.avatar;
      if (!avatarUuid) continue;
      const photoFilename = photoIndex.get(avatarUuid.toLowerCase());
      if (!photoFilename) {
        missingPhotos += 1;
        continue;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("id")
        .eq("legacy_sharetribe_id", r.id)
        .maybeSingle();
      if (!profile) continue;

      const buffer = readFileSync(`${args.photosFolder}/${photoFilename}`);
      const detected = detectContentType(buffer);
      if (detected.contentType === "application/octet-stream") {
        stats.unsupported_type += 1;
        continue;
      }

      const storagePath = `avatars/${profile.id}/${avatarUuid}.${detected.extension}`;

      if (args.dryRun) {
        console.log(`  [dry-run avatar] ${avatarUuid} → ${storagePath}`);
        stats.uploaded += 1;
        avatarsProcessed += 1;
        continue;
      }

      const { error: upErr } = await supabase.storage
        .from(args.bucket)
        .upload(storagePath, buffer, {
          contentType: detected.contentType,
          upsert: false,
        });
      if (upErr && !upErr.message?.includes("exists")) {
        stats.failed += 1;
        continue;
      }
      const { data: urlData } = supabase.storage
        .from(args.bucket)
        .getPublicUrl(storagePath);
      await supabase
        .from("profiles")
        .update({ avatar_url: urlData.publicUrl })
        .eq("id", profile.id);
      stats.uploaded += 1;
      avatarsProcessed += 1;
    }
  }

  console.log(
    `\nProcessed ${listingsProcessed} listings, ${avatarsProcessed} avatars, ${missingPhotos} missing photo references`
  );
  printStats(stats);
}

function printStats(stats: UploadStats): void {
  console.log("\n========== PHOTO MIGRATION SUMMARY ==========");
  console.log(JSON.stringify(stats, null, 2));
  console.log("=============================================");
}

function createSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }
  return createClient(url, key);
}

// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(args.dryRun ? "DRY RUN — no uploads" : "COMMIT MODE — uploading to Supabase");

  if (args.testMode) {
    await runTestMode(args);
  } else {
    await runProductionMode(args);
  }
}

main().catch((err) => {
  console.error("Photo migration failed:", err);
  process.exit(1);
});

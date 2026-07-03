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
import PQueue from "p-queue";

interface CliArgs {
  bundleMetadata: string | null;
  photosFolder: string;
  testMode: boolean;
  seedAll: boolean;
  targetListings: number;
  dryRun: boolean;
  bucket: string;
  photoType: "product" | "brand_tag" | "receipt";
  concurrency: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let bundleMetadata: string | null = null;
  let photosFolder = "./sample-da";
  let testMode = false;
  let seedAll = false;
  let targetListings = 25;
  let dryRun = true; // safe default
  let bucket = "listing-photos";
  let photoType: "product" | "brand_tag" | "receipt" = "product";
  let concurrency = 16;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--bundle-metadata") bundleMetadata = args[++i];
    else if (a === "--photos-folder") photosFolder = args[++i];
    else if (a === "--test") testMode = true;
    else if (a === "--seed-all") seedAll = true;
    else if (a === "--target-listings") targetListings = parseInt(args[++i], 10);
    else if (a === "--commit") dryRun = false;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--concurrency") concurrency = parseInt(args[++i], 10) || 16;
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
    seedAll,
    targetListings,
    dryRun,
    bucket,
    photoType,
    concurrency,
  };
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/migrate-photos.ts [options]

Modes:
  Test:        --test --target-listings <N>
  Seed-all:    --seed-all --photos-folder <dir>   (every migrated listing gets all images in dir)
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

  // Retry transient network errors (e.g. "fetch failed") a couple times.
  let uploadError: { message?: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supabase.storage
      .from(bucket)
      .upload(storagePath, photoBuffer, {
        contentType: detected.contentType,
        upsert: false,
      });
    uploadError = res.error;
    if (!uploadError || uploadError.message?.includes("exists")) break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
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
// SEED-ALL mode — give EVERY migrated listing the same placeholder set
// ============================================================
//
// Uploads the placeholder images in --photos-folder (Megha's 3) to
// storage ONCE, then points every migrated listing's listing_photos
// rows at those same shared URLs. This is the efficient design: 3 file
// uploads + DB-only inserts, instead of physically re-uploading the
// same 3 files once per listing (30k+ redundant copies).
//
// Idempotency: a listing is skipped entirely if it already has any
// 'product' photo — so re-running is safe AND we never clobber real
// photos uploaded later at cutover.
//
// Paginates by created_at to handle the full ~10k migrated set without
// hitting Supabase's 1000-row query cap.

async function runSeedAllMode(args: CliArgs): Promise<void> {
  const supabase = createSupabaseAdmin();
  const photoFiles = listPhotoFiles(args.photosFolder);
  if (photoFiles.length === 0) {
    console.error(`No placeholder images found in ${args.photosFolder}`);
    process.exit(1);
  }

  // Read + upload each placeholder ONCE to a shared path. Reused by
  // every listing via its public URL.
  const shared: Array<{ url: string; storagePath: string; position: number }> = [];
  for (let i = 0; i < photoFiles.length; i++) {
    const filename = basename(photoFiles[i]);
    const buffer = readFileSync(`${args.photosFolder}/${filename}`);
    const detected = detectContentType(buffer);
    if (detected.contentType === "application/octet-stream") {
      console.error(`Skipping ${filename}: unrecognised binary type`);
      continue;
    }
    const base = filename.includes(".")
      ? filename.substring(0, filename.lastIndexOf("."))
      : filename;
    const storagePath = `placeholders/${base}.${detected.extension}`;

    if (args.dryRun) {
      console.log(`  [dry-run] would upload shared placeholder → ${storagePath}`);
    } else {
      const { error: upErr } = await supabase.storage
        .from(args.bucket)
        .upload(storagePath, buffer, {
          contentType: detected.contentType,
          upsert: true, // shared file — overwrite is fine, idempotent
        });
      if (upErr && !upErr.message?.includes("exists")) {
        console.error(`Failed to upload shared placeholder ${filename}: ${upErr.message}`);
        process.exit(1);
      }
    }
    const { data: urlData } = supabase.storage
      .from(args.bucket)
      .getPublicUrl(storagePath);
    shared.push({ url: urlData.publicUrl, storagePath, position: i });
  }

  console.log(
    `SEED-ALL MODE — ${shared.length} shared placeholder(s) → every migrated listing without photos\n` +
      `  shared paths: ${shared.map((s) => s.storagePath).join(", ")}`
  );

  let processed = 0;
  let seeded = 0;
  let skipped = 0;
  const PAGE = 1000;
  let cursor: string | null = null;

  for (;;) {
    let q = supabase
      .from("listings")
      .select("id, created_at")
      .not("legacy_sharetribe_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("created_at", cursor);

    const { data: page, error } = await q;
    if (error) {
      console.error("Failed to fetch listings page:", error);
      process.exit(1);
    }
    if (!page || page.length === 0) break;

    const pageIds = page.map((l) => l.id as string);

    // One query per page: which of these listings already have a
    // product photo? Those get skipped (don't clobber real photos /
    // don't double-seed on re-run).
    const { data: existingRows } = await supabase
      .from("listing_photos")
      .select("listing_id")
      .in("listing_id", pageIds)
      .eq("photo_type", "product");
    const havePhotos = new Set(
      (existingRows ?? []).map((r) => r.listing_id as string)
    );

    // Build all rows for listings that need seeding, insert in one shot.
    const rows: Array<Record<string, unknown>> = [];
    for (const id of pageIds) {
      if (havePhotos.has(id)) {
        skipped += 1;
        continue;
      }
      for (const s of shared) {
        rows.push({
          listing_id: id,
          storage_path: s.storagePath,
          url: s.url,
          position: s.position,
          photo_type: args.photoType,
        });
      }
      seeded += 1;
    }

    if (rows.length > 0 && !args.dryRun) {
      const { error: insErr } = await supabase.from("listing_photos").insert(rows);
      if (insErr) {
        console.error("Failed to insert listing_photos batch:", insErr);
        process.exit(1);
      }
    }

    processed += page.length;
    cursor = page[page.length - 1].created_at as string;
    console.log(
      `  …${processed} listings scanned (seeded=${seeded}, skipped=${skipped})`
    );

    if (page.length < PAGE) break;
  }

  console.log(
    `\nDone. ${processed} migrated listings scanned — ${seeded} seeded with placeholders, ${skipped} already had photos.`
  );
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
  // Resolve legacy_sharetribe_id → row ONCE, in bulk (paginated) — avoids a
  // DB round-trip per record, which was a big chunk of the old runtime.
  const listingByLegacy = new Map<string, { id: string; seller_id: string }>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("listings")
      .select("id, seller_id, legacy_sharetribe_id")
      .not("legacy_sharetribe_id", "is", null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const row of data) {
      listingByLegacy.set(row.legacy_sharetribe_id as string, {
        id: row.id as string,
        seller_id: row.seller_id as string,
      });
    }
    if (data.length < 1000) break;
  }
  const profileByLegacy = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from("profiles")
      .select("id, legacy_sharetribe_id")
      .not("legacy_sharetribe_id", "is", null)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    for (const row of data) profileByLegacy.set(row.legacy_sharetribe_id as string, row.id as string);
    if (data.length < 1000) break;
  }
  console.log(`Resolved ${listingByLegacy.size} listings, ${profileByLegacy.size} profiles`);

  // Build a flat task list from the bundle, then upload concurrently.
  type UploadTask =
    | { kind: "listing"; filename: string; listingId: string; sellerId: string; position: number }
    | { kind: "avatar"; filename: string; profileId: string; avatarUuid: string };
  const tasks: UploadTask[] = [];
  let missingPhotos = 0;
  for (const r of records) {
    if (r.type === "listing") {
      const images = r.attributes.images ?? [];
      if (images.length === 0) continue;
      const listing = listingByLegacy.get(r.id);
      if (!listing) continue;
      for (let i = 0; i < images.length; i++) {
        const filename = photoIndex.get(String(images[i]).toLowerCase());
        if (!filename) { missingPhotos += 1; continue; }
        tasks.push({ kind: "listing", filename, listingId: listing.id, sellerId: listing.seller_id, position: i });
      }
    } else if (r.type === "user") {
      const avatarUuid = r.attributes.profile?.avatar;
      if (!avatarUuid) continue;
      const filename = photoIndex.get(String(avatarUuid).toLowerCase());
      if (!filename) { missingPhotos += 1; continue; }
      const profileId = profileByLegacy.get(r.id);
      if (!profileId) continue;
      tasks.push({ kind: "avatar", filename, profileId, avatarUuid: String(avatarUuid) });
    }
  }
  console.log(`${tasks.length} upload tasks (${missingPhotos} missing photo refs) — concurrency ${args.concurrency}`);

  // Concurrent uploads — the network round-trips dominate, so parallelism
  // (not CPU) is the win. Each task is idempotent + retried internally.
  const queue = new PQueue({ concurrency: args.concurrency });
  let done = 0;
  for (const task of tasks) {
    void queue.add(async () => {
      const buffer = readFileSync(`${args.photosFolder}/${task.filename}`);
      if (task.kind === "listing") {
        await uploadAndLink(
          supabase, args.bucket, buffer, task.filename,
          task.listingId, task.position, args.photoType, task.sellerId,
          args.dryRun, stats
        );
      } else {
        await uploadAvatar(
          supabase, args.bucket, buffer, task.avatarUuid, task.profileId,
          args.dryRun, stats
        );
      }
      done += 1;
      if (done % 250 === 0) console.log(`  ${done}/${tasks.length} uploaded`);
    });
  }
  await queue.onIdle();

  console.log(`\nDone. ${tasks.length} tasks, ${missingPhotos} missing photo references`);
  printStats(stats);
}

/** Upload a user avatar + set profiles.avatar_url. Retries transient errors. */
async function uploadAvatar(
  supabase: SupabaseClient,
  bucket: string,
  photoBuffer: Buffer,
  avatarUuid: string,
  profileId: string,
  dryRun: boolean,
  stats: UploadStats
): Promise<void> {
  const detected = detectContentType(photoBuffer);
  if (detected.contentType === "application/octet-stream") {
    stats.unsupported_type += 1;
    return;
  }
  const storagePath = `avatars/${profileId}/${avatarUuid}.${detected.extension}`;
  if (dryRun) {
    stats.uploaded += 1;
    return;
  }
  let upErr: { message?: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await supabase.storage
      .from(bucket)
      .upload(storagePath, photoBuffer, { contentType: detected.contentType, upsert: false });
    upErr = res.error;
    if (!upErr || upErr.message?.includes("exists")) break;
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  if (upErr && !upErr.message?.includes("exists")) {
    stats.failed += 1;
    return;
  }
  const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  await supabase.from("profiles").update({ avatar_url: urlData.publicUrl }).eq("id", profileId);
  stats.uploaded += 1;
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

  if (args.seedAll) {
    await runSeedAllMode(args);
  } else if (args.testMode) {
    await runTestMode(args);
  } else {
    await runProductionMode(args);
  }
}

main().catch((err) => {
  console.error("Photo migration failed:", err);
  process.exit(1);
});

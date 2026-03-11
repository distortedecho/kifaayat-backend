import { removeBackground as removeBg } from "@imgly/background-removal-node";
import sharp from "sharp";

/**
 * Remove background from a product photo and replace with soft gradient.
 * Uses @imgly/background-removal-node (runs locally, no external API key needed)
 * and sharp for gradient compositing.
 *
 * Pipeline:
 * 1. Decode base64 to Buffer
 * 2. Get image dimensions
 * 3. Run ML-based background removal (returns transparent PNG)
 * 4. Generate soft off-white-to-light-grey gradient background
 * 5. Composite foreground over gradient
 * 6. Return as base64 JPEG
 *
 * First invocation downloads the ONNX model (~40MB) and caches it.
 */
export async function removeBackground(base64Photo: string): Promise<string> {
  // 1. Decode base64 to Buffer
  const inputBuffer = Buffer.from(base64Photo, "base64");

  // 2. Get image dimensions with sharp
  const metadata = await sharp(inputBuffer).metadata();
  const width = metadata.width!;
  const height = metadata.height!;

  // 3. Run background removal - returns a Blob with transparent background
  const blob = await removeBg(inputBuffer, {
    output: { format: "image/png", quality: 0.9 },
  });
  const foregroundBuffer = Buffer.from(await blob.arrayBuffer());

  // 4. Generate soft gradient background (off-white #F8F8F8 to light grey #E8E8E8)
  //    using an SVG rendered by sharp. Matches CONTEXT.md "premium feel" requirement.
  const gradientSvg = `<svg width="${width}" height="${height}">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#F8F8F8;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#E8E8E8;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)" />
  </svg>`;
  const gradientBuffer = await sharp(Buffer.from(gradientSvg))
    .resize(width, height)
    .png()
    .toBuffer();

  // 5. Composite foreground (transparent bg) over gradient background
  const resultBuffer = await sharp(gradientBuffer)
    .composite([{ input: foregroundBuffer, blend: "over" }])
    .jpeg({ quality: 85 })
    .toBuffer();

  // 6. Return as base64
  return resultBuffer.toString("base64");
}

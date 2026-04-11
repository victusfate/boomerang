/**
 * Rasterizes public/favicon.svg to icon-192.png and icon-512.png for PWA / apple-touch-icon.
 */
import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const svgPath = join(publicDir, 'favicon.svg');

const svg = readFileSync(svgPath);

await sharp(svg).resize(192, 192).png({ compressionLevel: 9 }).toFile(join(publicDir, 'icon-192.png'));

await sharp(svg).resize(512, 512).png({ compressionLevel: 9 }).toFile(join(publicDir, 'icon-512.png'));

console.log('Generated icon-192.png and icon-512.png from favicon.svg');

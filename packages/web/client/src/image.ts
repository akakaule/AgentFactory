export const MAX_EDGE = 1568;            // the model's effective resolution — larger is wasted
export const MAX_BYTES = 4 * 1024 * 1024;

export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = max / Math.max(w, h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface PastedImage { mime: string; dataBase64: string; }

/** Downscale a pasted image to ≤ MAX_EDGE on the long side; reject > MAX_BYTES after. */
export async function downscalePastedImage(file: File): Promise<PastedImage> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
  let blob: Blob = file;
  let mime = file.type || 'image/png';
  if (width !== bitmap.width || height !== bitmap.height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('image encoding failed'))), 'image/png'));
    mime = 'image/png';
  }
  bitmap.close();
  if (blob.size > MAX_BYTES) throw new Error('Image is too large (max 4 MB after downscaling).');

  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime, dataBase64: btoa(bin) };
}

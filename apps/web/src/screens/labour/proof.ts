// A muster's proof from the phone (docs/wave8-plan.md step 8c.2): where it is, and a photo of the gang shrunk to a
// JPEG small enough to wait in the outbox and travel in one request.

/** The phone's position, or null when it is refused or not to be had within the time. */
export function here(
  timeoutMs = 10_000,
): Promise<{ latitude: number; longitude: number; accuracy: number | null } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    ),
  );
}

/** A photo file as a JPEG data URL at most `max` pixels on its long side. */
export async function shrink(file: File, max = 1024, quality = 0.7): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

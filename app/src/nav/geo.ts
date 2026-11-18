/** Small-distance geometry on the globe. Accurate to well under a metre at street scale. */

export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6371008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Closest point to `p` on the segment a→b, treating the neighbourhood as flat.
 * `t` is how far along the segment it lies, 0..1.
 */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): { point: LatLon; t: number; distanceM: number } {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const ax = a.lon * k;
  const bx = b.lon * k;
  const px = p.lon * k;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / len2));
  const point = { lat: a.lat + dy * t, lon: a.lon + (b.lon - a.lon) * t };
  return { point, t, distanceM: distanceM(p, point) };
}

/** The point a given distance along a polyline, clamped to its ends. */
export function pointAlong(line: readonly LatLon[], cumulative: readonly number[], metres: number): LatLon {
  if (metres <= 0) return line[0]!;
  const total = cumulative[cumulative.length - 1]!;
  if (metres >= total) return line[line.length - 1]!;
  let i = 1;
  while (cumulative[i]! < metres) i++;
  const span = cumulative[i]! - cumulative[i - 1]!;
  const t = span === 0 ? 0 : (metres - cumulative[i - 1]!) / span;
  const a = line[i - 1]!;
  const b = line[i]!;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/** Running distance at each vertex of a polyline; `[0]` is 0. */
export function cumulativeDistances(line: readonly LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1]! + distanceM(line[i - 1]!, line[i]!));
  return out;
}

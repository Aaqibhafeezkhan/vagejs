/**
 * Copies plain data (objects and arrays) and keeps everything else as-is (URL, Date,
 * class instances from Zod transforms), so values can be shared or frozen safely
 * without breaking what layouts put in their schemas.
 */
export function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clonePlain(v)])) as T;
  }
  return value;
}

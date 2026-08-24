import "server-only";

export function isPricingPreviewEnabled(env = process.env): boolean {
  if (env.CMP_ENABLE_PRICING_PREVIEW !== "true") {
    return false;
  }

  if (env.VERCEL_ENV === "production") {
    return false;
  }

  if (env.VERCEL_ENV === "preview") {
    return true;
  }

  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

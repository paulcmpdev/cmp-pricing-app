import "server-only";

export function isAuthenticatedProductionFeaturesEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    env.CMP_AUTH_ENABLED === "true" &&
    env.CMP_ENABLE_AUTHENTICATED_PRODUCTION_FEATURES === "true"
  );
}

export function isPricingPreviewEnabled(env = process.env): boolean {
  if (env.CMP_ENABLE_PRICING_PREVIEW !== "true") {
    return false;
  }

  if (env.VERCEL_ENV === "production") {
    return isAuthenticatedProductionFeaturesEnabled(env);
  }

  if (env.VERCEL_ENV === "preview") {
    return true;
  }

  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

export function isAdditionalLocationsPreviewEnabled(env = process.env): boolean {
  if (env.CMP_ENABLE_ADDITIONAL_LOCATIONS_PREVIEW !== "true") {
    return false;
  }

  if (env.VERCEL_ENV === "production") {
    return isAuthenticatedProductionFeaturesEnabled(env);
  }

  if (env.VERCEL_ENV === "preview") {
    return true;
  }

  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

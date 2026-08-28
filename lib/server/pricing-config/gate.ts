import "server-only";

export function isPricingConfigEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.CMP_PRICING_CONFIG_ENABLED === "true";
}

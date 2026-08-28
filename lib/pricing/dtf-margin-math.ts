/**
 * DTF direct-price <-> DTF gross-margin math.
 *
 * Deliberately isomorphic. The unified admin matrix editor recalculates the
 * paired `Price` / `DTF GM%` fields locally as the user types, and the
 * server-only preview module uses these exact helpers, so the two can never
 * drift apart.
 *
 * This module must NOT import pricing-contract.json — it takes the tier cost
 * basis as an argument. That keeps the internal COGS fixture off the client
 * bundle; the only COGS that reaches the browser is the per-tier basis the
 * admin-authorized preview API already returns.
 *
 * Approved policy (see lib/fixtures/pricing-contract.json):
 *   - Shared project labor is recovered AT COST and is never margin-loaded.
 *   - Commission reserve (8%) is an outcome metric only. It is never embedded
 *     in the lane margin or in the product multiplier.
 *
 *   price  = baseDtfCogs / (1 - margin) + laborRecovery, rounded UP to the
 *            configured increment ($0.05)
 *   margin = 1 - baseDtfCogs / (price - laborRecovery)
 */
import { d, roundUpToIncrement, type DecimalLike } from "./money";

export const DEFAULT_ROUNDING_INCREMENT = "0.05";

/**
 * Per-tier cost basis. Both values are decimal strings so they survive JSON
 * transport without binary-float drift.
 */
export type DtfCostBasis = {
  baseDtfCogs: string;
  laborRecovery: string;
};

export type PriceFromMarginResult =
  | {
      ok: true;
      /** Un-rounded margin-loaded price + at-cost labor. */
      raw: string;
      /** Rounded UP to the configured increment. This is what gets stored. */
      final: string;
      /** Margin actually achieved once rounding is applied. */
      achievedMargin: string;
      marginLoadedAmount: string;
      increment: string;
    }
  | { ok: false; code: "invalid_margin" | "invalid_basis"; message: string };

export type MarginFromPriceResult =
  | {
      ok: true;
      /** Fractional margin, e.g. "0.5023573" */
      margin: string;
      /** Same value expressed 0-100, e.g. "50.23573" */
      marginPercent: string;
      /** True when the price does not cover base COGS (margin < 0). */
      belowCost: boolean;
    }
  | {
      ok: false;
      code: "at_or_below_labor" | "invalid_price" | "invalid_basis";
      message: string;
    };

function currency(value: DecimalLike): string {
  return d(value).toDecimalPlaces(2).toFixed(2);
}

function decimalString(value: DecimalLike): string {
  return d(value).toDecimalPlaces(10).toString();
}

function basisIsUsable(basis: DtfCostBasis): boolean {
  const base = d(basis.baseDtfCogs);
  const labor = d(basis.laborRecovery);
  return base.isFinite() && base.gte(0) && labor.isFinite() && labor.gte(0);
}

/**
 * Stable identity for a tier's cost basis. The basis depends only on the
 * quantity span, never on the tier's display name, so the client can cache
 * bases across renames and reorderings.
 */
export function tierCostKey(minQty: number, maxQty: number | null): string {
  return `${minQty}:${maxQty === null ? "+" : maxQty}`;
}

/**
 * Margin -> direct price, rounded UP to the configured increment.
 */
export function priceFromMargin(
  basis: DtfCostBasis,
  margin: DecimalLike,
  increment: DecimalLike = DEFAULT_ROUNDING_INCREMENT
): PriceFromMarginResult {
  if (!basisIsUsable(basis)) {
    return {
      ok: false,
      code: "invalid_basis",
      message: "Tier cost basis is unavailable.",
    };
  }

  const m = d(margin);
  if (!m.isFinite() || m.lt(0) || m.gte(1)) {
    return {
      ok: false,
      code: "invalid_margin",
      message: "DTF GM% must be at least 0% and less than 100%.",
    };
  }

  const base = d(basis.baseDtfCogs);
  const labor = d(basis.laborRecovery);
  const marginLoadedAmount = base.div(d(1).minus(m));
  const raw = marginLoadedAmount.plus(labor);
  const final = roundUpToIncrement(raw, increment);

  if (!final.isFinite() || final.lte(0)) {
    return {
      ok: false,
      code: "invalid_basis",
      message: "Calculated DTF price must be finite and positive.",
    };
  }

  const net = final.minus(labor);
  const achievedMargin = net.lte(0) ? d(0) : net.minus(base).div(net);

  return {
    ok: true,
    raw: decimalString(raw),
    final: currency(final),
    achievedMargin: decimalString(achievedMargin),
    marginLoadedAmount: decimalString(marginLoadedAmount),
    increment: currency(increment),
  };
}

/**
 * Direct price -> DTF margin, by algebraically reversing `priceFromMargin`.
 *
 * A price at or below the at-cost labor recovery has no defined DTF margin
 * (the reversal divides by `price - laborRecovery`), so it is reported as an
 * inline validation error rather than NaN/Infinity.
 */
export function marginFromPrice(
  basis: DtfCostBasis,
  price: DecimalLike
): MarginFromPriceResult {
  if (!basisIsUsable(basis)) {
    return {
      ok: false,
      code: "invalid_basis",
      message: "Tier cost basis is unavailable.",
    };
  }

  const p = d(price);
  if (!p.isFinite() || p.lt(0)) {
    return {
      ok: false,
      code: "invalid_price",
      message: "Enter a price of $0.00 or more.",
    };
  }

  const base = d(basis.baseDtfCogs);
  const labor = d(basis.laborRecovery);
  const net = p.minus(labor);

  if (net.lte(0)) {
    return {
      ok: false,
      code: "at_or_below_labor",
      message: `Price must exceed the $${currency(labor)} at-cost labor recovery for this tier.`,
    };
  }

  const margin = net.minus(base).div(net);

  return {
    ok: true,
    margin: decimalString(margin),
    marginPercent: decimalString(margin.times(100)),
    belowCost: margin.lt(0),
  };
}

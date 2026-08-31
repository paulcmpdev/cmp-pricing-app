"use client";

import React from "react";
import type { DtfMatrixPreview } from "@/lib/pricing/dtf-matrix-preview-types";
import { fmtCurrency, fmtPercent } from "../pricing-helpers";

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-neutral-500 mb-0.5">
        {label}
      </dt>
      <dd className="text-xs font-medium text-neutral-200">{value}</dd>
    </div>
  );
}

/**
 * The calculation context the standalone preview used to carry, folded into
 * the unified editor as a collapsible strip. Keeping it here means the page
 * never needs a second DTF grid to explain where a price came from.
 */
export default function DtfPricingContext({
  preview,
}: {
  preview: DtfMatrixPreview | null;
}) {
  if (!preview) return null;

  const { pricingPolicy: policy, dtfContext: dtf } = preview;

  return (
    <details className="rounded-md border border-neutral-700/50 bg-neutral-800/40 group">
      <summary className="cursor-pointer list-none px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-400 hover:text-neutral-200 flex items-center justify-between min-h-[36px]">
        <span>Calculation Context</span>
        <span className="text-neutral-500 group-open:hidden">show</span>
        <span className="text-neutral-500 hidden group-open:inline">hide</span>
      </summary>
      <div className="px-3 pb-3">
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-4 gap-y-3">
          <Item
            label="Contract Source"
            value={preview.source.replace("lib/fixtures/", "")}
          />
          <Item label="Schema Version" value={preview.schemaVersion} />
          <Item
            label="Product Multiplier"
            value={`${policy.productCostMultiplier}x`}
          />
          <Item
            label="Commission Reserve"
            value={fmtPercent(policy.commissionReserveRate)}
          />
          <Item
            label="Rounding Increment"
            value={fmtCurrency(policy.roundingIncrement)}
          />
          <Item label="Production Mode" value={dtf.activeProductionMode} />
          <Item label="Labor Policy" value={dtf.pricingMode} />
          <Item
            label="Project Labor / Order"
            value={fmtCurrency(dtf.sharedProjectLaborPerOrder)}
          />
          <Item
            label="Transfer Size"
            value={`${dtf.capturedTransferSizeIn.width}" x ${dtf.capturedTransferSizeIn.height}"`}
          />
          <Item
            label="Max Quoted Qty"
            value={dtf.maxSupportedQuantity.toLocaleString()}
          />
        </dl>
        <p className="text-[10px] text-neutral-500 mt-3 leading-relaxed">
          DTF GM% margin-loads base decoration COGS only. Shared project labor
          is recovered at cost and is never margin-loaded. The{" "}
          {fmtPercent(policy.commissionReserveRate)} commission reserve is an
          outcome and audit metric — it is never embedded in a lane margin or
          in the product multiplier.
        </p>
      </div>
    </details>
  );
}

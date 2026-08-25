"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  CatalogEntry,
  StaffItemQuote,
  ManagerItemQuote,
  StaffFlatFeeQuote,
  ManagerFlatFeeQuote,
  VendorCatalogPublicVariant,
  VendorCatalogStyleSummary,
} from "@/lib/client/types";
import { formatCurrency, formatPercent } from "@/lib/client/format";
import {
  describeVariantAvailability,
  isStaleVendorPricing,
  shouldClearItemQuoteForVendorSelectionChange,
  type ProductMode,
} from "@/lib/client/vendor-catalog-helpers";

// ---------------------------------------------------------------------------
// Flat-fee services from the contract (names only, no cost data)
// ---------------------------------------------------------------------------
const FLAT_FEE_SERVICES = [
  "Additional Large Print",
  "Sleeve Print",
  "Bottom / Upper Chest",
  "Vertical Print",
  "Name",
  "Number",
  "Name + Number",
  "Standard Package",
  "Premium Package",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Props {
  catalog: CatalogEntry[];
  mode?: "primary" | "evaluation";
  additionalLocationsEnabled?: boolean;
}

type AdditionalLocationRow = {
  id: string;
  service: string;
  quote: FlatFeeQuote | null;
  loading: boolean;
  error: string | null;
  generation: number;
};

type Role = "staff" | "manager";
type VendorFilter = "all" | "ss" | "sanmar";

type ItemQuote = StaffItemQuote | ManagerItemQuote;
type FlatFeeQuote = StaffFlatFeeQuote | ManagerFlatFeeQuote;

function isManagerItem(q: ItemQuote): q is ManagerItemQuote {
  return "commissionReserve" in q;
}
function isManagerFlatFee(q: FlatFeeQuote): q is ManagerFlatFeeQuote {
  return "engineCogs" in q;
}

function parseStrictPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 ? n : null;
}

function isDecimalQuantity(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && /^\d+\.\d*$/.test(trimmed);
}

function uniqueValues(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
let nextLocationId = 1;

export default function QuoteDeskClient({
  catalog,
  mode = "evaluation",
  additionalLocationsEnabled = false,
}: Props) {
  const isPrimary = mode === "primary";

  // Group catalog by category
  const categories = Array.from(new Set(catalog.map((p) => p.category)));

  // --- State ---
  const [role, setRole] = useState<Role>("staff");
  const [productMode, setProductMode] = useState<ProductMode>(isPrimary ? "vendor" : "catalog");
  const [selectedSku, setSelectedSku] = useState("");
  const [manualCost, setManualCost] = useState("");
  const [vendorFilter, setVendorFilter] = useState<VendorFilter>("all");
  const [vendorSearch, setVendorSearch] = useState("");
  const [vendorStyles, setVendorStyles] = useState<VendorCatalogStyleSummary[]>([]);
  const [selectedVendorStyle, setSelectedVendorStyle] =
    useState<VendorCatalogStyleSummary | null>(null);
  const [vendorVariants, setVendorVariants] = useState<VendorCatalogPublicVariant[]>([]);
  const [selectedVendorColor, setSelectedVendorColor] = useState("");
  const [selectedCatalogVariantId, setSelectedCatalogVariantId] = useState("");
  const [vendorSearchLoading, setVendorSearchLoading] = useState(false);
  const [vendorVariantsLoading, setVendorVariantsLoading] = useState(false);
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [vendorUnavailable, setVendorUnavailable] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("84");

  const [selectedService, setSelectedService] = useState("");
  const [flatFeeQuantity, setFlatFeeQuantity] = useState("");

  // Additional Locations (multi-row, feature-gated)
  const [additionalLocations, setAdditionalLocations] = useState<AdditionalLocationRow[]>([]);
  const locationAborts = useRef<Map<string, AbortController>>(new Map());

  // Manager edits for flat-fee
  const [extraOpMinutes, setExtraOpMinutes] = useState("0");
  const [extraDesMinutes, setExtraDesMinutes] = useState("0");
  const [manualOverride, setManualOverride] = useState("");

  // Results
  const [itemQuote, setItemQuote] = useState<ItemQuote | null>(null);
  const [flatFeeQuote, setFlatFeeQuote] = useState<FlatFeeQuote | null>(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [flatFeeLoading, setFlatFeeLoading] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [flatFeeError, setFlatFeeError] = useState<string | null>(null);
  const [managerReviewRequired, setManagerReviewRequired] = useState(false);

  // Abort controllers for debounced requests
  const itemAbort = useRef<AbortController | null>(null);
  const flatFeeAbort = useRef<AbortController | null>(null);
  const vendorSearchAbort = useRef<AbortController | null>(null);
  const vendorVariantAbort = useRef<AbortController | null>(null);
  const itemRequestToken = useRef(0);
  const locationGenerations = useRef<Map<string, number>>(new Map());

  const nextItemToken = useCallback(() => {
    itemRequestToken.current += 1;
    return itemRequestToken.current;
  }, []);

  const bumpLocationGeneration = useCallback((id: string) => {
    const next = (locationGenerations.current.get(id) ?? 0) + 1;
    locationGenerations.current.set(id, next);
    return next;
  }, []);

  const invalidateItemQuote = useCallback(() => {
    nextItemToken();
    itemAbort.current?.abort();
    itemAbort.current = null;
    setItemQuote(null);
    setItemLoading(false);
    setItemError(null);
    setManagerReviewRequired(false);
  }, [nextItemToken]);

  const invalidateAllLocations = useCallback(() => {
    locationAborts.current.forEach((controller) => controller.abort());
    locationAborts.current.clear();
    setAdditionalLocations((prev) =>
      prev.map((loc) => {
        const generation = bumpLocationGeneration(loc.id);
        return { ...loc, quote: null, loading: false, error: null, generation };
      })
    );
  }, [bumpLocationGeneration]);

  const handleQuantityChange = useCallback(
    (value: string) => {
      setQuantity(value);
      invalidateItemQuote();
      invalidateAllLocations();
    },
    [invalidateAllLocations, invalidateItemQuote]
  );

  useEffect(() => {
    const locationAbortMap = locationAborts.current;
    const locationGenerationMap = locationGenerations.current;
    return () => {
      nextItemToken();
      itemAbort.current?.abort();
      flatFeeAbort.current?.abort();
      vendorSearchAbort.current?.abort();
      vendorVariantAbort.current?.abort();
      locationAbortMap.forEach((controller) => controller.abort());
      locationGenerationMap.forEach((_generation, id) => {
        bumpLocationGeneration(id);
      });
      locationAbortMap.clear();
    };
  }, [bumpLocationGeneration, nextItemToken]);

  // --- Item price calculation ---
  const calculateItem = useCallback(async () => {
    const qty = parseStrictPositiveInt(quantity);
    if (qty === null) return;

    let body: Record<string, unknown>;
    if (productMode === "catalog") {
      if (!selectedSku) return;
      body = { sku: selectedSku, quantity: qty };
    } else if (productMode === "vendor") {
      if (!selectedCatalogVariantId) return;
      body = { catalogVariantId: selectedCatalogVariantId, quantity: qty };
    } else {
      const cost = parseFloat(manualCost);
      if (isNaN(cost) || cost < 0) return;
      body = { productCost: cost, quantity: qty };
    }

    itemAbort.current?.abort();
    const controller = new AbortController();
    itemAbort.current = controller;
    const token = nextItemToken();

    setItemLoading(true);
    setItemError(null);
    setManagerReviewRequired(false);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (role === "manager") {
        headers["x-cmp-role"] = role;
      }
      const res = await fetch("/api/quote/item", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (token !== itemRequestToken.current || itemAbort.current !== controller) return;
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`
        );
      }
      const data = await res.json();
      if (token !== itemRequestToken.current || itemAbort.current !== controller) return;
      if (data.requiresManagerReview && !("salesPrice" in data)) {
        setManagerReviewRequired(true);
        setItemQuote(null);
      } else {
        setItemQuote(data as ItemQuote);
      }
    } catch (e) {
      if (
        (e as Error).name !== "AbortError" &&
        token === itemRequestToken.current &&
        itemAbort.current === controller
      ) {
        setItemError((e as Error).message);
      }
    } finally {
      if (token === itemRequestToken.current && itemAbort.current === controller) {
        setItemLoading(false);
      }
    }
  }, [productMode, selectedSku, selectedCatalogVariantId, manualCost, quantity, role, nextItemToken]);

  useEffect(() => {
    if (productMode !== "vendor") return;
    const term = vendorSearch.trim();
    setSelectedVendorStyle(null);
    setVendorVariants([]);
    setSelectedVendorColor("");
    setSelectedCatalogVariantId("");
    if (term.length === 0) {
      setVendorStyles([]);
      setVendorError(null);
      setVendorUnavailable(null);
      return;
    }
    if (term.length < 2) {
      setVendorStyles([]);
      return;
    }

    let controller: AbortController | null = null;
    const timer = setTimeout(async () => {
      vendorSearchAbort.current?.abort();
      const requestController = new AbortController();
      controller = requestController;
      vendorSearchAbort.current = requestController;
      setVendorSearchLoading(true);
      setVendorError(null);
      setVendorUnavailable(null);
      try {
        const res = await fetch(
          `/api/vendor-catalog/search?q=${encodeURIComponent(term)}&vendor=${vendorFilter}`,
          { signal: requestController.signal }
        );
        const data = await res.json();
        if (res.status === 503) {
          setVendorUnavailable(data.reason ?? "Vendor catalog is unavailable.");
          setVendorStyles([]);
          return;
        }
        if (!res.ok) {
          throw new Error(data.error ? JSON.stringify(data.error) : `HTTP ${res.status}`);
        }
        setVendorStyles(data.results ?? []);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setVendorError((e as Error).message);
        }
      } finally {
        if (vendorSearchAbort.current === requestController) {
          setVendorSearchLoading(false);
        }
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller?.abort();
    };
  }, [productMode, vendorSearch, vendorFilter]);

  useEffect(() => {
    if (!selectedVendorStyle) return;
    vendorVariantAbort.current?.abort();
    const controller = new AbortController();
    vendorVariantAbort.current = controller;
    setVendorVariantsLoading(true);
    setVendorError(null);
    setSelectedVendorColor("");
    setSelectedCatalogVariantId("");

    fetch(`/api/vendor-catalog/styles/${encodeURIComponent(selectedVendorStyle.id)}/variants`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 503) {
          setVendorUnavailable(data.reason ?? "Vendor catalog is unavailable.");
          return;
        }
        if (!res.ok) {
          throw new Error(data.error ? JSON.stringify(data.error) : `HTTP ${res.status}`);
        }
        setVendorVariants(data.variants ?? []);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          setVendorError((e as Error).message);
        }
      })
      .finally(() => {
        if (vendorVariantAbort.current === controller) {
          setVendorVariantsLoading(false);
        }
      });

    return () => controller.abort();
  }, [selectedVendorStyle]);

  // --- Flat-fee calculation ---
  const calculateFlatFee = useCallback(async () => {
    if (!selectedService) return;
    const qty = parseStrictPositiveInt(flatFeeQuantity || quantity);
    if (qty === null) return;

    flatFeeAbort.current?.abort();
    const controller = new AbortController();
    flatFeeAbort.current = controller;

    setFlatFeeLoading(true);
    setFlatFeeError(null);
    try {
      const body: Record<string, unknown> = {
        service: selectedService,
        orderQuantity: qty,
        extraOperatorMinutesPerShirt: parseFloat(extraOpMinutes) || 0,
        extraDesignerMinutesPerOrder: parseFloat(extraDesMinutes) || 0,
        manualOverride: manualOverride === "" ? null : parseFloat(manualOverride),
      };

      const res = await fetch("/api/quote/flat-fee", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cmp-role": role,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`
        );
      }
      const data: FlatFeeQuote = await res.json();
      setFlatFeeQuote(data);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setFlatFeeError((e as Error).message);
      }
    } finally {
      setFlatFeeLoading(false);
    }
  }, [selectedService, flatFeeQuantity, quantity, extraOpMinutes, extraDesMinutes, manualOverride, role]);

  // Auto-calculate item price when inputs change
  useEffect(() => {
    const timer = setTimeout(calculateItem, 300);
    return () => clearTimeout(timer);
  }, [calculateItem]);

  // Auto-calculate flat-fee when inputs change
  useEffect(() => {
    if (selectedService) {
      const timer = setTimeout(calculateFlatFee, 300);
      return () => clearTimeout(timer);
    }
  }, [calculateFlatFee, selectedService]);

  // --- Additional Locations helpers ---
  const calculateLocationQuote = useCallback(async (
    locationId: string,
    service: string,
    generation?: number
  ) => {
    if (!service) return;
    const qty = parseStrictPositiveInt(quantity);
    if (qty === null) return;
    const requestedService = service;
    const requestedQuantity = qty;

    // Abort any existing request for this location
    const existing = locationAborts.current.get(locationId);
    existing?.abort();
    const controller = new AbortController();
    locationAborts.current.set(locationId, controller);
    const requestGeneration = generation ?? bumpLocationGeneration(locationId);

    setAdditionalLocations((prev) =>
      prev.map((loc) =>
        loc.id === locationId
          ? { ...loc, generation: requestGeneration, loading: true, error: null }
          : loc
      )
    );

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (role === "manager") {
        headers["x-cmp-role"] = role;
      }
      const res = await fetch("/api/quote/flat-fee", {
        method: "POST",
        headers,
        body: JSON.stringify({
          service: requestedService,
          orderQuantity: requestedQuantity,
          extraOperatorMinutesPerShirt: 0,
          extraDesignerMinutesPerOrder: 0,
          manualOverride: null,
        }),
        signal: controller.signal,
      });
      if (
        locationAborts.current.get(locationId) !== controller ||
        locationGenerations.current.get(locationId) !== requestGeneration
      ) {
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ? JSON.stringify(err.error) : `HTTP ${res.status}`);
      }
      const data: FlatFeeQuote = await res.json();
      if (
        locationAborts.current.get(locationId) !== controller ||
        locationGenerations.current.get(locationId) !== requestGeneration
      ) {
        return;
      }
      setAdditionalLocations((prev) =>
        prev.map((loc) =>
          loc.id === locationId &&
          loc.generation === requestGeneration &&
          loc.service === requestedService &&
          data.service === requestedService &&
          data.billableQuantity === requestedQuantity
            ? { ...loc, quote: data, loading: false, error: null }
            : loc
        )
      );
    } catch (e) {
      if (
        (e as Error).name !== "AbortError" &&
        locationAborts.current.get(locationId) === controller &&
        locationGenerations.current.get(locationId) === requestGeneration
      ) {
        setAdditionalLocations((prev) =>
          prev.map((loc) =>
            loc.id === locationId && loc.generation === requestGeneration
              ? { ...loc, error: (e as Error).message, loading: false }
              : loc
          )
        );
      }
    }
  }, [quantity, role, bumpLocationGeneration]);

  const addLocation = useCallback(() => {
    const id = `loc-${nextLocationId++}`;
    locationGenerations.current.set(id, 0);
    setAdditionalLocations((prev) => [
      ...prev,
      { id, service: "", quote: null, loading: false, error: null, generation: 0 },
    ]);
  }, []);

  const removeLocation = useCallback((id: string) => {
    bumpLocationGeneration(id);
    locationAborts.current.get(id)?.abort();
    locationAborts.current.delete(id);
    locationGenerations.current.delete(id);
    setAdditionalLocations((prev) => prev.filter((loc) => loc.id !== id));
  }, [bumpLocationGeneration]);

  const updateLocationService = useCallback((id: string, service: string) => {
    locationAborts.current.get(id)?.abort();
    locationAborts.current.delete(id);
    setAdditionalLocations((prev) =>
      prev.map((loc) => {
        if (loc.id !== id) return loc;
        const generation = bumpLocationGeneration(id);
        return { ...loc, service, quote: null, loading: false, error: null, generation };
      })
    );
  }, [bumpLocationGeneration]);

  // Services already selected in other rows (for duplicate prevention)
  const selectedLocationServices = new Set(
    additionalLocations.map((loc) => loc.service).filter(Boolean)
  );

  // Recalculate all location quotes when quantity or role changes
  useEffect(() => {
    if (!additionalLocationsEnabled) return;

    // Collect locations that need recalculation from the closure snapshot.
    const locationsToRecalc = additionalLocations
      .filter((loc) => loc.service)
      .map(({ id, service }) => ({ id, service }));

    if (locationsToRecalc.length === 0) return;

    // Immediately invalidate stale quotes and abort in-flight requests
    // so no old pricing can contribute to final totals during recalculation.
    const requestedLocations = locationsToRecalc.map(({ id, service }) => {
      locationAborts.current.get(id)?.abort();
      locationAborts.current.delete(id);
      return { id, service, generation: bumpLocationGeneration(id) };
    });
    setAdditionalLocations((prev) =>
      prev.map((loc) =>
        loc.service
          ? {
              ...loc,
              quote: null,
              loading: parseStrictPositiveInt(quantity) !== null,
              error: null,
              generation: locationGenerations.current.get(loc.id) ?? loc.generation,
            }
          : loc
      )
    );

    if (parseStrictPositiveInt(quantity) === null) return;

    const timers = requestedLocations.map(({ id, service, generation }) =>
      setTimeout(() => calculateLocationQuote(id, service, generation), 300)
    );

    return () => timers.forEach(clearTimeout);
  // We intentionally recalc when quantity or role changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quantity, role, additionalLocationsEnabled]);

  // Recalculate individual location when its service changes
  useEffect(() => {
    if (!additionalLocationsEnabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const loc of additionalLocations) {
      if (loc.service && !loc.quote && !loc.loading) {
        timers.push(setTimeout(() => calculateLocationQuote(loc.id, loc.service), 300));
      }
    }
    return () => timers.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [additionalLocations, calculateLocationQuote, additionalLocationsEnabled]);

  // --- Derived ---
  const selectedProduct = catalog.find((p) => p.sku === selectedSku);
  const vendorColors = uniqueValues(vendorVariants.map((variant) => variant.color));
  const vendorSizes = vendorVariants.filter(
    (variant) => variant.color === selectedVendorColor
  );
  const selectedVendorVariant = vendorVariants.find(
    (variant) => variant.id === selectedCatalogVariantId
  );

  const changeRole = (nextRole: Role) => {
    invalidateItemQuote();
    flatFeeAbort.current?.abort();
    setFlatFeeQuote(null);
    setFlatFeeError(null);
    invalidateAllLocations();
    setRole(nextRole);
  };

  const changeProductMode = (nextMode: ProductMode) => {
    if (shouldClearItemQuoteForVendorSelectionChange(productMode, nextMode)) {
      invalidateItemQuote();
    }
    setProductMode(nextMode);
  };

  const clearVendorItemQuote = () => {
    invalidateItemQuote();
  };

  // Additional locations totals
  const additionalLocationsTotalPerItem = additionalLocationsEnabled
    ? additionalLocations.reduce(
        (sum, loc) => sum + (loc.quote?.effectivePrice ?? 0),
        0
      )
    : 0;

  const additionalLocationsAnyLoading = additionalLocations.some((loc) => loc.loading);

  // Final Per-Item Price: existing salesPrice + sum(additional location effective prices).
  // Additive only — no solver, no contribution-target adjustment.
  const finalPerItemPrice = additionalLocationsEnabled
    ? (itemQuote?.salesPrice ?? 0) + additionalLocationsTotalPerItem
    : itemQuote?.salesPrice ?? 0;

  // Order total
  const qty = parseStrictPositiveInt(quantity) ?? 0;
  const orderTotal = additionalLocationsEnabled
    ? finalPerItemPrice * qty
    : (itemQuote?.salesOrderTotal ?? 0) + (flatFeeQuote?.addOnTotal ?? 0);

  // Combined audit metrics (recomputed from final additive price; these MUST NOT adjust price)
  const COMMISSION_RATE = 0.08;
  const totalCogsPerItem = additionalLocationsEnabled && itemQuote && isManagerItem(itemQuote)
    ? itemQuote.totalProductionCogs +
      additionalLocations.reduce(
        (sum, loc) =>
          sum + (loc.quote && isManagerFlatFee(loc.quote) ? loc.quote.engineCogs : 0),
        0
      )
    : null;
  const combinedCommissionReserve = finalPerItemPrice * COMMISSION_RATE;
  const combinedGrossProfit = totalCogsPerItem !== null ? finalPerItemPrice - totalCogsPerItem : null;
  const combinedNetContribution = combinedGrossProfit !== null
    ? combinedGrossProfit - combinedCommissionReserve
    : null;
  const combinedGrossMargin = finalPerItemPrice > 0 && combinedGrossProfit !== null
    ? combinedGrossProfit / finalPerItemPrice
    : null;
  const combinedContributionMargin = finalPerItemPrice > 0 && combinedNetContribution !== null
    ? combinedNetContribution / finalPerItemPrice
    : null;

  // Mode button order: primary leads with Vendor, evaluation leads with CMP
  const modeButtons: { key: ProductMode; label: string }[] = isPrimary
    ? [
        { key: "vendor", label: "Vendor Catalog" },
        { key: "catalog", label: "CMP Catalog" },
        { key: "manual", label: "Manual Cost" },
      ]
    : [
        { key: "catalog", label: "CMP Catalog" },
        { key: "vendor", label: "Vendor Catalog" },
        { key: "manual", label: "Manual Cost" },
      ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-3 lg:py-4">
      {/* Role toggle — evaluation mode only */}
      {!isPrimary && (
        <div className="flex items-center justify-end mb-3 gap-2">
          <span className="text-xs text-cmp-gray uppercase tracking-wider">
            View mode:
          </span>
          <button
            onClick={() => changeRole(role === "staff" ? "manager" : "staff")}
            className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors focus-visible:outline-cmp-cyan ${
              role === "manager" ? "bg-cmp-cyan" : "bg-cmp-gray-light"
            }`}
            role="switch"
            aria-checked={role === "manager"}
            aria-label="Toggle Manager mode"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                role === "manager" ? "translate-x-8" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-xs font-medium min-w-[56px]">
            {role === "manager" ? "Manager" : "Staff"}
          </span>
          {role === "manager" && (
            <span className="text-[10px] text-cmp-warning bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
              Local evaluation only
            </span>
          )}
        </div>
      )}

      {/* Split pane: inputs left, summary right */}
      <div className="flex flex-col lg:flex-row gap-3 lg:gap-5">
        {/* LEFT: Inputs */}
        <div className="flex-1 space-y-3 min-w-0">
          {/* Product + Quantity (combined card) */}
          <section className="cmp-card p-4" aria-labelledby="product-heading">
            <h2
              id="product-heading"
              className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-2.5 font-display"
            >
              Product
            </h2>

            {/* Mode toggle */}
            <div className="flex gap-1.5 mb-3" role="group" aria-label="Product input mode">
              {modeButtons.map((btn) => (
                <button
                  key={btn.key}
                  onClick={() => changeProductMode(btn.key)}
                  aria-pressed={productMode === btn.key}
                  className={`text-xs px-2.5 py-1 rounded font-medium transition-colors ${
                    productMode === btn.key
                      ? "bg-cmp-cyan text-white"
                      : "bg-cmp-surface text-cmp-gray hover:text-cmp-charcoal"
                  }`}
                >
                  {btn.label}
                </button>
              ))}
            </div>

            {productMode === "catalog" ? (
              <div>
                <label htmlFor="product-select" className="cmp-label">
                  Product
                </label>
                <select
                  id="product-select"
                  className="cmp-select"
                  value={selectedSku}
                  onChange={(e) => {
                    invalidateItemQuote();
                    setSelectedSku(e.target.value);
                  }}
                >
                  <option value="">Select a product...</option>
                  {categories.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {catalog
                        .filter((p) => p.category === cat)
                        .map((p) => (
                          <option key={p.sku} value={p.sku}>
                            {p.sku} &mdash; {p.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                {selectedProduct && (
                  <p className="mt-1 text-xs text-cmp-gray">
                    {selectedProduct.name}
                  </p>
                )}
              </div>
            ) : productMode === "vendor" ? (
              <div className="space-y-2.5">
                <div className="grid grid-cols-1 sm:grid-cols-[100px_1fr] gap-2.5">
                  <div>
                    <label htmlFor="vendor-filter" className="cmp-label">
                      Vendor
                    </label>
                    <select
                      id="vendor-filter"
                      className="cmp-select"
                      value={vendorFilter}
                      onChange={(e) => {
                        clearVendorItemQuote();
                        setVendorFilter(e.target.value as VendorFilter);
                      }}
                    >
                      <option value="all">All</option>
                      <option value="ss">S&amp;S</option>
                      <option value="sanmar">SanMar</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="vendor-search" className="cmp-label">
                      Search vendor catalog
                    </label>
                    <input
                      id="vendor-search"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="vendor-search-results"
                      aria-expanded={vendorStyles.length > 0 && !selectedVendorStyle}
                      className="cmp-input"
                      value={vendorSearch}
                      onChange={(e) => {
                        clearVendorItemQuote();
                        setVendorSearch(e.target.value);
                      }}
                      placeholder="Style, brand, or product"
                    />
                  </div>
                </div>

                {vendorUnavailable && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-800" role="status">
                    Vendor catalog unavailable. {vendorUnavailable}
                  </div>
                )}
                {vendorError && (
                  <div className="rounded-md bg-red-50 border border-red-200 p-2.5 text-xs text-red-700" role="alert">
                    {vendorError}
                  </div>
                )}
                {vendorSearchLoading && (
                  <div className="flex items-center gap-2 text-xs text-cmp-gray">
                    <LoadingSpinner />
                    Searching...
                  </div>
                )}
                {!vendorSearchLoading && vendorSearch.trim().length >= 2 && vendorStyles.length === 0 && !vendorUnavailable && !vendorError && (
                  <p className="text-sm text-cmp-gray">No vendor styles found.</p>
                )}
                {vendorStyles.length > 0 && !selectedVendorStyle && (
                  <div
                    id="vendor-search-results"
                    role="listbox"
                    aria-label="Vendor catalog search results"
                    className="max-h-48 overflow-auto rounded-md border border-cmp-gray-light divide-y divide-cmp-gray-light/60"
                  >
                    {vendorStyles.map((style) => (
                      <button
                        key={style.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="w-full px-3 py-1.5 text-left hover:bg-cmp-surface focus-visible:outline-cmp-cyan"
                        onClick={() => {
                          clearVendorItemQuote();
                          setSelectedVendorStyle(style);
                        }}
                      >
                        <span className="block text-sm font-semibold text-cmp-charcoal">
                          {style.styleCode} · {style.name}
                        </span>
                        <span className="block text-xs text-cmp-gray">
                          {style.vendor === "ss" ? "S&S" : "SanMar"} · {style.brand} · {style.activeVariantCount} variants
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {selectedVendorStyle && (
                  <div className="space-y-2.5 rounded-md border border-cmp-gray-light p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-cmp-charcoal">
                          {selectedVendorStyle.styleCode} · {selectedVendorStyle.name}
                        </p>
                        <p className="text-xs text-cmp-gray">
                          {selectedVendorStyle.vendor === "ss" ? "S&S" : "SanMar"} · {selectedVendorStyle.brand}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="text-xs text-cmp-cyan font-medium"
                        aria-label={`Change vendor style from ${selectedVendorStyle.styleCode}`}
                        onClick={() => {
                          clearVendorItemQuote();
                          setSelectedVendorStyle(null);
                        }}
                      >
                        Change
                      </button>
                    </div>

                    {vendorVariantsLoading && (
                      <div className="flex items-center gap-2 text-xs text-cmp-gray">
                        <LoadingSpinner />
                        Loading variants...
                      </div>
                    )}

                    {vendorVariants.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label htmlFor="vendor-color" className="cmp-label">
                            Color
                          </label>
                          <select
                            id="vendor-color"
                            className="cmp-select"
                            value={selectedVendorColor}
                            onChange={(e) => {
                              clearVendorItemQuote();
                              setSelectedVendorColor(e.target.value);
                              setSelectedCatalogVariantId("");
                            }}
                          >
                            <option value="">Select color...</option>
                            {vendorColors.map((color) => (
                              <option key={color} value={color}>{color}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="vendor-size" className="cmp-label">
                            Size
                          </label>
                          <select
                            id="vendor-size"
                            className="cmp-select"
                            value={selectedCatalogVariantId}
                            onChange={(e) => {
                              clearVendorItemQuote();
                              setSelectedCatalogVariantId(e.target.value);
                            }}
                            disabled={!selectedVendorColor}
                          >
                            <option value="">Select size...</option>
                            {vendorSizes.map((variant) => {
                              const availability = describeVariantAvailability(variant);
                              return (
                                <option
                                  key={variant.id}
                                  value={variant.id}
                                  disabled={availability.disabled}
                                >
                                  {availability.optionLabel}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      </div>
                    )}

                    {selectedVendorVariant && (
                      <div className="text-xs text-cmp-gray space-y-0.5">
                        <p>
                          Inventory: {selectedVendorVariant.inventoryQty == null ? "Unavailable" : selectedVendorVariant.inventoryQty}
                        </p>
                        <p>
                          Source: {selectedVendorVariant.sourceSyncAt ? new Date(selectedVendorVariant.sourceSyncAt).toLocaleDateString() : "Unknown"}
                        </p>
                        {isStaleVendorPricing(selectedVendorVariant.sourceSyncAt) && (
                          <p className="text-amber-700 font-medium" role="status">
                            Snapshot is stale. Verify vendor data before ordering.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="manual-cost" className="cmp-label">
                  Product Cost ($)
                </label>
                <input
                  id="manual-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  className="cmp-input"
                  value={manualCost}
                  onChange={(e) => {
                    invalidateItemQuote();
                    setManualCost(e.target.value);
                  }}
                  placeholder="e.g. 3.95"
                />
              </div>
            )}

            {/* Quantity — inline within product card */}
            <div className="mt-3 pt-3 border-t border-cmp-gray-light/30">
              <div className="flex items-end gap-3">
                <div className="flex-1 max-w-[160px]">
                  <label htmlFor="quantity-input" className="cmp-label">
                    Order Quantity
                  </label>
                  <input
                    id="quantity-input"
                    type="number"
                    min="1"
                    step="1"
                    className="cmp-input"
                    value={quantity}
                    onChange={(e) => handleQuantityChange(e.target.value)}
                  />
                </div>
                {isDecimalQuantity(quantity) && (
                  <p className="text-xs text-red-600 pb-2" role="alert">
                    Quantity must be a whole number.
                  </p>
                )}
                {managerReviewRequired && (
                  <p className="text-xs text-cmp-warning flex items-center gap-1 pb-2" role="status">
                    <span className="inline-block w-4 h-4 rounded-full bg-amber-100 text-center leading-4 text-[10px] font-bold shrink-0">!</span>
                    Quantities over 5,000 require manager review.
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* Decoration — compressed read-only context */}
          <section className="cmp-card px-4 py-2.5" aria-labelledby="decoration-heading">
            <div className="flex items-center gap-2 flex-wrap">
              <h2
                id="decoration-heading"
                className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal font-display shrink-0"
              >
                Decoration
              </h2>
              <span className="text-cmp-gray text-[11px]">
                DTF · Average · 10&times;10 in · 1 loc · Tier Matrix T1
              </span>
              <span className="text-[10px] text-cmp-gray/60 ml-auto hidden sm:inline">
                Fixed P0
              </span>
            </div>
          </section>

          {additionalLocationsEnabled ? (
            /* Additional Locations — multi-row */
            <section className="cmp-card p-4" aria-labelledby="additional-locations-heading">
              <div className="flex items-center justify-between mb-2">
                <h2
                  id="additional-locations-heading"
                  className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal font-display"
                >
                  Additional Locations
                </h2>
                <button
                  type="button"
                  onClick={addLocation}
                  className="text-xs font-medium text-cmp-cyan hover:text-cmp-cyan/80 transition-colors"
                  data-testid="add-location-btn"
                >
                  + Add Location
                </button>
              </div>

              {additionalLocations.length === 0 && (
                <p className="text-xs text-cmp-gray py-1">
                  No additional locations selected.
                </p>
              )}

              <div className="space-y-2">
                {additionalLocations.map((loc) => {
                  const availableServices = FLAT_FEE_SERVICES.filter(
                    (s) => s === loc.service || !selectedLocationServices.has(s)
                  );
                  return (
                    <div
                      key={loc.id}
                      className="flex items-center gap-2"
                      data-testid={`location-row-${loc.id}`}
                    >
                      <select
                        className="cmp-select flex-1"
                        value={loc.service}
                        onChange={(e) => updateLocationService(loc.id, e.target.value)}
                        aria-label={`Service for location ${loc.id}`}
                      >
                        <option value="">Select service...</option>
                        {availableServices.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      {loc.loading && (
                        <LoadingSpinner />
                      )}
                      {loc.quote && !loc.loading && (
                        <span className="text-xs text-cmp-charcoal font-medium min-w-[60px] text-right">
                          {formatCurrency(loc.quote.effectivePrice)}
                        </span>
                      )}
                      {loc.error && (
                        <span className="text-xs text-red-600" role="alert">Error</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeLocation(loc.id)}
                        className="text-cmp-gray hover:text-red-500 transition-colors text-sm shrink-0"
                        aria-label={`Remove location ${loc.service || loc.id}`}
                      >
                        &times;
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            /* Legacy Add-On Service — compact */
            <section className="cmp-card p-4" aria-labelledby="flat-fee-heading">
              <h2
                id="flat-fee-heading"
                className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-2 font-display"
              >
                Add-On Service
              </h2>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label htmlFor="service-select" className="cmp-label">
                    Service
                  </label>
                  <select
                    id="service-select"
                    className="cmp-select"
                    value={selectedService}
                    onChange={(e) => setSelectedService(e.target.value)}
                  >
                    <option value="">None</option>
                    {FLAT_FEE_SERVICES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                {selectedService && (
                  <div className="w-28">
                    <label htmlFor="flat-fee-qty" className="cmp-label">
                      Service Qty
                    </label>
                    <input
                      id="flat-fee-qty"
                      type="number"
                      min="1"
                      step="1"
                      className="cmp-input"
                      value={flatFeeQuantity}
                      onChange={(e) => setFlatFeeQuantity(e.target.value)}
                      placeholder={quantity}
                    />
                  </div>
                )}
              </div>

              {/* Manager edits for flat-fee */}
              {selectedService && role === "manager" && (
                <div className="mt-3 pt-2.5 border-t border-cmp-gray-light/50 space-y-2.5">
                  <p className="text-[10px] text-cmp-warning font-medium uppercase tracking-wider">
                    Manager Controls
                  </p>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label htmlFor="extra-op-min" className="cmp-label">
                        Extra Op Min/Shirt
                      </label>
                      <input
                        id="extra-op-min"
                        type="number"
                        min="0"
                        step="0.5"
                        className="cmp-input"
                        value={extraOpMinutes}
                        onChange={(e) => setExtraOpMinutes(e.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="extra-des-min" className="cmp-label">
                        Extra Des Min/Order
                      </label>
                      <input
                        id="extra-des-min"
                        type="number"
                        min="0"
                        step="0.5"
                        className="cmp-input"
                        value={extraDesMinutes}
                        onChange={(e) => setExtraDesMinutes(e.target.value)}
                      />
                    </div>
                    <div>
                      <label htmlFor="manual-override" className="cmp-label">
                        Override ($)
                      </label>
                      <input
                        id="manual-override"
                        type="number"
                        min="0"
                        step="0.01"
                        className="cmp-input"
                        value={manualOverride}
                        onChange={(e) => setManualOverride(e.target.value)}
                        placeholder="Auto"
                      />
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        {/* RIGHT: Summary */}
        <aside className="lg:w-[340px] lg:sticky lg:top-3 lg:self-start space-y-3">
          {/* Item Price Summary */}
          <div className="cmp-card p-4" aria-labelledby="item-summary-heading">
            <h2
              id="item-summary-heading"
              className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
            >
              Item Price
            </h2>

            {itemError && (
              <div
                className="mb-3 rounded-md bg-red-50 border border-red-200 p-2.5 text-xs text-red-700"
                role="alert"
              >
                {itemError}
              </div>
            )}

            {managerReviewRequired && (
              <div
                className="mb-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 text-center"
                role="status"
                data-testid="manager-review-banner"
              >
                <span className="inline-block w-5 h-5 rounded-full bg-amber-100 text-center leading-5 text-xs font-bold mr-1.5">!</span>
                Manager review required. Quantities over 5,000 cannot be quoted automatically.
              </div>
            )}

            {itemLoading && !itemQuote && (
              <div className="flex items-center gap-2 text-xs text-cmp-gray py-3">
                <LoadingSpinner />
                Calculating...
              </div>
            )}

            {itemQuote && (
              <div className={itemLoading ? "opacity-60 transition-opacity" : ""}>
                {/* Hero price */}
                <div className="text-center mb-3">
                  <p className="text-[10px] text-cmp-gray uppercase tracking-wider mb-0.5">
                    {additionalLocationsEnabled ? "Final Per-Item Price" : "Per-Item Price"}
                  </p>
                  <p
                    className={`cmp-price-hero ${additionalLocationsAnyLoading ? "opacity-60" : ""}`}
                    aria-label={`Per-item price: ${formatCurrency(finalPerItemPrice)}`}
                  >
                    {formatCurrency(finalPerItemPrice)}
                  </p>
                  <p className="text-[10px] text-cmp-gray mt-0.5">
                    Tier: {itemQuote.tierLabel}
                  </p>
                </div>

                {/* Breakdown */}
                <div className="space-y-1 text-sm border-t border-cmp-gray-light/50 pt-2.5">
                  <Row label="Product Sell" value={formatCurrency(itemQuote.productSell)} />
                  <Row
                    label={additionalLocationsEnabled ? "Base Decoration Sell" : "Decoration Sell"}
                    value={formatCurrency(itemQuote.decorationSell)}
                  />
                  {additionalLocationsEnabled && additionalLocations.map((loc) =>
                    loc.quote ? (
                      <Row
                        key={loc.id}
                        label={loc.service}
                        value={formatCurrency(loc.quote.effectivePrice)}
                      />
                    ) : null
                  )}
                  <Row
                    label={additionalLocationsEnabled ? "Final Per-Item Price" : "Sales Price"}
                    value={formatCurrency(finalPerItemPrice)}
                    bold
                  />
                </div>

                {/* COGS & Contribution Breakdown (protected feature only) */}
                {additionalLocationsEnabled && isManagerItem(itemQuote) && (
                  <div className="mt-2.5 pt-2.5 border-t border-cmp-gray-light/50 space-y-1 text-sm" data-testid="cogs-breakdown">
                    <p className="text-[10px] text-cmp-warning font-medium uppercase tracking-wider mb-1.5">
                      COGS Breakdown
                    </p>
                    <Row label="Product COGS" value={formatCurrency(itemQuote.totalProductionCogs - itemQuote.totalDecorationCogs)} />
                    <Row label="Base Decoration COGS" value={formatCurrency(itemQuote.totalDecorationCogs)} />
                    {additionalLocations.map((loc) =>
                      loc.quote && isManagerFlatFee(loc.quote) ? (
                        <Row
                          key={`cogs-${loc.id}`}
                          label={`${loc.service} COGS`}
                          value={formatCurrency(loc.quote.engineCogs)}
                        />
                      ) : null
                    )}
                    {totalCogsPerItem !== null && (
                      <Row
                        label="Total COGS / Item"
                        value={formatCurrency(totalCogsPerItem)}
                        bold
                      />
                    )}
                    <Row label="Commission Reserve" value={formatCurrency(combinedCommissionReserve)} />
                    {combinedGrossProfit !== null && (
                      <Row label="Gross Profit" value={formatCurrency(combinedGrossProfit)} />
                    )}
                    {combinedNetContribution !== null && (
                      <Row label="Net Contribution" value={formatCurrency(combinedNetContribution)} />
                    )}
                    {combinedGrossMargin !== null && (
                      <Row label="Gross Margin" value={formatPercent(combinedGrossMargin)} />
                    )}
                    {combinedContributionMargin !== null && (
                      <Row label="Post-Commission Contribution Margin" value={formatPercent(combinedContributionMargin)} />
                    )}
                    {itemQuote.vendorCatalog && (
                      <>
                        <Row
                          label="Vendor Variant"
                          value={`${itemQuote.vendorCatalog.vendor.toUpperCase()} ${itemQuote.vendorCatalog.styleCode}`}
                        />
                        <Row
                          label="Variant Cost"
                          value={formatCurrency(itemQuote.vendorCatalog.unitCost)}
                        />
                        <Row
                          label="Cost Basis"
                          value={itemQuote.vendorCatalog.costBasis}
                        />
                        <Row
                          label="Source Date"
                          value={
                            itemQuote.vendorCatalog.sourceSyncAt
                              ? new Date(itemQuote.vendorCatalog.sourceSyncAt).toLocaleDateString()
                              : "Unknown"
                          }
                        />
                      </>
                    )}
                  </div>
                )}

                {/* Manager details (non-additional-locations mode) */}
                {!additionalLocationsEnabled && isManagerItem(itemQuote) && (
                  <div className="mt-2.5 pt-2.5 border-t border-cmp-gray-light/50 space-y-1 text-sm">
                    <p className="text-[10px] text-cmp-warning font-medium uppercase tracking-wider mb-1.5">
                      Internal Details
                    </p>
                    <Row
                      label="Commission Reserve"
                      value={formatCurrency(itemQuote.commissionReserve)}
                    />
                    <Row
                      label="Decoration COGS"
                      value={formatCurrency(itemQuote.totalDecorationCogs)}
                    />
                    <Row
                      label="Total Production COGS"
                      value={formatCurrency(itemQuote.totalProductionCogs)}
                    />
                    <Row
                      label="Gross Profit"
                      value={formatCurrency(itemQuote.grossProfitBeforeCommission)}
                    />
                    <Row
                      label="Net Contribution"
                      value={formatCurrency(itemQuote.netContributionAfterCommission)}
                    />
                    <Row
                      label="Gross Margin"
                      value={formatPercent(itemQuote.combinedGrossMarginBeforeCommission)}
                    />
                    <Row
                      label="Contribution Margin"
                      value={formatPercent(itemQuote.contributionMarginAfterCommission)}
                    />
                    {itemQuote.vendorCatalog && (
                      <>
                        <Row
                          label="Vendor Variant"
                          value={`${itemQuote.vendorCatalog.vendor.toUpperCase()} ${itemQuote.vendorCatalog.styleCode}`}
                        />
                        <Row
                          label="Variant Cost"
                          value={formatCurrency(itemQuote.vendorCatalog.unitCost)}
                        />
                        <Row
                          label="Cost Basis"
                          value={itemQuote.vendorCatalog.costBasis}
                        />
                        <Row
                          label="Source Date"
                          value={
                            itemQuote.vendorCatalog.sourceSyncAt
                              ? new Date(itemQuote.vendorCatalog.sourceSyncAt).toLocaleDateString()
                              : "Unknown"
                          }
                        />
                      </>
                    )}
                  </div>
                )}

                {/* Order totals */}
                <div className="mt-2.5 pt-2.5 border-t border-cmp-gray-light/50 space-y-1 text-sm">
                  <Row
                    label={additionalLocationsEnabled ? "Combined Order Total" : "Item Order Total"}
                    value={formatCurrency(additionalLocationsEnabled ? orderTotal : itemQuote.salesOrderTotal)}
                    bold
                  />
                  {isManagerItem(itemQuote) && (
                    <>
                      <Row
                        label={additionalLocationsEnabled ? "Combined Production COGS Total" : "Production COGS Total"}
                        value={formatCurrency(
                          additionalLocationsEnabled && totalCogsPerItem !== null
                            ? totalCogsPerItem * qty
                            : itemQuote.productionCogsOrderTotal
                        )}
                      />
                      <Row
                        label={additionalLocationsEnabled ? "Combined Net Contribution Total" : "Net Contribution Total"}
                        value={formatCurrency(
                          additionalLocationsEnabled && combinedNetContribution !== null
                            ? combinedNetContribution * qty
                            : itemQuote.netContributionOrderTotal
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {!itemQuote && !itemLoading && !itemError && (
              <p className="text-sm text-cmp-gray py-3 text-center">
                Select a product and quantity to see pricing.
              </p>
            )}
          </div>

          {/* Flat-Fee Summary (legacy mode only) */}
          {!additionalLocationsEnabled && selectedService && (
            <div className="cmp-card p-4" aria-labelledby="flat-fee-summary-heading">
              <h2
                id="flat-fee-summary-heading"
                className="text-xs font-bold uppercase tracking-wider text-cmp-charcoal mb-3 font-display"
              >
                Add-On: {selectedService}
              </h2>

              {flatFeeError && (
                <div
                  className="mb-2.5 rounded-md bg-red-50 border border-red-200 p-2.5 text-xs text-red-700"
                  role="alert"
                >
                  {flatFeeError}
                </div>
              )}

              {flatFeeLoading && !flatFeeQuote && (
                <div className="flex items-center gap-2 text-xs text-cmp-gray py-3">
                  <LoadingSpinner />
                  Calculating...
                </div>
              )}

              {flatFeeQuote && (
                <div className={flatFeeLoading ? "opacity-60 transition-opacity" : ""}>
                  <div className="text-center mb-3">
                    <p className="text-[10px] text-cmp-gray uppercase tracking-wider mb-0.5">
                      Per-Shirt Price
                    </p>
                    <p className="cmp-price-hero" aria-label={`Add-on per-shirt price: ${formatCurrency(flatFeeQuote.effectivePrice)}`}>
                      {formatCurrency(flatFeeQuote.effectivePrice)}
                    </p>
                    <p className="text-[10px] text-cmp-gray mt-0.5">
                      {flatFeeQuote.status}
                    </p>
                  </div>

                  <div className="space-y-1 text-sm border-t border-cmp-gray-light/50 pt-2.5">
                    <Row
                      label="Billable Quantity"
                      value={String(flatFeeQuote.billableQuantity)}
                    />
                    <Row
                      label="Add-On Total"
                      value={formatCurrency(flatFeeQuote.addOnTotal)}
                      bold
                    />
                  </div>

                  {/* Manager flat-fee details */}
                  {isManagerFlatFee(flatFeeQuote) && (
                    <div className="mt-2.5 pt-2.5 border-t border-cmp-gray-light/50 space-y-1 text-sm">
                      <p className="text-[10px] text-cmp-warning font-medium uppercase tracking-wider mb-1.5">
                        Internal Details
                      </p>
                      <Row label="Engine COGS" value={formatCurrency(flatFeeQuote.engineCogs)} />
                      <Row label="Engine Price" value={formatCurrency(flatFeeQuote.enginePrice)} />
                      <Row label="Policy Floor" value={formatCurrency(flatFeeQuote.policyFloor)} />
                      <Row label="Gross Margin" value={formatPercent(flatFeeQuote.grossMargin)} />
                      <Row
                        label="Operator Operating Cost"
                        value={formatCurrency(flatFeeQuote.operatorOperatingCost)}
                      />
                      <Row
                        label="Extra Operator Labor"
                        value={formatCurrency(flatFeeQuote.extraOperatorLabor)}
                      />
                      <Row
                        label="Extra Designer Labor"
                        value={formatCurrency(flatFeeQuote.extraDesignerLabor)}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Combined Order Total */}
          {itemQuote && (
            <div className="cmp-card p-4 bg-cmp-charcoal text-white">
              <p className="text-[10px] uppercase tracking-wider text-cmp-gray-light mb-0.5">
                Order Total
              </p>
              <p
                className="text-2xl font-bold tracking-tight font-display"
                aria-label={`Order total: ${formatCurrency(orderTotal)}`}
              >
                {formatCurrency(orderTotal)}
              </p>
              {(additionalLocationsEnabled ? additionalLocations.some((l) => l.quote) : flatFeeQuote) && (
                <p className="text-[10px] text-cmp-gray-light mt-0.5">
                  {additionalLocationsEnabled ? "Items + Additional Locations" : "Items + Add-On"}
                </p>
              )}
            </div>
          )}

          {/* Mobile sticky total */}
          {itemQuote && (
            <div className="lg:hidden fixed bottom-0 inset-x-0 bg-cmp-charcoal px-4 py-2.5 flex items-center justify-between z-10 border-t border-cmp-gray/30">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-cmp-gray-light">
                  Per Item
                </p>
                <p className="text-lg font-bold text-white font-display">
                  {formatCurrency(finalPerItemPrice)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider text-cmp-gray-light">
                  Order Total
                </p>
                <p className="text-lg font-bold text-cmp-cyan font-display">
                  {formatCurrency(orderTotal)}
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Spacer for mobile sticky bar */}
      {itemQuote && <div className="lg:hidden h-14" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <span className="text-cmp-gray text-xs">{label}</span>
      <span className={bold ? "font-semibold text-cmp-charcoal" : "text-cmp-charcoal"}>
        {value}
      </span>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-cmp-cyan"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

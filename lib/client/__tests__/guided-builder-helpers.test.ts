import { describe, it, expect } from "vitest";
import {
  STEPS,
  stepIndex,
  canGoBack,
  canGoNext,
  prevStep,
  nextStep,
  isStepValid,
  progressFraction,
  needsManagerReview,
  buildItemRequestBody,
  buildFlatFeeRequestBody,
  INITIAL_STATE,
  type BuilderState,
} from "../guided-builder-helpers";

describe("step navigation", () => {
  it("STEPS has four entries in order", () => {
    expect(STEPS).toEqual(["product", "quantity", "decoration", "review"]);
  });

  it("stepIndex returns correct indices", () => {
    expect(stepIndex("product")).toBe(0);
    expect(stepIndex("review")).toBe(3);
  });

  it("canGoBack / canGoNext", () => {
    expect(canGoBack("product")).toBe(false);
    expect(canGoBack("quantity")).toBe(true);
    expect(canGoNext("review")).toBe(false);
    expect(canGoNext("decoration")).toBe(true);
  });

  it("prevStep / nextStep", () => {
    expect(prevStep("product")).toBeNull();
    expect(prevStep("quantity")).toBe("product");
    expect(nextStep("decoration")).toBe("review");
    expect(nextStep("review")).toBeNull();
  });

  it("progressFraction", () => {
    expect(progressFraction("product")).toBe(0.25);
    expect(progressFraction("review")).toBe(1);
  });
});

describe("isStepValid", () => {
  it("product step: catalog mode requires SKU", () => {
    expect(
      isStepValid("product", { ...INITIAL_STATE, productMode: "catalog", selectedSku: "" })
    ).toBe(false);
    expect(
      isStepValid("product", { ...INITIAL_STATE, productMode: "catalog", selectedSku: "ST400" })
    ).toBe(true);
  });

  it("product step: manual mode requires valid cost", () => {
    expect(
      isStepValid("product", { ...INITIAL_STATE, productMode: "manual", manualCost: "" })
    ).toBe(false);
    expect(
      isStepValid("product", { ...INITIAL_STATE, productMode: "manual", manualCost: "3.95" })
    ).toBe(true);
    expect(
      isStepValid("product", { ...INITIAL_STATE, productMode: "manual", manualCost: "0" })
    ).toBe(true);
  });

  it("quantity step requires positive integer", () => {
    expect(isStepValid("quantity", { ...INITIAL_STATE, quantity: "0" })).toBe(false);
    expect(isStepValid("quantity", { ...INITIAL_STATE, quantity: "84" })).toBe(true);
    expect(isStepValid("quantity", { ...INITIAL_STATE, quantity: "" })).toBe(false);
  });

  it("decoration and review are always valid", () => {
    expect(isStepValid("decoration", INITIAL_STATE)).toBe(true);
    expect(isStepValid("review", INITIAL_STATE)).toBe(true);
  });
});

describe("needsManagerReview", () => {
  it("returns false for quantities <= 5000", () => {
    expect(needsManagerReview("5000")).toBe(false);
    expect(needsManagerReview("84")).toBe(false);
  });

  it("returns true for quantities > 5000", () => {
    expect(needsManagerReview("5001")).toBe(true);
    expect(needsManagerReview("10000")).toBe(true);
  });

  it("returns false for invalid input", () => {
    expect(needsManagerReview("")).toBe(false);
    expect(needsManagerReview("abc")).toBe(false);
  });
});

describe("buildItemRequestBody", () => {
  it("returns null for invalid state", () => {
    expect(buildItemRequestBody(INITIAL_STATE)).toBeNull();
  });

  it("builds catalog request", () => {
    const state: BuilderState = {
      ...INITIAL_STATE,
      selectedSku: "ST400",
      quantity: "84",
    };
    expect(buildItemRequestBody(state)).toEqual({
      sku: "ST400",
      quantity: 84,
    });
  });

  it("builds manual cost request", () => {
    const state: BuilderState = {
      ...INITIAL_STATE,
      productMode: "manual",
      manualCost: "3.95",
      quantity: "84",
    };
    expect(buildItemRequestBody(state)).toEqual({
      productCost: 3.95,
      quantity: 84,
    });
  });
});

describe("buildFlatFeeRequestBody", () => {
  it("returns null when no service selected", () => {
    expect(buildFlatFeeRequestBody(INITIAL_STATE)).toBeNull();
  });

  it("builds flat-fee request with defaults", () => {
    const state: BuilderState = {
      ...INITIAL_STATE,
      selectedService: "Sleeve Print",
      quantity: "84",
    };
    expect(buildFlatFeeRequestBody(state)).toEqual({
      service: "Sleeve Print",
      orderQuantity: 84,
      extraOperatorMinutesPerShirt: 0,
      extraDesignerMinutesPerOrder: 0,
      manualOverride: null,
    });
  });

  it("uses flatFeeQuantity when provided", () => {
    const state: BuilderState = {
      ...INITIAL_STATE,
      selectedService: "Name",
      quantity: "84",
      flatFeeQuantity: "50",
    };
    const body = buildFlatFeeRequestBody(state);
    expect(body).not.toBeNull();
    expect(body!.orderQuantity).toBe(50);
  });

  it("includes manual override when provided", () => {
    const state: BuilderState = {
      ...INITIAL_STATE,
      selectedService: "Name",
      quantity: "84",
      manualOverride: "5.00",
    };
    const body = buildFlatFeeRequestBody(state);
    expect(body).not.toBeNull();
    expect(body!.manualOverride).toBe(5);
  });
});

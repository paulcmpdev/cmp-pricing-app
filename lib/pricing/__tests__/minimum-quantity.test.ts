import { describe, it, expect } from "vitest";
import { flatFeeBillableQuantity, validateQuantity } from "../quantity";
import scenarios from "@/lib/fixtures/parity-scenarios.json";

const scenario = scenarios.scenarios.find((s) => s.id === "minimum-quantity")!;

describe("minimum-quantity parity", () => {
  const inputs = scenario.inputs as number[];
  const expectedBillable = scenario.expectedBillable as number[];

  it.each(inputs.map((q, i) => [q, expectedBillable[i]]))(
    "quantity %d bills at %d",
    (input, expected) => {
      expect(flatFeeBillableQuantity(input)).toBe(expected);
    }
  );
});

describe("quantity validation", () => {
  it("rejects zero", () => {
    expect(validateQuantity(0).valid).toBe(false);
  });

  it("rejects negative", () => {
    expect(validateQuantity(-5).valid).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(validateQuantity(3.5).valid).toBe(false);
  });

  it("accepts 1", () => {
    expect(validateQuantity(1).valid).toBe(true);
    expect(validateQuantity(1).requiresManagerReview).toBe(false);
  });

  it("accepts 5000 without manager review", () => {
    expect(validateQuantity(5000).valid).toBe(true);
    expect(validateQuantity(5000).requiresManagerReview).toBe(false);
  });

  it("flags 5001 for manager review", () => {
    const result = validateQuantity(5001);
    expect(result.valid).toBe(true);
    expect(result.requiresManagerReview).toBe(true);
  });
});

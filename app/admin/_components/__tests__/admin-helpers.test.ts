import { describe, it, expect } from "vitest";
import {
  healthLabel,
  healthColor,
  formatNumber,
  formatTimestamp,
  formatRelativeTime,
  jobStatusSummary,
  rollbackSummaryText,
  vendorHealthSummary,
} from "../admin-helpers";

describe("admin-helpers", () => {
  describe("healthLabel", () => {
    it("returns Healthy for healthy", () => {
      expect(healthLabel("healthy")).toBe("Healthy");
    });
    it("returns Warning for warning", () => {
      expect(healthLabel("warning")).toBe("Warning");
    });
    it("returns Unavailable for unavailable", () => {
      expect(healthLabel("unavailable")).toBe("Unavailable");
    });
  });

  describe("healthColor", () => {
    it("returns success class for healthy", () => {
      expect(healthColor("healthy")).toContain("green");
    });
    it("returns warning class for warning", () => {
      expect(healthColor("warning")).toContain("amber");
    });
    it("returns danger class for unavailable", () => {
      expect(healthColor("unavailable")).toContain("red");
    });
  });

  describe("formatNumber", () => {
    it("formats zero", () => {
      expect(formatNumber(0)).toBe("0");
    });
    it("formats thousands with commas", () => {
      expect(formatNumber(221824)).toBe("221,824");
    });
    it("formats small numbers", () => {
      expect(formatNumber(42)).toBe("42");
    });
  });

  describe("formatTimestamp", () => {
    it("returns dash for null", () => {
      expect(formatTimestamp(null)).toBe("--");
    });
    it("formats ISO string to readable date", () => {
      const result = formatTimestamp("2025-09-09T12:30:00.000Z");
      expect(result).toMatch(/Sep/);
      expect(result).toMatch(/2025/);
    });
  });

  describe("formatRelativeTime", () => {
    it("returns dash for null", () => {
      expect(formatRelativeTime(null)).toBe("--");
    });
    it("returns a relative description for recent ISO timestamps", () => {
      const recent = new Date(Date.now() - 3600 * 1000).toISOString();
      const result = formatRelativeTime(recent);
      expect(result).toMatch(/ago|just now|hour/i);
    });
  });

  describe("jobStatusSummary", () => {
    it("returns no history message for empty jobs", () => {
      expect(jobStatusSummary([])).toBe("No refresh history");
    });
    it("returns count summary for populated jobs", () => {
      const jobs = [
        { vendor: "ss" as const, status: "completed", phase: "completed" as const, attempts: 1, createdAt: "2025-09-09T00:00:00Z", startedAt: "2025-09-09T00:01:00Z", completedAt: "2025-09-09T00:10:00Z" },
        { vendor: "sanmar" as const, status: "failed", phase: null, attempts: 2, createdAt: "2025-09-08T00:00:00Z", startedAt: "2025-09-08T00:01:00Z", completedAt: "2025-09-08T00:10:00Z" },
      ];
      const result = jobStatusSummary(jobs);
      expect(result).toContain("2");
    });
  });

  describe("rollbackSummaryText", () => {
    it("returns no rollbacks message when count is 0", () => {
      expect(rollbackSummaryText({ totalCount: 0, latestAt: null })).toBe(
        "No rollbacks"
      );
    });
    it("returns count and latest for populated summary", () => {
      const result = rollbackSummaryText({
        totalCount: 3,
        latestAt: "2025-09-01T00:00:00Z",
      });
      expect(result).toContain("3");
      expect(result).toMatch(/rollback/i);
    });
  });

  describe("vendorHealthSummary", () => {
    it("returns healthy count out of total", () => {
      expect(vendorHealthSummary(2, 2)).toContain("2");
      expect(vendorHealthSummary(2, 2)).toContain("healthy");
    });
    it("handles zero healthy", () => {
      expect(vendorHealthSummary(0, 2)).toContain("0");
    });
  });
});

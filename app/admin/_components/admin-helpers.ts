import type {
  AdminCatalogHealth,
  AdminCatalogRecentJob,
  AdminCatalogRollbackSummary,
} from "@/lib/server/vendor-catalog/admin-overview";

export function healthLabel(health: AdminCatalogHealth): string {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "unavailable":
      return "Unavailable";
  }
}

export function healthColor(health: AdminCatalogHealth): string {
  switch (health) {
    case "healthy":
      return "text-green-400";
    case "warning":
      return "text-amber-400";
    case "unavailable":
      return "text-red-400";
  }
}

export function healthBgColor(health: AdminCatalogHealth): string {
  switch (health) {
    case "healthy":
      return "bg-green-400/15 text-green-400 border-green-400/30";
    case "warning":
      return "bg-amber-400/15 text-amber-400 border-amber-400/30";
    case "unavailable":
      return "bg-red-400/15 text-red-400 border-red-400/30";
  }
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatTimestamp(ts: string | null): string {
  if (!ts) return "--";
  const date = new Date(ts);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeTime(ts: string | null): string {
  if (!ts) return "--";
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function jobStatusSummary(jobs: AdminCatalogRecentJob[]): string {
  if (jobs.length === 0) return "No refresh history";
  return `${jobs.length} recent refresh${jobs.length === 1 ? "" : "es"}`;
}

export function rollbackSummaryText(
  summary: AdminCatalogRollbackSummary
): string {
  if (summary.totalCount === 0) return "No rollbacks";
  return `${summary.totalCount} rollback${summary.totalCount === 1 ? "" : "s"}`;
}

export function vendorHealthSummary(
  healthyCount: number,
  totalCount: number
): string {
  return `${healthyCount} of ${totalCount} vendors healthy`;
}

export function jobPhaseLabel(phase: string | null): string {
  if (!phase) return "--";
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

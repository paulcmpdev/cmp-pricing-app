import React from "react";
import type {
  AdminCatalogOverview,
  AdminCatalogVendor,
  AdminCatalogVendorOverview,
  AdminCatalogRecentJob,
  AdminCatalogRollbackSummary,
} from "@/lib/server/vendor-catalog/admin-overview";
import {
  healthLabel,
  healthColor,
  healthBgColor,
  formatNumber,
  formatTimestamp,
  formatRelativeTime,
  jobStatusSummary,
  rollbackSummaryText,
  vendorHealthSummary,
  jobPhaseLabel,
} from "./admin-helpers";

export default function AdminDashboard({
  overview,
}: {
  overview: AdminCatalogOverview;
}) {
  if (!overview.available) {
    return <UnavailableState reason={overview.reason} />;
  }

  return (
    <div className="space-y-6">
      <OverviewHero overview={overview} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <VendorCard vendor="ss" data={overview.vendors.ss} />
        <VendorCard vendor="sanmar" data={overview.vendors.sanmar} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RecentJobs jobs={overview.recentJobs} />
        <RollbackSummary
          rollbacks={overview.rollbackSummary}
          vendors={overview.vendors}
        />
      </div>
      <OperationsPreview />
    </div>
  );
}

function UnavailableState({ reason }: { reason?: string }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-red-400/20 bg-red-400/5 p-6">
        <div className="flex items-center gap-3 mb-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400" />
          <h2 className="text-lg font-semibold text-white font-display">
            Catalog Unavailable
          </h2>
        </div>
        <p className="text-sm text-neutral-400">
          {reason || "The vendor catalog overview is unavailable."}
        </p>
      </div>
      <OperationsPreview />
    </div>
  );
}

function OverviewHero({ overview }: { overview: AdminCatalogOverview }) {
  const { totals, generatedAt } = overview;
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              totals.healthyVendorCount === 2 ? "bg-green-400" : "bg-amber-400"
            }`}
          />
          <h2 className="text-lg font-semibold text-white font-display">
            System Overview
          </h2>
        </div>
        <span className="text-xs text-neutral-400">
          Generated {formatTimestamp(generatedAt)}
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatBlock
          label="Vendor Health"
          value={vendorHealthSummary(totals.healthyVendorCount, 2)}
        />
        <StatBlock
          label="Total Styles"
          value={formatNumber(totals.styleCount)}
        />
        <StatBlock
          label="Total Variants"
          value={formatNumber(totals.variantCount)}
        />
        <StatBlock
          label="Backend"
          value={overview.backend === "postgres" ? "PostgreSQL" : overview.backend}
        />
      </dl>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-neutral-400 mb-1">
        {label}
      </dt>
      <dd className="text-sm font-medium text-neutral-200">{value}</dd>
    </div>
  );
}

function VendorCard({
  vendor,
  data,
}: {
  vendor: AdminCatalogVendor;
  data: AdminCatalogVendorOverview;
}) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              data.health === "healthy"
                ? "bg-green-400"
                : data.health === "warning"
                  ? "bg-amber-400"
                  : "bg-red-400"
            }`}
          />
          <h3 className="text-sm font-semibold text-white font-display tracking-wide">
            {data.label}
          </h3>
        </div>
        <span
          className={`text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border ${healthBgColor(data.health)}`}
        >
          {healthLabel(data.health)}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
        <StatBlock label="Active" value={data.active ? "Yes" : "No"} />
        <StatBlock
          label="Import Status"
          value={data.activeImportStatus || "--"}
        />
        <StatBlock label="Styles" value={formatNumber(data.styleCount)} />
        <StatBlock label="Variants" value={formatNumber(data.variantCount)} />
        <StatBlock
          label="Source Status"
          value={data.sourceStatus || "--"}
        />
        <StatBlock
          label="Source Errors"
          value={
            data.sourceErrors > 0
              ? String(data.sourceErrors)
              : "0"
          }
        />
        <StatBlock
          label="Source Synced"
          value={formatRelativeTime(data.sourceSyncAt)}
        />
        <StatBlock
          label="Imported"
          value={formatRelativeTime(data.importedAt)}
        />
        <StatBlock
          label="Activated"
          value={formatRelativeTime(data.activatedAt)}
        />
        <StatBlock
          label={`Canary ${data.canaryStyleCode}`}
          value={`${data.canaryStyleRows}s / ${data.canaryVariantRows}v`}
        />
      </dl>

      {data.activeJobStatus && (
        <div className="mt-3 pt-3 border-t border-neutral-700/50">
          <div className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-xs text-cyan-400">
              Active job: {data.activeJobStatus}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function RecentJobs({ jobs }: { jobs: AdminCatalogRecentJob[] }) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white font-display tracking-wide">
          Recent Refreshes
        </h3>
        <span className="text-xs text-neutral-400">
          {jobStatusSummary(jobs)}
        </span>
      </div>
      {jobs.length === 0 ? (
        <p className="text-sm text-neutral-400">No refresh history available.</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-neutral-400 uppercase tracking-wider border-b border-neutral-700/50">
                  <th className="text-left pb-2 pr-3 font-medium">Vendor</th>
                  <th className="text-left pb-2 pr-3 font-medium">Status</th>
                  <th className="text-left pb-2 pr-3 font-medium">Phase</th>
                  <th className="text-right pb-2 pr-3 font-medium">Tries</th>
                  <th className="text-left pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-700/30">
                {jobs.map((job, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 text-neutral-300">
                      {job.vendor === "ss" ? "S&S" : "SanMar"}
                    </td>
                    <td className="py-2 pr-3">
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td className="py-2 pr-3 text-neutral-400">
                      {jobPhaseLabel(job.phase)}
                    </td>
                    <td className="py-2 pr-3 text-right text-neutral-400">
                      {job.attempts}
                    </td>
                    <td className="py-2 text-neutral-400">
                      {formatRelativeTime(job.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-2">
            {jobs.map((job, i) => (
              <div
                key={i}
                className="rounded border border-neutral-700/30 p-3 space-y-1"
              >
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-neutral-300">
                    {job.vendor === "ss" ? "S&S" : "SanMar"}
                  </span>
                  <JobStatusBadge status={job.status} />
                </div>
                <div className="flex justify-between text-[11px] text-neutral-400">
                  <span>{jobPhaseLabel(job.phase)}</span>
                  <span>{formatRelativeTime(job.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function JobStatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "text-green-400"
      : status === "failed"
        ? "text-red-400"
        : status === "running" || status === "validating"
          ? "text-cyan-400"
          : "text-neutral-400";
  return <span className={`text-xs font-medium ${color}`}>{status}</span>;
}

function RollbackSummary({
  rollbacks,
  vendors,
}: {
  rollbacks: Record<AdminCatalogVendor, AdminCatalogRollbackSummary>;
  vendors: Record<AdminCatalogVendor, AdminCatalogVendorOverview>;
}) {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <h3 className="text-sm font-semibold text-white font-display tracking-wide mb-4">
        Rollback History
      </h3>
      <div className="space-y-3">
        {(["ss", "sanmar"] as const).map((vendor) => (
          <div
            key={vendor}
            className="flex items-center justify-between text-sm"
          >
            <span className="text-neutral-300">{vendors[vendor].label}</span>
            <div className="text-right">
              <span className="text-xs text-neutral-400">
                {rollbackSummaryText(rollbacks[vendor])}
              </span>
              {rollbacks[vendor].latestAt && (
                <span className="text-[11px] text-neutral-400 ml-2">
                  latest {formatRelativeTime(rollbacks[vendor].latestAt)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperationsPreview() {
  return (
    <div className="rounded-lg border border-neutral-700/50 bg-neutral-800/50 p-5">
      <h3 className="text-sm font-semibold text-white font-display tracking-wide mb-2">
        Operations
      </h3>
      <p className="text-xs text-neutral-400 mb-4">
        Login, authorization, and explicit production safeguards are required
        before enabling catalog operations. These controls are disabled in
        read-only preview mode.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          disabled
          className="px-3 py-1.5 text-xs font-medium rounded border border-neutral-600 bg-neutral-700/50 text-neutral-500 cursor-not-allowed"
        >
          Refresh Now
        </button>
        <button
          disabled
          className="px-3 py-1.5 text-xs font-medium rounded border border-neutral-600 bg-neutral-700/50 text-neutral-500 cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          disabled
          className="px-3 py-1.5 text-xs font-medium rounded border border-neutral-600 bg-neutral-700/50 text-neutral-500 cursor-not-allowed"
        >
          Retry
        </button>
        <button
          disabled
          className="px-3 py-1.5 text-xs font-medium rounded border border-neutral-600 bg-neutral-700/50 text-neutral-500 cursor-not-allowed"
        >
          Rollback
        </button>
      </div>
    </div>
  );
}

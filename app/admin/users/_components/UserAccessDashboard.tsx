"use client";

import React, { useCallback, useEffect, useState } from "react";

type UserRole = "sales_rep" | "manager" | "admin";
type UserStatus = "pending" | "active" | "disabled";

interface UserRecord {
  email: string;
  name: string | null;
  image: string | null;
  role: UserRole | null;
  status: UserStatus;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastSignInAt: string | null;
  isBootstrapAdmin?: boolean;
}

interface SummaryCounts {
  pending: number;
  active: number;
  disabled: number;
  admins: number;
}

interface AccessEvent {
  id: string;
  userEmail: string;
  action: string;
  actorEmail: string;
  beforeRole: string | null;
  afterRole: string | null;
  beforeStatus: string | null;
  afterStatus: string | null;
  createdAt: string;
}

type StatusFilter = "all" | UserStatus;

const ROLE_LABELS: Record<UserRole, string> = {
  sales_rep: "Sales Rep",
  manager: "Manager",
  admin: "Admin",
};

const STATUS_LABELS: Record<UserStatus, string> = {
  pending: "Pending",
  active: "Active",
  disabled: "Disabled",
};

const STATUS_COLORS: Record<UserStatus, string> = {
  pending: "bg-amber-900/40 text-amber-300 border-amber-700",
  active: "bg-emerald-900/40 text-emerald-300 border-emerald-700",
  disabled: "bg-red-900/40 text-red-300 border-red-700",
};

const ACTION_LABELS: Record<string, string> = {
  access_requested: "Requested access",
  approved: "Approved",
  role_changed: "Role changed",
  disabled: "Disabled",
  re_enabled: "Re-enabled",
  pre_authorized: "Pre-authorized",
};

export default function UserAccessDashboard() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [counts, setCounts] = useState<SummaryCounts>({ pending: 0, active: 0, disabled: 0, admins: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [actionModal, setActionModal] = useState<{
    user: UserRecord;
    action: "approve" | "change_role" | "disable" | "re_enable";
  } | null>(null);
  const [selectedRole, setSelectedRole] = useState<UserRole>("sales_rep");
  const [mutating, setMutating] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [auditUser, setAuditUser] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<AccessEvent[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUsers(data.users);
      setCounts(data.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const fetchAudit = useCallback(async (email: string) => {
    setAuditLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`);
      if (res.ok) {
        const data = await res.json();
        setAuditEvents(data.events || []);
      }
    } catch {
      // Silently fail audit fetch
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const handleAction = async () => {
    if (!actionModal) return;
    setMutating(true);
    setFeedback(null);

    const { user, action } = actionModal;
    let body: Record<string, unknown>;

    switch (action) {
      case "approve":
        body = { action: "approve", role: selectedRole, expectedVersion: user.version };
        break;
      case "change_role":
        body = { action: "change_role", role: selectedRole, expectedVersion: user.version };
        break;
      case "disable":
        body = { action: "disable", expectedVersion: user.version };
        break;
      case "re_enable":
        body = { action: "re_enable", role: selectedRole, expectedVersion: user.version };
        break;
    }

    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(user.email)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ type: "error", message: data.error || `Failed (${res.status})` });
        return;
      }

      setFeedback({
        type: "success",
        message: `${user.email} ${action === "approve" ? "approved" : action === "change_role" ? "role changed" : action === "disable" ? "disabled" : "re-enabled"} successfully.`,
      });
      setActionModal(null);
      await fetchUsers();
    } catch {
      setFeedback({ type: "error", message: "Network error." });
    } finally {
      setMutating(false);
    }
  };

  const filteredUsers = users.filter((u) => {
    if (statusFilter !== "all" && u.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        u.email.includes(q) ||
        (u.name && u.name.toLowerCase().includes(q))
      );
    }
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20" role="status">
        <span className="text-neutral-400 text-sm">Loading users...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-red-900/30 border border-red-700 px-4 py-4 text-sm text-red-300" role="alert">
        <p className="font-medium">Failed to load users</p>
        <p className="mt-1">{error}</p>
        <button
          onClick={fetchUsers}
          className="mt-3 text-xs underline hover:text-white"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="summary-cards">
        <SummaryCard label="Pending" count={counts.pending} color="text-amber-400" />
        <SummaryCard label="Active" count={counts.active} color="text-emerald-400" />
        <SummaryCard label="Disabled" count={counts.disabled} color="text-red-400" />
        <SummaryCard label="Admins" count={counts.admins} color="text-cyan-400" />
      </div>

      {/* Feedback */}
      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-md border px-4 py-3 text-sm ${
            feedback.type === "success"
              ? "bg-emerald-900/30 border-emerald-700 text-emerald-300"
              : "bg-red-900/30 border-red-700 text-red-300"
          }`}
        >
          {feedback.message}
          <button
            onClick={() => setFeedback(null)}
            className="ml-3 text-xs underline opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Search and filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          type="search"
          placeholder="Search by email or name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-cyan-600 focus:outline-none focus:ring-1 focus:ring-cyan-600"
          aria-label="Search users"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-white focus:border-cyan-600 focus:outline-none min-w-[120px]"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      {/* User list - responsive */}
      {filteredUsers.length === 0 ? (
        <p className="text-neutral-500 text-sm text-center py-8">
          No users found.
        </p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm" data-testid="users-table">
              <thead>
                <tr className="border-b border-neutral-700 text-left text-neutral-400 text-xs uppercase tracking-wider">
                  <th className="pb-2 pr-4">Email</th>
                  <th className="pb-2 pr-4">Name</th>
                  <th className="pb-2 pr-4">Role</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {filteredUsers.map((user) => (
                  <tr key={user.email} className="group" data-testid={`user-row-${user.email}`}>
                    <td className="py-3 pr-4 text-white">
                      <div className="flex items-center gap-2">
                        {user.email}
                        {user.isBootstrapAdmin && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-400 border border-cyan-800" title="Environment-configured bootstrap admin">
                            Bootstrap
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-neutral-400">{user.name || "—"}</td>
                    <td className="py-3 pr-4 text-neutral-300">
                      {user.role ? ROLE_LABELS[user.role] : "—"}
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`inline-block text-xs px-2 py-0.5 rounded border ${STATUS_COLORS[user.status]}`}>
                        {STATUS_LABELS[user.status]}
                      </span>
                    </td>
                    <td className="py-3">
                      <UserActions
                        user={user}
                        onAction={(action) => {
                          setSelectedRole(user.role || "sales_rep");
                          setActionModal({ user, action });
                        }}
                        onAudit={() => {
                          setAuditUser(user.email);
                          fetchAudit(user.email);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3" data-testid="users-cards">
            {filteredUsers.map((user) => (
              <div
                key={user.email}
                className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-4 space-y-3"
                data-testid={`user-card-${user.email}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{user.email}</p>
                    {user.name && (
                      <p className="text-neutral-400 text-xs mt-0.5">{user.name}</p>
                    )}
                  </div>
                  <span className={`shrink-0 text-xs px-2 py-0.5 rounded border ${STATUS_COLORS[user.status]}`}>
                    {STATUS_LABELS[user.status]}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-neutral-400 text-xs">
                      {user.role ? ROLE_LABELS[user.role] : "No role"}
                    </span>
                    {user.isBootstrapAdmin && (
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-400 border border-cyan-800">
                        Bootstrap
                      </span>
                    )}
                  </div>
                  <UserActions
                    user={user}
                    onAction={(action) => {
                      setSelectedRole(user.role || "sales_rep");
                      setActionModal({ user, action });
                    }}
                    onAudit={() => {
                      setAuditUser(user.email);
                      fetchAudit(user.email);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Audit history panel */}
      {auditUser && (
        <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-white">
              Audit History: {auditUser}
            </h3>
            <button
              onClick={() => setAuditUser(null)}
              className="text-xs text-neutral-400 hover:text-white"
              aria-label="Close audit history"
            >
              Close
            </button>
          </div>
          {auditLoading ? (
            <p className="text-neutral-500 text-xs">Loading...</p>
          ) : auditEvents.length === 0 ? (
            <p className="text-neutral-500 text-xs">No events found.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {auditEvents.map((evt) => (
                <div key={evt.id} className="text-xs text-neutral-400 flex items-start gap-2">
                  <span className="shrink-0 text-neutral-500 tabular-nums">
                    {new Date(evt.createdAt).toLocaleString()}
                  </span>
                  <span>
                    <span className="text-neutral-300">{ACTION_LABELS[evt.action] || evt.action}</span>
                    {evt.afterRole && (
                      <span> as <span className="text-white">{ROLE_LABELS[evt.afterRole as UserRole] || evt.afterRole}</span></span>
                    )}
                    <span> by {evt.actorEmail}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {actionModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm ${actionModal.action} for ${actionModal.user.email}`}
        >
          <div className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-800 p-6 shadow-xl space-y-4">
            <h3 className="text-white font-medium">
              {actionModal.action === "approve" && "Approve User"}
              {actionModal.action === "change_role" && "Change Role"}
              {actionModal.action === "disable" && "Disable User"}
              {actionModal.action === "re_enable" && "Re-enable User"}
            </h3>
            <p className="text-sm text-neutral-400">
              {actionModal.user.email}
            </p>

            {actionModal.action !== "disable" && (
              <div>
                <label className="block text-xs text-neutral-400 mb-1">
                  Role
                </label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value as UserRole)}
                  className="w-full rounded-md border border-neutral-600 bg-neutral-700 px-3 py-2 text-sm text-white focus:border-cyan-600 focus:outline-none"
                  aria-label="Select role"
                >
                  <option value="sales_rep">Sales Rep</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            )}

            {actionModal.action === "disable" && (
              <p className="text-sm text-amber-300">
                This will immediately revoke the user&apos;s access. They will not be able to sign in.
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setActionModal(null)}
                disabled={mutating}
                className="px-4 py-2 text-sm text-neutral-400 hover:text-white transition-colors min-h-[44px]"
              >
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={mutating}
                className={`px-4 py-2 text-sm font-medium rounded-md min-h-[44px] transition-colors ${
                  actionModal.action === "disable"
                    ? "bg-red-700 hover:bg-red-600 text-white"
                    : "bg-cyan-700 hover:bg-cyan-600 text-white"
                } disabled:opacity-50`}
                data-testid="confirm-action-btn"
              >
                {mutating ? "Processing..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="rounded-lg border border-neutral-700 bg-neutral-800/50 px-4 py-3" data-testid={`summary-${label.toLowerCase()}`}>
      <p className="text-xs text-neutral-400 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold tabular-nums mt-1 ${color}`}>{count}</p>
    </div>
  );
}

function UserActions({
  user,
  onAction,
  onAudit,
}: {
  user: UserRecord;
  onAction: (action: "approve" | "change_role" | "disable" | "re_enable") => void;
  onAudit: () => void;
}) {
  if (user.isBootstrapAdmin) {
    return (
      <span className="text-xs text-neutral-500 italic" title="Environment-configured; cannot be modified">
        Locked
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {user.status === "pending" && (
        <ActionButton label="Approve" onClick={() => onAction("approve")} variant="success" />
      )}
      {user.status === "active" && !user.isBootstrapAdmin && (
        <>
          <ActionButton label="Change Role" onClick={() => onAction("change_role")} variant="neutral" />
          <ActionButton label="Disable" onClick={() => onAction("disable")} variant="danger" />
        </>
      )}
      {user.status === "disabled" && (
        <ActionButton label="Re-enable" onClick={() => onAction("re_enable")} variant="success" />
      )}
      <button
        onClick={onAudit}
        className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors px-2 py-1 min-h-[44px] min-w-[44px] flex items-center justify-center"
        aria-label={`View audit history for ${user.email}`}
        title="View audit history"
      >
        History
      </button>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  variant,
}: {
  label: string;
  onClick: () => void;
  variant: "success" | "danger" | "neutral";
}) {
  const colors = {
    success: "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/30",
    danger: "text-red-400 hover:text-red-300 hover:bg-red-900/30",
    neutral: "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50",
  };

  return (
    <button
      onClick={onClick}
      className={`text-xs px-2 py-1 rounded transition-colors min-h-[44px] ${colors[variant]}`}
    >
      {label}
    </button>
  );
}

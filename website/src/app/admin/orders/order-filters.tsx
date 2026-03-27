"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useCallback } from "react";

const STATUSES = ["all", "pending", "paid", "processing", "shipped", "delivered", "refunded", "cancelled"];

export function OrderFilters({
  currentStatus,
  currentSearch,
}: {
  currentStatus?: string;
  currentSearch?: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(currentSearch || "");

  const applyFilters = useCallback(
    (status?: string, searchVal?: string) => {
      const params = new URLSearchParams();
      if (status && status !== "all") params.set("status", status);
      if (searchVal) params.set("search", searchVal);
      router.push(`/admin/orders?${params.toString()}`);
    },
    [router]
  );

  return (
    <div className="flex gap-3 items-center">
      <select
        value={currentStatus || "all"}
        onChange={(e) => applyFilters(e.target.value, search)}
        className="rounded border border-gray-300 px-3 py-1.5 text-sm bg-white"
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
          </option>
        ))}
      </select>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters(currentStatus, search);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, email, order #..."
          className="rounded border border-gray-300 px-3 py-1.5 text-sm w-64"
        />
        <button
          type="submit"
          className="bg-gray-800 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-700"
        >
          Search
        </button>
        {(currentStatus || currentSearch) && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              router.push("/admin/orders");
            }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Clear
          </button>
        )}
      </form>
    </div>
  );
}

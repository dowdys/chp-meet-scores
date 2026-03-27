"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const router = useRouter();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/admin/orders?search=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <form onSubmit={handleSearch} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search orders, customers..."
        className="w-full bg-gray-800 text-white text-sm rounded px-3 py-1.5 placeholder-gray-500 border border-gray-700 focus:border-gray-500 focus:outline-none"
      />
    </form>
  );
}

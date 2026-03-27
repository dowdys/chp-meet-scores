"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createPrinterBatch } from "@/lib/admin-actions";

export function BatchCreator({ backIds }: { backIds: number[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleCreate = async () => {
    if (selected.size === 0) return;
    setLoading(true);
    await createPrinterBatch(Array.from(selected));
    setSelected(new Set());
    setLoading(false);
    router.refresh();
  };

  return (
    <div className="mb-4">
      <div className="flex gap-2 flex-wrap mb-3">
        {backIds.map((id) => (
          <button
            key={id}
            onClick={() => toggle(id)}
            className={`px-2 py-1 rounded text-xs ${
              selected.has(id)
                ? "bg-blue-500 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Back #{id}
          </button>
        ))}
      </div>
      {selected.size > 0 && (
        <button
          onClick={handleCreate}
          disabled={loading || selected.size > 10}
          className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {loading
            ? "Creating..."
            : `Create Batch (${selected.size} back${selected.size > 1 ? "s" : ""})`}
        </button>
      )}
      {selected.size > 10 && (
        <p className="text-red-500 text-xs mt-1">Max 10 backs per batch</p>
      )}
    </div>
  );
}

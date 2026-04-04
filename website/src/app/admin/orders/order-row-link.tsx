"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export function OrderRowLink({
  orderNumber,
  children,
}: {
  orderNumber: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleClick = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("order", orderNumber);
    router.push(`/admin/orders?${params.toString()}`);
  }, [router, searchParams, orderNumber]);

  return (
    <tr
      onClick={handleClick}
      className="border-b hover:bg-gray-50 cursor-pointer"
    >
      {children}
    </tr>
  );
}

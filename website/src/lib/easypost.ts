import "server-only";

import EasyPostClient from "@easypost/api";

export const easypost = new EasyPostClient(process.env.EASYPOST_API_KEY!);

// Default parcel dimensions for a t-shirt package
export const SHIRT_PARCEL = {
  length: 12,
  width: 10,
  height: 2,
  weight: 8, // ounces (~0.5 lb per shirt)
};

// From address (CHP warehouse) — configure via env or admin settings
export const FROM_ADDRESS = {
  company: "C.H. Publishing",
  street1: "", // TODO: Set from config
  city: "",
  state: "",
  zip: "",
  country: "US",
  phone: "",
};

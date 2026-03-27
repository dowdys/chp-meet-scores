import { z } from "zod";

export const cartItemSchema = z.object({
  athleteName: z.string().min(1).max(100),
  correctedName: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z\u00C0-\u024F\s\-'.]+$/, "Invalid characters in name")
    .optional()
    .nullable(),
  meetName: z.string().min(1).max(300),
  state: z.string().max(50).optional().default(""),
  level: z.string().max(50).optional().default(""),
  gym: z.string().max(200).optional().default(""),
  shirtSize: z.enum(["YS", "YM", "YL", "S", "M", "L", "XL", "XXL"]),
  shirtColor: z.enum(["white", "grey"]),
  hasJewel: z.boolean(),
});

export const checkoutSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(20),
});

export const emailCaptureSchema = z.object({
  email: z.string().email().max(254),
  phone: z.string().max(20).optional().nullable(),
  athlete_name: z.string().min(1).max(100),
  state: z.string().max(50).optional().nullable(),
  association: z.string().max(10).optional().nullable(),
  gym: z.string().max(200).optional().nullable(),
  level: z.string().max(50).optional().nullable(),
  source: z.enum(["website", "qr_code", "social", "ad", "referral"]).optional().default("website"),
});

export const orderLookupSchema = z.object({
  order_number: z.string().min(1).max(30),
  email: z.string().email().max(254),
});

export const shippingSchema = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const emailBlastSchema = z.object({
  state: z.string().min(1).max(50),
});

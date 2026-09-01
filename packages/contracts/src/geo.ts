import { z } from "zod";

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const GeoLocation = z.object({
  label: z.string().optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().default("US"),
  point: GeoPoint.optional(),
});
export type GeoLocation = z.infer<typeof GeoLocation>;

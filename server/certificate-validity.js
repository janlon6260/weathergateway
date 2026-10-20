import { z } from 'zod';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Rejected } from './store.js';

export const validitySchema = z
  .object({
    amount: z.number().int().positive(),
    unit: z.enum(['days', 'years']),
  })
  .strict()
  .refine((v) => v.amount <= (v.unit === 'years' ? 50 : 18262), 'Maksimal gyldighet er 50 år');

export function validityDays(input = { amount: 90, unit: 'days' }, now = Date.now()) {
  const value = validitySchema.parse(input);
  if (value.unit === 'days') return value.amount;
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + value.amount);
  return Math.floor((end.getTime() - now) / 86400000);
}

// A leaf must never outlive its issuer. Dates in certificates have second precision.
export function issuedDays(caFile, input, now = Date.now()) {
  let ca;
  try {
    ca = new X509Certificate(readFileSync(caFile));
  } catch {
    throw new Rejected('CA mangler eller er ugyldig. Initialiser sertifikater i adminpanelet først.', 503);
  }
  if (!ca.ca || Date.parse(ca.validFrom) > now || Date.parse(ca.validTo) <= now)
    throw new Rejected('CA er ugyldig eller utløpt. Forny CA først.');
  const days = Math.min(
    validityDays(input, now),
    Math.floor((Date.parse(ca.validTo) - now - 5000) / 86400000),
  );
  if (days < 1) throw new Rejected('CA har mindre enn ett døgn igjen. Forny CA først.');
  return days;
}

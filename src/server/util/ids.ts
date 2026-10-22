import { randomBytes } from "node:crypto";

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
export const now = () => new Date().toISOString();
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

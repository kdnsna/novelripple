import { z } from "zod";

export const StateFactIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "ID 必须能够组成稳定的 Worldline fact key");

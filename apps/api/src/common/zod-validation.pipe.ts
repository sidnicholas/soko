import { BadRequestException, Body, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Validates a request payload against a zod schema and returns the parsed,
 * typed value. Used as a per-handler param pipe via {@link ZodBody} so every
 * write endpoint validates its body against the shared @opportunity-os/contracts
 * schemas instead of trusting untyped input (§16).
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Request body failed validation",
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}

/** Binds `@Body()` to a zod schema pipe — the app-wide request-validation seam. */
export function ZodBody<T>(schema: ZodSchema<T>): ParameterDecorator {
  return Body(new ZodValidationPipe(schema));
}

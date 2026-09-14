import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { stripeRejection } from "./stripe-client";

function stripeError(type: string, statusCode: number, message = "boom"): Error {
  const raw = { type, message, statusCode } as any;
  switch (type) {
    case "invalid_request_error": return new Stripe.errors.StripeInvalidRequestError(raw);
    case "api_error": return new Stripe.errors.StripeAPIError(raw);
    case "rate_limit_error": return new Stripe.errors.StripeRateLimitError(raw);
    default: return new Error(message);
  }
}

describe("stripeRejection", () => {
  it("surfaces deterministic Stripe 4xx rejections with Stripe's message", () => {
    const err = stripeError("invalid_request_error", 400, "The `business_type` must be provided.");
    expect(stripeRejection(err)).toEqual({ status: 502, message: "Stripe rejected the request: The `business_type` must be provided." });
  });
  it("leaves transient failures (5xx, rate limits, non-Stripe errors) to the generic 503 path", () => {
    expect(stripeRejection(stripeError("api_error", 500))).toBeNull();
    expect(stripeRejection(stripeError("rate_limit_error", 429))).toBeNull();
    expect(stripeRejection(new Error("socket hang up"))).toBeNull();
    expect(stripeRejection(null)).toBeNull();
  });
});

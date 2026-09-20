import { it as baseIt } from "vitest";
import { runWithBillingIdentity } from "../stripe-environment";

/** Real request context around each test, not a production scoping bypass. */
function contextual<T extends Function>(register: T): T {
  return new Proxy(register, {
    apply(target, receiver, args: unknown[]) {
      const index = args.findIndex((arg, position) => position > 0 && typeof arg === "function");
      if (index >= 0) {
        const body = args[index] as (...values: unknown[]) => unknown;
        args[index] = (...values: unknown[]) => runWithBillingIdentity(
          { mode: "test", platformAccountId: "acct_platform" }, () => body(...values),
        );
      }
      return Reflect.apply(target, receiver, args);
    },
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if ((key === "each" || key === "for") && typeof value === "function") {
        return (...args: unknown[]) => contextual(Reflect.apply(value, target, args) as Function);
      }
      return typeof value === "function" ? contextual(value) : value;
    },
  });
}
export const it = contextual(baseIt);
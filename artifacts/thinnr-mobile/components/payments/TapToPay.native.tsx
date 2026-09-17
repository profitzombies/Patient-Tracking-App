import React, { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { officeBilling } from "@/lib/office-billing-api";
import {
  describeTerminalError,
  type TapConnectParams,
  type TapResult,
  type TapToPayClient,
} from "@/lib/tap-to-pay-bridge";
import type { TapToPayProps } from "./TapToPay";

type TerminalModule = typeof import("@stripe/stripe-terminal-react-native");

/**
 * Native Tap to Pay: loads the Stripe Terminal module on demand (Expo Go and
 * builds without it fall back cleanly), mounts the SDK provider with a token
 * provider that mints connection tokens for this office's connected account,
 * and hands the screen a client wrapping the SDK calls.
 */
export default function TapToPay(props: TapToPayProps) {
  const [sdk, setSdk] = useState<TerminalModule | null>(null);
  const { onUnavailable, userId } = props;
  useEffect(() => {
    let current = true;
    import("@stripe/stripe-terminal-react-native")
      .then((module) => {
        if (current) setSdk(module);
      })
      .catch(() => {
        if (current)
          onUnavailable({
            kind: "unsupported",
            code: "TAP_TO_PAY_LIBRARY_NOT_INCLUDED",
            message:
              "This build of THINNR does not include Tap to Pay. Use the card form or QR code.",
          });
      });
    return () => {
      current = false;
    };
  }, [onUnavailable]);
  if (!sdk) return null;
  const Provider = sdk.StripeTerminalProvider;
  return (
    <Provider
      logLevel="none"
      tokenProvider={async () =>
        (await officeBilling.terminalConnectionToken({ userId })).secret
      }
    >
      <TerminalClient sdk={sdk} {...props} />
    </Provider>
  );
}

function TerminalClient({
  sdk,
  onReady,
  onUnavailable,
}: TapToPayProps & { sdk: TerminalModule }) {
  const terminal = sdk.useStripeTerminal();
  // The hook returns fresh function identities every render; the client the
  // screen holds must always call the latest ones.
  const latest = useRef(terminal);
  latest.current = terminal;
  useEffect(() => {
    let current = true;
    const client: TapToPayClient = {
      async connect(params: TapConnectParams): Promise<TapResult> {
        const api = latest.current;
        if (api.connectedReader) return { ok: true };
        const result = await api.easyConnect({
          discoveryMethod: "tapToPay",
          simulated: params.simulated,
          locationId: params.locationId,
          autoReconnectOnUnexpectedDisconnect: true,
        });
        return result.error
          ? { ok: false, failure: describeTerminalError(result.error) }
          : { ok: true };
      },
      async collect(clientSecret: string): Promise<TapResult> {
        const api = latest.current;
        const retrieved = await api.retrievePaymentIntent(clientSecret);
        if (retrieved.error)
          return { ok: false, failure: describeTerminalError(retrieved.error) };
        const collected = await api.collectPaymentMethod({
          paymentIntent: retrieved.paymentIntent,
          // Lets a tapped physical card be kept as a subscription's renewal card.
          allowRedisplay: "always",
        });
        if (collected.error)
          return { ok: false, failure: describeTerminalError(collected.error) };
        const confirmed = await api.confirmPaymentIntent({
          paymentIntent: collected.paymentIntent,
        });
        return confirmed.error
          ? { ok: false, failure: describeTerminalError(confirmed.error) }
          : { ok: true };
      },
      async cancelCollect() {
        await latest.current.cancelCollectPaymentMethod().catch(() => undefined);
      },
      async disconnect() {
        await latest.current.disconnectReader().catch(() => undefined);
      },
    };
    (async () => {
      if (Platform.OS === "android") {
        const granted = await sdk.requestNeededAndroidPermissions({
          accessFineLocation: {
            title: "Location for Tap to Pay",
            message:
              "Stripe requires your location while taking an in-person card payment.",
            buttonPositive: "Allow",
          },
        });
        if (granted.error) {
          if (current)
            onUnavailable(
              describeTerminalError({ code: "LOCATION_SERVICES_DISABLED" }),
            );
          return;
        }
      }
      const result = await latest.current.initialize();
      if (!current) return;
      if (result.error) onUnavailable(describeTerminalError(result.error));
      else onReady(client);
    })().catch((caught: unknown) => {
      if (current)
        onUnavailable(
          describeTerminalError(
            caught instanceof Error ? { message: caught.message } : null,
          ),
        );
    });
    return () => {
      current = false;
      void latest.current.disconnectReader().catch(() => undefined);
    };
  }, [onReady, onUnavailable, sdk]);
  return null;
}

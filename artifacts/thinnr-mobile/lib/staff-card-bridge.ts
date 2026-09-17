export type HandleNextAction = (clientSecret: string) => Promise<string | null>;

export interface StaffCardBridge {
  createPaymentMethod?: () => Promise<string>;
  handleNextAction?: HandleNextAction;
}

let testBridge: StaffCardBridge | null = null;

/** Test seam used by the payments verification suite; production never sets it. */
export function setStaffCardBridgeForTests(
  bridge: StaffCardBridge | null,
): void {
  testBridge = bridge;
}

export function getStaffCardBridgeForTests(): StaffCardBridge | null {
  return testBridge;
}

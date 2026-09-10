export type PatientAccountState = {
  resolving: boolean;
  account: { kind: "demo" | "unresolved" } | { kind: "real"; patientId: string };
  getAccessToken?: () => Promise<string | null>;
};

export let patientAccount: PatientAccountState = {
  resolving: false,
  account: { kind: "real", patientId: "patient-a" },
  getAccessToken: async () => "token-a",
};
export const usePatientAccount = () => patientAccount;
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_SUPABASE_REF, developmentSettingsInDeployment } from "./deployment-environment";

const PRODUCTION = {
  REPLIT_DEPLOYMENT: "1",
  SUPABASE_URL: "https://prodref.supabase.co",
  VITE_SUPABASE_URL: "https://prodref.supabase.co",
  EXPO_PUBLIC_SUPABASE_URL: "https://prodref.supabase.co",
  PRIVATE_OBJECT_DIR: "/replit-objstore-private/.private",
  TRAINING_OBJECT_DIR: "/replit-objstore-training/.private",
  BILLING_DEPLOYMENT_ID: "thinnr-production",
} as NodeJS.ProcessEnv;

const DEVELOPMENT_URL = `https://${DEVELOPMENT_SUPABASE_REF}.supabase.co`;

describe("published-app development guard", () => {
  it("passes production settings", () => {
    expect(developmentSettingsInDeployment(PRODUCTION)).toEqual([]);
  });

  it("names every development value that reached a deployment", () => {
    expect(developmentSettingsInDeployment({
      ...PRODUCTION,
      SUPABASE_URL: DEVELOPMENT_URL,
      VITE_SUPABASE_URL: DEVELOPMENT_URL,
      PRIVATE_OBJECT_DIR: "/replit-objstore-private/dev",
      TRAINING_OBJECT_DIR: "/replit-objstore-training/dev/videos",
      BILLING_DEPLOYMENT_ID: " thinnr-development ",
    })).toEqual(["SUPABASE_URL", "VITE_SUPABASE_URL", "PRIVATE_OBJECT_DIR", "TRAINING_OBJECT_DIR", "BILLING_DEPLOYMENT_ID"]);
  });

  it("does not mistake production folders that merely contain dev for the development prefix", () => {
    expect(developmentSettingsInDeployment({ ...PRODUCTION, PRIVATE_OBJECT_DIR: "/replit-objstore-private/.private/dev" })).toEqual([]);
  });

  it("stays out of the workspace, which runs on development by design", () => {
    expect(developmentSettingsInDeployment({ ...PRODUCTION, REPLIT_DEPLOYMENT: undefined, SUPABASE_URL: DEVELOPMENT_URL })).toEqual([]);
  });
});

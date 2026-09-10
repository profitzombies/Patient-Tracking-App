import React from "react";
export const ErrorBox = ({ message, testID }: { message: string; testID?: string }) =>
  React.createElement("ErrorBox", { message, testID, accessibilityRole: "alert" });
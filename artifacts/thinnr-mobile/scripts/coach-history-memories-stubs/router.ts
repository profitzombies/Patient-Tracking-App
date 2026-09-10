import React from "react";

export const routerCalls: string[] = [];
export const useRouter = () => ({
  push: (path: string) => routerCalls.push(`push:${path}`),
  back: () => routerCalls.push("back"),
  replace: (path: string) => routerCalls.push(`replace:${path}`),
  canGoBack: () => true,
});
export function useFocusEffect(callback: () => void | (() => void)) {
  React.useEffect(() => callback(), [callback]);
}
export const Link = ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children);
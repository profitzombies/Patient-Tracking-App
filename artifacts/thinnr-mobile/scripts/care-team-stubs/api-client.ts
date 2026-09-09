export interface ApiCall {
  name: string;
  args: unknown[];
}

export const apiCalls: ApiCall[] = [];
export const apiScripts: Record<string, Array<unknown | Error | Promise<unknown>>> = {};

export function resetApi(): void {
  apiCalls.length = 0;
  for (const key of Object.keys(apiScripts)) delete apiScripts[key];
}

async function run(name: string, args: unknown[]): Promise<unknown> {
  apiCalls.push({ name, args });
  const value = apiScripts[name]?.shift();
  if (value instanceof Error) throw value;
  return await value;
}

export const getPatientCareTeam = (...args: unknown[]) => run('status', args);
export const startPatientCareTeam = (...args: unknown[]) => run('start', args);
export const getPatientCareTeamMessages = (...args: unknown[]) => run('messages', args);
export const sendPatientCareTeamMessage = (...args: unknown[]) => run('send', args);
export const readPatientCareTeam = (...args: unknown[]) => run('read', args);
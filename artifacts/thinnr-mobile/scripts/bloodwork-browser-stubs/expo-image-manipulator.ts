export const SaveFormat = { JPEG: 'jpeg' };
let result = { uri: '', width: 1, height: 1 };
export function setManipulatedResult(next: typeof result): void {
  result = next;
}
export async function manipulateAsync() {
  return result;
}
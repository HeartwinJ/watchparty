import { apiFetch } from "./api";

export async function generateName(): Promise<string> {
  const response = await apiFetch("/generateName");
  return response.text();
}

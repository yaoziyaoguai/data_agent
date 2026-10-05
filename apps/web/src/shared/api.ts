import { decodeContract } from "../../../../packages/contracts/validate.ts";
import type { ContractTypes } from "../../../../packages/contracts/generated/names.ts";
export async function api<N extends keyof ContractTypes>(
  schema: N,
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
): Promise<ContractTypes[N]> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      decodeContract<ContractTypes["AppError"]>("AppError", value).code,
    );
  return decodeContract<ContractTypes[N]>(schema, value);
}

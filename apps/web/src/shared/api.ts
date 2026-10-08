import { decodeContract } from "../../../../packages/contracts/validate.ts";
import type { ContractTypes } from "../../../../packages/contracts/generated/names.ts";
export class ApiError extends Error {
  readonly code: string;
  readonly serverMessage: string;
  readonly requestId: string;
  readonly retryable: boolean;
  constructor(value: ContractTypes["AppError"]) {
    super(value.code); // 现有机器码分支保持兼容，面向用户的说明由具体操作提供。
    this.name = "ApiError";
    this.code = value.code;
    this.serverMessage = value.message;
    this.requestId = value.request_id;
    this.retryable = value.retryable;
  }
}
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
    throw new ApiError(decodeContract<ContractTypes["AppError"]>("AppError", value));
  return decodeContract<ContractTypes[N]>(schema, value);
}

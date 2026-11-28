import { validateContract, decodeContract } from '../../../packages/contracts/validate.ts';
import type { RunEnvelope, AppError } from '../../../packages/contracts/generated/boundary.ts';
import type { ContractTypes } from '../../../packages/contracts/generated/names.ts';
import { createHash } from 'node:crypto';
import { Agent } from 'undici';

const hostDispatcher = new Agent({ headersTimeout: 750_000, bodyTimeout: 750_000 });

const responses = {
  '/internal/tool-calls':'OperationReceipt', '/internal/data/tool-calls':'OperationReceipt','/internal/data/tools':'DataToolOutcome', '/internal/tools':'ToolOutcome',
  '/internal/data/tool-rejections':'DataToolOutcome',
  '/internal/outputs':'OutputReceipt','/internal/finish':'FinishReceipt',
  '/internal/model/connection':'ModelConnection','/internal/model/reserve':'ModelCallReceipt','/internal/model/send':'ModelCallReceipt','/internal/model/finalize':'ModelCallReceipt',
  '/internal/model/issue':'ModelReceipt','/internal/model/settle':'ModelReceipt',
  '/internal/checkpoints/read':'Checkpoint',
  '/internal/context/refresh':'WorkspaceContext',
} as const satisfies Record<string, keyof ContractTypes>;

// 私有符号只携受控HTTP元信息，保留原异常类型/原消息供已有工具和取消语义使用。
interface RustRequestFailure {
  path: keyof typeof responses;
  status: number | null;
  elapsedMs: number;
  reason: AppError['code'] | 'timeout' | 'network' | 'invalid_response' | 'other';
}
const requestFailure = Symbol('rust_request_failure');
export function rustRequestFailure(error: unknown): RustRequestFailure | undefined {
  return error instanceof Error ? (error as Error & {[requestFailure]?: RustRequestFailure})[requestFailure] : undefined;
}

export class RustTransport {
  readonly run:RunEnvelope;
  private readonly apiUrl:string;
  private readonly token:string;
  constructor(run:RunEnvelope,apiUrl:string,token:string) {this.run=run;this.apiUrl=apiUrl;this.token=token;}
  async post<Path extends keyof typeof responses>(path: Path, name: string, input: unknown, expectedFingerprint?:string): Promise<ContractTypes[(typeof responses)[Path]]> {
    validateContract(name, input);
    const started = Date.now();
    let status: number | null = null;
    let reason: RustRequestFailure['reason'] = 'other';
    try {
      const response = await fetch(this.apiUrl + path, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token },
        body: JSON.stringify(input), signal: AbortSignal.timeout(path === "/internal/data/tools" ? 735000 : 10000),
        dispatcher: hostDispatcher,
      } as RequestInit & { dispatcher: Agent });
      status = response.status;
      reason = 'invalid_response';
      if (!response.ok) {
        const error = decodeContract<AppError>('AppError',await response.json());
        reason = error.code;
        throw new Error(error.code);
      }
      const text=await response.text();
      if(expectedFingerprint&&createHash('sha256').update(text).digest('hex')!==expectedFingerprint){reason='checkpoint_conflict';throw new Error('checkpoint_conflict');}
      const value:unknown = JSON.parse(text);
      return decodeContract<ContractTypes[(typeof responses)[Path]]>(responses[path], value);
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') reason = 'timeout';
      else if (error instanceof TypeError) reason = 'network';
      if (error instanceof Error) Object.defineProperty(error, requestFailure, {
        value: {path, status, elapsedMs: Date.now() - started, reason},
      });
      throw error;
    }
  }
  binding() { return { run_id: this.run.run_id, lease_epoch: this.run.lease_epoch }; }
}

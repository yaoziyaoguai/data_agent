import { validateContract } from '../../../packages/contracts/validate.ts';
import type { RunEnvelope } from '../../../packages/contracts/generated/boundary.ts';
import { decodeContract } from '../../../packages/contracts/validate.ts';
import type { AppError } from '../../../packages/contracts/generated/boundary.ts';
import { createHash } from 'node:crypto';

const responses:Record<string,string> = {
  '/internal/tool-calls':'OperationReceipt', '/internal/data/tool-calls':'OperationReceipt','/internal/data/tools':'DataToolOutcome', '/internal/tools':'ToolOutcome',
  '/internal/data/tool-rejections':'DataToolOutcome',
  '/internal/outputs':'OutputReceipt','/internal/finish':'FinishReceipt',
  '/internal/model/reserve':'ModelCallReceipt','/internal/model/send':'ModelCallReceipt','/internal/model/finalize':'ModelCallReceipt',
  '/internal/model/issue':'ModelReceipt','/internal/model/settle':'ModelReceipt',
  '/internal/checkpoints/read':'Checkpoint',
};

export class RustTransport {
  readonly run:RunEnvelope;
  private readonly apiUrl:string;
  private readonly token:string;
  constructor(run:RunEnvelope,apiUrl:string,token:string) {this.run=run;this.apiUrl=apiUrl;this.token=token;}
  async post(path: string, name: string, input: unknown, expectedFingerprint?:string): Promise<unknown> {
    validateContract(name, input);
    const response = await fetch(this.apiUrl + path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token },
      body: JSON.stringify(input), signal: AbortSignal.timeout(path === "/internal/data/tools" ? 735000 : 10000),
    });
    if (!response.ok) {
      const error = decodeContract<AppError>('AppError',await response.json());
      throw new Error(error.code);
    }
    const text=await response.text();
    if(expectedFingerprint&&createHash('sha256').update(text).digest('hex')!==expectedFingerprint)throw new Error('checkpoint_conflict');
    const value:unknown = JSON.parse(text);
    validateContract(responses[path],value);
    return value;
  }
  binding() { return { run_id: this.run.run_id, lease_epoch: this.run.lease_epoch }; }
}
